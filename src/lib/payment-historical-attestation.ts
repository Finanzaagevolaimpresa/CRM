import { Prisma, type AdminRecordRevision, type Payment, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import type { AuthSession } from './auth';
import { canonicalSha256 } from './canonical-json';
import { paymentCollectionContext } from './payment-collection';
import { withSerializableTransaction } from './serializable';
import { type UpdateCredentials } from './record-updates';
import { recordUpdatePermission } from './record-update-context';
import { historicalPaymentCommand, historicalPaymentModel, historicalPaymentSource,
  HistoricalPaymentError, type HistoricalPaymentCommand, type HistoricalPaymentPreview,
  type HistoricalPaymentReceipt, type HistoricalPaymentSource } from './payment-historical-attestation-contract';

type Tx = Prisma.TransactionClient;
type Context = Awaited<ReturnType<typeof paymentCollectionContext>>;
const plain = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const digest = (value: unknown) => canonicalSha256(plain(value));
function fail(code: HistoricalPaymentError['code']): never { throw new HistoricalPaymentError(code); }
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const stamp = (day: string) => new Date(day + 'T00:00:00.000Z');
const today = (now: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome' }).format(now);
const afterSchema = z.object({
  id: z.string(), clientId: z.string(), contractId: z.string(), totalAmount: z.string(),
  status: z.literal('incassato'), collectedAt: z.string().datetime(), method: z.null(),
  accountingDocumentId: z.null(), historicalAttestation: historicalPaymentSource,
}).passthrough();

function sourceOf(row: AdminRecordRevision, payment: Payment): HistoricalPaymentSource {
  const saved = afterSchema.safeParse(row.after);
  if (row.model !== historicalPaymentModel || row.recordId !== payment.id || row.operation !== 'UPDATE'
    || !saved.success || row.afterHash !== digest(row.after) || row.beforeHash !== digest(row.before)) fail('INVALID');
  const data = saved.data;
  if (data.id !== payment.id || data.clientId !== payment.clientId || data.contractId !== payment.contractId
    || data.totalAmount !== payment.totalAmount.toString()
    || data.collectedAt !== stamp(data.historicalAttestation.effectiveDay).toISOString()
    || payment.collectedAt?.toISOString() !== data.collectedAt || payment.accountingDocumentId !== null) fail('INVALID');
  return data.historicalAttestation;
}
async function recorded(tx: Tx, paymentId: string) {
  const rows = await tx.adminRecordRevision.findMany({ where: { model: historicalPaymentModel, recordId: paymentId, operation: 'UPDATE' }, take: 2 });
  if (rows.length > 1) fail('INVALID');
  return rows[0] ?? null;
}
async function view(tx: Tx, c: Context, row: AdminRecordRevision): Promise<HistoricalPaymentReceipt> {
  const source = sourceOf(row, c.payment), before = row.before as { status: string };
  const actor = await tx.user.findUnique({ where: { id: row.actorId }, select: { name: true } });
  await c.finish();
  return { commandId: row.commandId, paymentId: c.payment.id, clientId: c.client.id,
    amount: c.payment.totalAmount.toFixed(2), source, reason: row.reason, recordedAt: row.createdAt.toISOString(),
    actorId: row.actorId, actorName: actor?.name ?? 'Account conservato nello storico',
    previousStatus: before.status, currentStatus: c.payment.status };
}
async function receipt(tx: Tx, c: Context, commandId: string, input?: HistoricalPaymentCommand) {
  const row = await tx.adminRecordRevision.findUnique({ where: { commandId } });
  if (!row) { await c.finish(); return null; }
  if (row.model !== historicalPaymentModel || row.recordId !== c.payment.id || row.actorId !== c.actor.id
    || (input && (row.sessionId !== c.registry.id || row.requestHash !== digest({ type: historicalPaymentModel, input })))) fail('DENIED');
  return view(tx, c, row);
}
async function available(tx: Tx, c: Context) {
  if (!['da_incassare', 'scaduto'].includes(c.payment.status) || c.payment.collectedAt || c.payment.accountingDocumentId
    || !c.payment.totalAmount.gt(0) || c.payment.totalAmount.gt(c.contract.totalAmount)
    || ['annullato', 'archiviato'].includes(c.contract.status)
    || await recorded(tx, c.payment.id) || await tx.clientService.count({ where: { paymentId: c.payment.id } })) return false;
  return true;
}
async function proposal(tx: Tx, c: Context, input: HistoricalPaymentCommand) {
  if (!await available(tx, c)) fail('CLOSED');
  const now = await c.finish(), expiresAt = new Date(input.expiresAt);
  if (expiresAt <= now || expiresAt.getTime() - now.getTime() > 5 * 60_000) fail('EXPIRED');
  if (input.effectiveDay > today(now) || input.attestedOn > today(now) || input.effectiveDay > input.attestedOn
    || input.expectedAmount !== c.payment.totalAmount.toFixed(2)) fail('INVALID');
  const preview: HistoricalPaymentPreview = {
    digest: digest({ type: historicalPaymentModel, input, actorId: c.actor.id, sessionId: c.registry.id,
      client: c.client, contract: c.contract, payment: c.payment, project: c.project }),
    client: c.client.displayName, contract: c.contract.contractNumber, amount: c.payment.totalAmount.toFixed(2),
    effectiveDay: input.effectiveDay, attestedOn: input.attestedOn, declarant: input.declarant,
    provenance: input.provenance, reason: input.reason, previousStatus: c.payment.status,
    previousMethod: c.payment.method, expiresAt: input.expiresAt,
  };
  await c.finish();
  return preview;
}
const context = (tx: Tx, actor: AuthSession, clientId: string, paymentId: string, proof?: UpdateCredentials) =>
  paymentCollectionContext(tx, actor, clientId, paymentId, { source: 'ADMIN_ATTESTATION', write: Boolean(proof), proof });

export async function previewHistoricalPayment(db: PrismaClient, actor: AuthSession, raw: unknown) {
  const input = historicalPaymentCommand.parse(raw);
  return withSerializableTransaction(db, async tx => proposal(tx, await context(tx, actor, input.clientId, input.paymentId), input));
}
export async function confirmHistoricalPayment(db: PrismaClient, actor: AuthSession, raw: unknown, previewDigest: string, proof: UpdateCredentials) {
  const input = historicalPaymentCommand.parse(raw); hash.parse(previewDigest);
  if (!proof) fail('DENIED');
  return withSerializableTransaction(db, async tx => {
    const c = await context(tx, actor, input.clientId, input.paymentId, proof);
    const prior = await receipt(tx, c, input.commandId, input);
    if (prior) return prior;
    const current = await proposal(tx, c, input);
    if (current.digest !== previewDigest) fail('STALE');
    // This normalization is storage only. The immutable typed source preserves
    // DAY precision and unknown time/method; it is never banking evidence.
    const payment = await tx.payment.update({ where: { id: c.payment.id }, data: {
      status: 'incassato', collectedAt: stamp(input.effectiveDay), method: null,
    } });
    const source = historicalPaymentSource.parse({
      type: 'OWNER_ADMIN_ATTESTATION_V1', effectiveDay: input.effectiveDay, precision: 'DAY',
      effectiveTime: null, declaredMethod: null, attestedOn: input.attestedOn,
      declarant: input.declarant, provenance: input.provenance, bankEvidenceVerified: false,
      storageNormalization: 'UTC_MIDNIGHT_NOT_ACTUAL_CREDIT_TIME',
    });
    const before = plain(c.payment), after = { ...JSON.parse(JSON.stringify(payment)), historicalAttestation: source };
    const beforeHash = digest(before), afterHash = digest(after);
    const row = await tx.adminRecordRevision.create({ data: {
      commandId: input.commandId, actorId: c.actor.id, sessionId: c.registry.id,
      model: historicalPaymentModel, recordId: c.payment.id, operation: 'UPDATE',
      requestHash: digest({ type: historicalPaymentModel, input }), beforeHash, afterHash,
      before, after, reason: input.reason,
    } });
    await tx.auditLog.create({ data: { id: 'admin-record:' + input.commandId, actorId: c.actor.id,
      event: 'admin_record_changed', entityType: historicalPaymentModel, entityId: c.payment.id,
      after: { commandId: input.commandId, action: 'UPDATE', beforeHash, afterHash,
        changedPaths: ['status', 'collectedAt', 'method', 'historicalAttestation'], source: 'OWNER_ADMIN_ATTESTATION_V1' } } });
    await tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`;
    return view(tx, { ...c, payment }, row);
  });
}
export async function readHistoricalPaymentReceipt(db: PrismaClient, actor: AuthSession, clientId: string, paymentId: string, commandId: string) {
  z.string().uuid().parse(commandId);
  return withSerializableTransaction(db, async tx => receipt(tx, await context(tx, actor, clientId, paymentId), commandId));
}
export async function historicalPaymentSetup(db: PrismaClient, actor: AuthSession, paymentId: string) {
  if (actor.role !== 'admin') fail('DENIED');
  return withSerializableTransaction(db, async tx => {
    const initial = await tx.payment.findUnique({ where: { id: paymentId }, select: { clientId: true } });
    if (!initial) fail('DENIED');
    const c = await context(tx, actor, initial.clientId, paymentId), row = await recorded(tx, paymentId);
    const result = row ? await view(tx, c, row) : null;
    const eligible = result === null && await available(tx, c);
    await c.finish();
    return { clientId: c.client.id, paymentId, client: c.client.displayName, contract: c.contract.contractNumber,
      amount: c.payment.totalAmount.toFixed(2), eligible, result };
  });
}
/** For server-rendered Admin tables only, after their ordinary row admission. */
export async function historicalPaymentSummaries(db: PrismaClient, actor: AuthSession, admitted: readonly Payment[]) {
  const result = new Map<string, HistoricalPaymentSource>();
  if (actor.role !== 'admin' || !actor.active || !recordUpdatePermission(actor, 'payment.read') || !admitted.length) return result;
  const byId = new Map(admitted.map(row => [row.id, row]));
  const rows = await db.adminRecordRevision.findMany({ where: { model: historicalPaymentModel,
    recordId: { in: [...byId.keys()] }, operation: 'UPDATE' } });
  for (const row of rows) {
    if (result.has(row.recordId)) fail('INVALID');
    result.set(row.recordId, sourceOf(row, byId.get(row.recordId)!));
  }
  return result;
}
