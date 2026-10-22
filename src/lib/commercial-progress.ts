import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import type { AuthSession } from './auth';
import { commercialProgressProjection, type CommercialProgressContext } from './commercial-progress-policy';
import { lockCommunicationDirectory } from './communication-directory-lock';
import { lockAuthoritativeInternalSession } from './internal-session-registry';
import { hasPermission } from './permission-evaluator';
import { loadSelectiveProjectScope } from './selective-project-scope';
import { internalSessionMode } from './session';
import { withSerializableTransaction } from './serializable';

const querySchema = z.object({
  client: z.string().trim().min(1).max(128).optional(),
  q: z.string().trim().max(100).default(''),
  after: z.string().trim().min(1).max(128).optional(),
}).strict();
export class CommercialProgressUnavailable extends Error {
  constructor() { super('Avanzamento non disponibile. Riapri la pagina con una sessione valida.'); }
}
function deny(): never { throw new CommercialProgressUnavailable(); }
type Row = CommercialProgressContext['practice'] & {
  clientName: string; salesOwnerId: string | null;
  linkedProjectId: string | null; projectClientId: string | null; projectStatus: string | null; projectDeletedAt: Date | null;
  linkedServiceId: string | null; serviceClientId: string | null; serviceProjectId: string | null; serviceStatus: string | null; serviceDeletedAt: Date | null;
};
const exclude = (field: Prisma.Sql, ids: readonly string[] | undefined) => ids?.length
  ? Prisma.sql`AND ${field} NOT IN (${Prisma.join(ids)})` : Prisma.empty;

/** Read-only projection. Registry/user locks stabilize revocations and personal
 * exclusions; the ordered client/practice/parent locks stabilize the ownership
 * and lifecycle snapshot. No grant, audit, notification or receipt is written.
 * Serializable conflicts propagate instead of serving an older cached result.
 */
export async function readCommercialProgress(db: PrismaClient, claimed: AuthSession, raw: unknown) {
  const input = querySchema.parse(raw);
  return withSerializableTransaction(db, async tx => {
    if (internalSessionMode() !== 'registry' || !z.string().uuid().safeParse(claimed.sessionId).success) deny();
    await lockCommunicationDirectory(tx);
    const live = await lockAuthoritativeInternalSession(tx, { userId: claimed.userId, sessionId: claimed.sessionId! });
    if (!live || !live.active || live.deletedAt || live.revokedAt || !live.live || live.role !== 'commerciale') deny();
    const actor = { userId: live.userId, role: live.role, active: live.active,
      permissionOverrides: [...live.permissionOverrides], ...await loadSelectiveProjectScope(tx, live.userId) };
    if (!hasPermission(actor, 'client.read')) deny();
    // Search only within the current owner's admitted records; % and _ are
    // literal input, not extra search patterns. No financial tables are joined.
    const needle = `%${input.q.replace(/[\\%_]/g, '\\$&')}%`;
    const rows = await tx.$queryRaw<Row[]>(Prisma.sql`
      SELECT p."id", p."clientId", p."projectId", p."clientServiceId", p."commercialOwnerId", p."technicalOwnerId",
        p."status", p."deletedAt", p."dueDate", p."nextClientUpdateAt", p."updatedAt",
        c."displayName" AS "clientName", c."salesOwnerId",
        j."id" AS "linkedProjectId", j."clientId" AS "projectClientId", j."status" AS "projectStatus", j."deletedAt" AS "projectDeletedAt",
        s."id" AS "linkedServiceId", s."clientId" AS "serviceClientId", s."projectId" AS "serviceProjectId", s."status" AS "serviceStatus", s."deletedAt" AS "serviceDeletedAt"
      FROM "TechnicalPractice" p JOIN "Client" c ON c."id"=p."clientId"
      LEFT JOIN "ClientService" s ON s."id"=p."clientServiceId"
      LEFT JOIN "Project" j ON j."id"=COALESCE(p."projectId",s."projectId")
      WHERE c."salesOwnerId"=${actor.userId} AND p."commercialOwnerId"=${actor.userId}
        AND c."deletedAt" IS NULL AND p."deletedAt" IS NULL AND p."status" <> 'archiviata'
        AND c."displayName" ILIKE ${needle}
        ${input.client ? Prisma.sql`AND c."id"=${input.client}` : Prisma.empty}
        ${input.after ? Prisma.sql`AND p."id">${input.after}` : Prisma.empty}
        ${exclude(Prisma.sql`c."id"`, actor.selectiveClientIds)}
        ${exclude(Prisma.sql`p."id"`, actor.selectivePracticeIds)}
        AND (COALESCE(p."projectId",s."projectId") IS NULL OR (j."id" IS NOT NULL AND j."clientId"=c."id" AND j."deletedAt" IS NULL AND j."status"<>'archiviato'
          ${exclude(Prisma.sql`j."id"`, actor.selectiveProjectIds)}))
        AND (p."clientServiceId" IS NULL OR (s."id" IS NOT NULL AND s."clientId"=c."id" AND s."deletedAt" IS NULL AND s."status"<>'archiviato'
          ${exclude(Prisma.sql`s."id"`, actor.selectiveServiceIds)}
          AND (s."projectId" IS NULL OR s."projectId"=j."id")))
      ORDER BY p."id" LIMIT 51 FOR SHARE OF c,p
    `);
    const projectIds = [...new Set(rows.flatMap(row => row.linkedProjectId ? [row.linkedProjectId] : []))].sort();
    const serviceIds = [...new Set(rows.flatMap(row => row.clientServiceId ? [row.clientServiceId] : []))].sort();
    if (projectIds.length) await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Project" WHERE "id" IN (${Prisma.join(projectIds)}) ORDER BY "id" FOR SHARE`);
    if (serviceIds.length) await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "ClientService" WHERE "id" IN (${Prisma.join(serviceIds)}) ORDER BY "id" FOR SHARE`);
    const items = rows.slice(0, 50).map(row => {
      const projection = commercialProgressProjection(actor, {
        client: { id: row.clientId, salesOwnerId: row.salesOwnerId, deletedAt: null }, practice: row,
        project: row.linkedProjectId ? { id: row.linkedProjectId, clientId: row.projectClientId!, status: row.projectStatus!, deletedAt: row.projectDeletedAt } : null,
        service: row.linkedServiceId ? { id: row.linkedServiceId, clientId: row.serviceClientId!, projectId: row.serviceProjectId, status: row.serviceStatus!, deletedAt: row.serviceDeletedAt } : null,
      });
      if (!projection) deny();
      return { ...projection, clientName: row.clientName };
    });
    const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
    if (!clock || !Number.isFinite(claimed.expiresAt) || claimed.expiresAt * 1000 <= clock.now.getTime() || live.expiresAt <= clock.now) deny();
    return { items, next: rows.length > 50 ? items[49].id : null };
  });
}
