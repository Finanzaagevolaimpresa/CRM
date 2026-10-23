import type { Prisma } from '@prisma/client';
import { lockInternalUser } from './internal-session-registry';
import type { SelectivePracticeScope } from './selective-practice-policy';
import { loadTechnicalAssignmentExclusions } from './technical-assignment-exclusions';

type Tx = Prisma.TransactionClient;
const idOnly = { id: true } as const;
const ids = (rows: readonly { id: string }[]) => rows.map(row => row.id);

/** Exclusions, not authorizations. Do not expand them to independently allowed
 * parent records or sibling practices. Related audit identifiers are domain-free
 * only at the final audit boundary, where both JSON snapshots are inspected. */
export async function loadSelectivePracticeScope(tx: Tx, recipientId: string, technicalPracticeIds?: readonly string[]): Promise<Required<SelectivePracticeScope>> {
  const grants = await tx.selectivePracticeGrant.findMany({ where: { recipientId }, select: {
    id: true, practiceId: true, revisions: { select: { id: true, commandId: true } },
  } });
  const technical = technicalPracticeIds ?? (await loadTechnicalAssignmentExclusions(tx, recipientId)).practiceIds;
  const selectivePracticeIds = [...new Set([...grants.map(row => row.practiceId), ...technical])];
  if (!selectivePracticeIds.length) return { selectivePracticeIds, selectivePracticeAuditEntityIds: [] };
  const context = { technicalPracticeId: { in: selectivePracticeIds } };
  const [legacy, messages, files, events, rules, commands] = await Promise.all([
    tx.practiceCommunication.findMany({ where: context, select: idOnly }),
    tx.approvedCommunication.findMany({ where: context, select: { id: true,
      versions: { select: idOnly }, attempts: { select: idOnly }, events: { select: idOnly }, replies: { select: idOnly },
      ordinaryEmailDecisions: { select: idOnly }, ordinaryEmailAttempts: { select: idOnly },
    } }),
    tx.communicationContextFile.findMany({ where: context, select: idOnly }),
    tx.recordUpdateEvent.findMany({ where: { kind: 'PRACTICE', recordId: { in: selectivePracticeIds } }, select: { id: true, deliveries: { select: idOnly } } }),
    tx.recordUpdateRule.findMany({ where: { kind: 'PRACTICE', recordId: { in: selectivePracticeIds } }, select: { id: true, deliveries: { select: idOnly } } }),
    tx.recordUpdateCommand.findMany({ where: { kind: 'PRACTICE', recordId: { in: selectivePracticeIds } }, select: { id: true, deliveries: { select: idOnly } } }),
  ]);
  const selectivePracticeAuditEntityIds = [...new Set([
    ...selectivePracticeIds, ...ids(legacy), ...ids(files),
    ...grants.flatMap(row => [row.id, ...row.revisions.flatMap(revision => [revision.id, revision.commandId])]),
    ...messages.flatMap(row => [row.id, ...ids(row.versions), ...ids(row.attempts), ...ids(row.events), ...ids(row.replies),
      ...ids(row.ordinaryEmailDecisions), ...ids(row.ordinaryEmailAttempts)]),
    ...[...events, ...rules, ...commands].flatMap(row => [row.id, ...ids(row.deliveries)]),
  ])];
  return { selectivePracticeIds, selectivePracticeAuditEntityIds };
}

export async function assertNoSelectivePracticeMutation(tx: Tx, recipientId: string, practiceId: string) {
  await lockInternalUser(tx, recipientId);
  if (await tx.selectivePracticeGrant.findFirst({ where: { recipientId, practiceId }, select: idOnly })) {
    throw new Error('SELECTIVE_PRACTICE_READ_ONLY');
  }
  if ((await loadTechnicalAssignmentExclusions(tx, recipientId)).practiceIds.includes(practiceId)) {
    throw new Error('TECHNICAL_ASSIGNMENT_EXPLICIT_OPERATION_REQUIRED');
  }
}
