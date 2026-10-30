import { Prisma } from '@prisma/client';
import { canonicalSha256 } from './canonical-json';

const plain = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
export const communicationFileCommandHash = (value: unknown) => canonicalSha256(plain(value));
export function communicationFileDerivedCommand(namespace: string, id: string) {
  const h = canonicalSha256({ namespace, id });
  return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`;
}
/** Only after current native Admin/session admission, in the same transaction as
 * the file effect or the unused-attempt barrier. Never records a send decision. */
export async function recordCommunicationFileCommand(tx: Prisma.TransactionClient, input: {
  commandId: string; actorId: string; sessionId: string; id: string; requestHash: string; reason: string;
  operation: 'CREATE' | 'UPDATE' | 'CLOSE'; before: unknown; after: unknown;
}) {
  const beforeHash = communicationFileCommandHash(input.before), afterHash = communicationFileCommandHash(input.after);
  await tx.adminRecordRevision.create({ data: { commandId: input.commandId, actorId: input.actorId, sessionId: input.sessionId,
    model: 'CommunicationContextFile', recordId: input.id, operation: input.operation, requestHash: input.requestHash,
    before: input.before === null ? Prisma.JsonNull : plain(input.before), after: input.after === null ? Prisma.JsonNull : plain(input.after),
    beforeHash, afterHash, reason: input.reason } });
  await tx.auditLog.create({ data: { id: 'admin-record:' + input.commandId, actorId: input.actorId,
    event: input.operation === 'CLOSE' ? 'admin_record_attempt_closed' : 'admin_record_changed',
    entityType: 'CommunicationContextFile', entityId: input.id,
    after: input.operation === 'CLOSE' ? { commandId: input.commandId }
      : { action: input.operation, commandId: input.commandId, beforeHash, afterHash, changedPaths: ['administrativeFileVersion'] } } });
}
