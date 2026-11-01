import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { ordinaryReceiptSchema } from './ordinary-email-receipt';

/** Internal projection after native session/context/message/attachment admission.
 * No private claim, MAC, file path, SMTP transcript or configuration is returned. */
export async function readAdmittedOrdinaryEmailReceipts(tx: Prisma.TransactionClient, messageId: string) {
  z.string().uuid().parse(messageId);
  const [tables] = await tx.$queryRaw<Array<{ present: number; recovery: boolean }>>`SELECT count(*)::integer AS present,
    to_regclass('public."OrdinaryEmailReconciliation"') IS NOT NULL AS recovery FROM
    (VALUES (to_regclass('public."OrdinaryEmailAuthority"')), (to_regclass('public."OrdinaryEmailChannel"')),
      (to_regclass('public."OrdinaryEmailAttempt"')), (to_regclass('public."OrdinaryEmailDecision"')),
      (to_regclass('public."OrdinaryEmailClaim"')), (to_regclass('public."OrdinaryEmailOutcome"'))) AS candidate(relation) WHERE relation IS NOT NULL`;
  if (tables.present === 0) return [];
  if (tables.present !== 6) throw new Error('ORDINARY_EMAIL_RECEIPTS_UNAVAILABLE');
  const reconciliation = tables.recovery ? Prisma.sql`jsonb_build_object('id',r."id",'sourceHash',r."sourceHash",
    'recordedAt',r."createdAt",'originalOutcome',o."outcome")` : Prisma.sql`NULL`;
  const rows = await tx.$queryRaw<Array<Record<string, unknown>>>`SELECT a."id",v."revision",v."snapshotHash",a."state",a."createdAt",
    ${tables.recovery ? Prisma.sql`COALESCE(r."outcome",o."outcome")` : Prisma.sql`o."outcome"`} AS "outcome",
    ${tables.recovery ? Prisma.sql`COALESCE(r."createdAt",o."createdAt")` : Prisma.sql`o."createdAt"`} AS "recordedAt",
    ${tables.recovery ? Prisma.sql`CASE WHEN r."id" IS NOT NULL THEN ${reconciliation} ELSE NULL END` : reconciliation} AS "reconciliation"
    FROM "OrdinaryEmailAttempt" a JOIN "OrdinaryEmailDecision" d ON d."id"=a."decisionId" AND d."messageId"=a."messageId"
    JOIN "CommunicationVersion" v ON v."id"=d."versionId" AND v."messageId"=a."messageId"
    LEFT JOIN "OrdinaryEmailOutcome" o ON o."attemptId"=a."id"
    ${tables.recovery ? Prisma.sql`LEFT JOIN "OrdinaryEmailReconciliation" r ON r."attemptId"=a."id"` : Prisma.empty}
    WHERE a."messageId"=${messageId}::uuid ORDER BY a."createdAt" DESC,a."id" DESC LIMIT 50`;
  return rows.map(row => ordinaryReceiptSchema.parse(row));
}
