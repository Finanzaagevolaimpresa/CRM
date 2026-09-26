import { Prisma, type PrismaClient } from '@prisma/client';
import { canViewLead } from './access-control';
import { lockAuthoritativeInternalSession } from './internal-session-registry';
import { hasPermission } from './permission-evaluator';
import { coreQueryFetchSize, coreQueryOffset, parseCoreQueryPage, toCoreQueryPage } from './core-query-policy';
import { acquisitionState, verifiedAcquisitionEvent } from './lead-acquisition-contract';

type Actor = { userId: string; sessionId?: string };
export class LeadAcquisitionDenied extends Error {
  constructor() { super('LEAD_ACQUISITION_DENIED'); }
}

async function authority(tx: Prisma.TransactionClient, actor: Actor, adminOnly: boolean) {
  const fresh = actor.sessionId ? await lockAuthoritativeInternalSession(tx, {
    userId: actor.userId, sessionId: actor.sessionId,
  }) : null;
  if (!fresh || !fresh.active || fresh.deletedAt || fresh.revokedAt || !fresh.live
    || !hasPermission(fresh, 'lead.read') || (adminOnly && fresh.role !== 'admin')) throw new LeadAcquisitionDenied();
  return fresh;
}

export async function readLeadAcquisitions(db: PrismaClient, actor: Actor, input: { page?: string; leadId?: string; queue?: string }) {
  const page = parseCoreQueryPage(input.page);
  return db.$transaction(async (tx) => {
    const fresh = await authority(tx, actor, !input.leadId);
    if (input.leadId) {
      const rows = await tx.$queryRaw<Array<{ assignedToId: string | null }>>(Prisma.sql`
        SELECT "assignedToId" FROM "Lead" WHERE id=${input.leadId} AND "deletedAt" IS NULL FOR SHARE`);
      if (!rows[0] || !canViewLead(fresh, rows[0])) throw new LeadAcquisitionDenied();
    }
    const where: Prisma.BusinessInboxEventWhereInput = input.leadId
      ? { leadProjectionLedger: { is: { leadId: input.leadId } } } : {};
    if (input.queue === 'errors') where.OR = [
      { state: 'DEAD_LETTER' }, { state: { in: ['AVAILABLE', 'LEASED'] }, lastFailureCode: { not: null } },
    ];
    if (input.queue === 'ambiguous') where.leadProjectionLedger = { is: { state: 'REVIEW_REQUIRED', ...(input.leadId ? { leadId: input.leadId } : {}) } };
    if (input.queue === 'waiting') where.state = { in: ['AVAILABLE', 'LEASED'] };
    const rows = await tx.businessInboxEvent.findMany({
      where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: coreQueryOffset(page), take: coreQueryFetchSize(),
      select: { id: true, envelopeJson: true, recordHash: true, createdAt: true, state: true, attemptCount: true,
        maxAttempts: true, availableAt: true, lastFailureCode: true, terminalReasonCode: true,
        leadProjectionLedger: { select: { state: true, sourceRecordHash: true, leadId: true } },
        attempts: { orderBy: [{ attemptSequence: 'desc' }], take: 5,
          select: { attemptSequence: true, outcome: true, failureCode: true, nextAvailableAt: true, finishedAt: true } },
      },
    });
    return toCoreQueryPage(rows.map((row) => {
      const parsed = verifiedAcquisitionEvent(row);
      const projection = row.leadProjectionLedger;
      const verified = !!parsed && (!projection || projection.sourceRecordHash === row.recordHash);
      return { id: row.id, createdAt: row.createdAt, verified, event: verified ? parsed : null,
        state: verified ? acquisitionState(row.state, row.attemptCount, projection?.state ?? null) : 'ERROR' as const,
        leadId: verified ? projection?.leadId ?? null : null, attempts: row.attempts, attemptsTotal: row.attemptCount,
        maxAttempts: row.maxAttempts, availableAt: row.state === 'AVAILABLE' ? row.availableAt : null,
        failureCode: !verified ? 'INTEGRITY_RECONCILIATION_REQUIRED'
          : row.state === 'PROCESSED' ? null : row.lastFailureCode ?? row.terminalReasonCode };
    }), page);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 8_000, maxWait: 2_000 });
}

export async function readLeadAcquisitionSummary(db: PrismaClient, actor: Actor) {
  return db.$transaction(async (tx) => {
    await authority(tx, actor, true);
    return tx.$queryRaw<Array<{ source: string; form: string; requests: bigint; waiting: bigint; errors: bigint;
      ambiguous: bigint; unassigned: bigint; assigned: bigint; leads: bigint; paidLeads: bigint }>>(Prisma.sql`
      SELECT inbox."envelopeJson"::jsonb #>> '{source,systemCode}' AS source,
        inbox."envelopeJson"::jsonb #>> '{source,formCode}' AS form, COUNT(*) AS requests,
        COUNT(*) FILTER (WHERE inbox.state IN ('AVAILABLE','LEASED')) AS waiting,
        COUNT(*) FILTER (WHERE inbox.state='DEAD_LETTER' OR
          (inbox.state IN ('AVAILABLE','LEASED') AND inbox."lastFailureCode" IS NOT NULL)) AS errors,
        COUNT(*) FILTER (WHERE projection.state='REVIEW_REQUIRED') AS ambiguous,
        COUNT(DISTINCT lead.id) FILTER (WHERE lead.id IS NOT NULL AND lead."assignedToId" IS NULL) AS unassigned,
        COUNT(DISTINCT lead.id) FILTER (WHERE lead."assignedToId" IS NOT NULL) AS assigned,
        COUNT(DISTINCT lead.id) AS leads,
        COUNT(DISTINCT lead.id) FILTER (WHERE EXISTS (
          SELECT 1 FROM "Client" client JOIN "Payment" payment ON payment."clientId"=client.id
          WHERE client."deletedAt" IS NULL AND (client.id=lead."clientId" OR client."leadId"=lead.id)
            AND payment.status='incassato' AND payment."totalAmount">0 AND payment."collectedAt" IS NOT NULL
        )) AS "paidLeads"
      FROM "BusinessInboxEvent" inbox LEFT JOIN "LeadProjectionLedger" projection ON projection."inboxEventId"=inbox.id
      LEFT JOIN "Lead" lead ON lead.id=projection."leadId" AND lead."deletedAt" IS NULL
      GROUP BY 1,2 ORDER BY 1,2`);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 8_000, maxWait: 2_000 });
}
