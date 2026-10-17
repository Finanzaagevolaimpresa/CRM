import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { ordinaryReceiptSchema } from './ordinary-email-receipt';

/** Internal projection only. The caller must hold the native session, context,
 * message and attachment locks and admit this message first. No client ID list,
 * proof, claim, cookie, configuration, SMTP transcript or content is returned. */
export async function readAdmittedOrdinaryEmailReceipts(tx: Prisma.TransactionClient, messageId: string) {
  z.string().uuid().parse(messageId);
  const [tables] = await tx.$queryRaw<Array<{ present: number }>>`SELECT count(*)::integer AS present FROM
    (VALUES (to_regclass('public."OrdinaryEmailAuthority"')), (to_regclass('public."OrdinaryEmailChannel"')),
      (to_regclass('public."OrdinaryEmailAttempt"')), (to_regclass('public."OrdinaryEmailDecision"')),
      (to_regclass('public."OrdinaryEmailClaim"')), (to_regclass('public."OrdinaryEmailOutcome"'))) AS candidate(relation) WHERE relation IS NOT NULL`;
  // Schema50 without the isolated candidate remains usable. Partial deployment
  // or any query failure is an error, never silently converted to manual data.
  if (tables.present === 0) return [];
  if (tables.present !== 6) throw new Error('ORDINARY_EMAIL_RECEIPTS_UNAVAILABLE');
  const rows = await tx.$queryRaw<Array<unknown>>`SELECT a."id",v."revision",v."snapshotHash",a."state",a."createdAt",
    o."outcome",o."createdAt" AS "recordedAt" FROM "OrdinaryEmailAttempt" a
    JOIN "OrdinaryEmailDecision" d ON d."id"=a."decisionId" AND d."messageId"=a."messageId"
    JOIN "CommunicationVersion" v ON v."id"=d."versionId" AND v."messageId"=a."messageId"
    LEFT JOIN "OrdinaryEmailOutcome" o ON o."attemptId"=a."id"
    WHERE a."messageId"=${messageId}::uuid ORDER BY a."createdAt" DESC,a."id" DESC LIMIT 50`;
  return rows.map(row => ordinaryReceiptSchema.parse(row));
}
