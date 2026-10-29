import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { canonicalSha256 } from './canonical-json';
import { RecordUpdateError } from './record-update-contract';
import type { ReminderInput, ReminderSource } from './record-reminder-contract';
import { isFinancialDocument } from './financial-privacy-policy';
import { lockTechnicalAssignmentContext } from './technical-assignment-context';
import { lockTechnicalWorkItemSource } from './technical-work-item-source';
import { lockTechnicalWorkItemGeneration } from './technical-work-item-generation';
import { readTechnicalPrivateItemOrigin } from './technical-private-item-storage';
import type { TechnicalAssignmentTransaction } from './technical-assignment-transaction';

type Tx = Prisma.TransactionClient;
type Reader = Pick<TechnicalAssignmentTransaction, 'key' | 'recipient'>;
const identifier = z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/);
const reference = z.object({ kind: z.enum(['CLIENT', 'PROJECT', 'PRACTICE']), recordId: identifier, taskId: identifier }).strict();
function deny(): never { throw new RecordUpdateError('DENIED'); }
const active = (row: { deletedAt: Date | null; status: string } | null) => row && !row.deletedAt
  && !['archiviato', 'archiviata', 'sospeso'].includes(row.status);

/** Internal read-only source loader. The caller holds the current key, directory,
 * sorted user and session locks. Parent -> company -> Task -> generation order
 * is shared with the technical work service. A source is not an access grant. */
export async function lockRecordReminderSource(tx: Tx, reader: Reader,
  input: Pick<ReminderInput, 'kind' | 'recordId' | 'taskId'>) {
  const ref = reference.parse({ kind: input.kind, recordId: input.recordId, taskId: input.taskId });
  const target = ref.kind === 'CLIENT' ? null : { kind: ref.kind === 'PROJECT' ? 'Project' as const : 'TechnicalPractice' as const,
    targetId: ref.recordId };
  const technicalContext = target ? await lockTechnicalAssignmentContext(tx, target) : null;
  if (target && !technicalContext) deny();
  const clientId = technicalContext?.clientId ?? ref.recordId;
  if (!target) await tx.$queryRaw`SELECT id FROM "Client" WHERE id=${clientId} FOR SHARE`;
  const client = await tx.client.findUnique({ where: { id: clientId } });
  if (!active(client)) deny();
  const project = technicalContext?.projectId
    ? await tx.project.findUnique({ where: { id: technicalContext.projectId } }) : null;
  const service = technicalContext?.clientServiceId
    ? await tx.clientService.findUnique({ where: { id: technicalContext.clientServiceId } }) : null;
  const practice = target?.kind === 'TechnicalPractice'
    ? await tx.technicalPractice.findUnique({ where: { id: target.targetId } }) : null;
  const technical = technicalContext ? await lockTechnicalWorkItemSource(tx, reader, technicalContext,
    { kind: 'Task', itemId: ref.taskId }, []) : null;
  if (!technical) await tx.$queryRaw`SELECT id FROM "Task" WHERE id=${ref.taskId} FOR SHARE`;
  const task = await tx.task.findUnique({ where: { id: ref.taskId } });
  if (!task || task.clientId !== clientId || task.deletedAt || !task.dueAt
    || !['aperta', 'in_lavorazione'].includes(task.status)
    || isFinancialDocument({ title: task.title, type: task.type })) deny();
  if (!target) {
    // A client-only reminder cannot implicitly choose a project/practice or a
    // private technical origin. Use that exact context for those activities.
    if (task.projectId || task.clientServiceId || task.companyId || task.technicalPrivate) deny();
    if (await readTechnicalPrivateItemOrigin(tx, reader.key, { kind: 'Task', itemId: task.id })) deny();
  }
  const generation = technical?.epoch ?? await lockTechnicalWorkItemGeneration(tx, { kind: 'Task', itemId: task.id }, 'read');
  const contextDigest = technical?.scopeSha256 ?? canonicalSha256({ protocol: 'REMINDER_CLIENT_TASK_SCOPE_V1',
    clientId, clientEpoch: client!.recordUpdateEpoch, ownerId: client!.salesOwnerId, consultantId: client!.consultantId,
    taskId: task.id, assignedToId: task.assignedToId, createdById: task.createdById,
    scopeGeneration: generation.scopeGeneration });
  const source: ReminderSource = { ...ref, generation: generation.generation, scopeGeneration: generation.scopeGeneration,
    scopeDigest: contextDigest, dueAt: task.dueAt.toISOString(), status: task.status, taskDeleted: false, recordDeleted: false };
  return { source, task, client: client!, project, service, practice, technicalContext, technical,
    taskAccess: { ...task, client: client!, project: project ? { ...project, client: client! } : null,
      clientService: service ? { ...service, client: client!, project: project ? { ...project, client: client! } : null } : null } };
}
export type LockedReminderSource = Awaited<ReturnType<typeof lockRecordReminderSource>>;
