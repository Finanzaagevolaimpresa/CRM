import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import type { AuthSession } from './auth';
import { technicalImplementedActions } from './technical-assignment-contract';
import { lockTechnicalAssignmentContext } from './technical-assignment-context';
import { snapshotTechnicalAssignmentDocuments } from './technical-assignment-documents';
import { technicalFieldCatalogue, technicalFieldPreview, technicalTargetReference, type TechnicalTargetReference } from './technical-assignment-display';
import { readRetainedTechnicalAssignmentJournal } from './technical-assignment-journal';
import { admitsTechnicalRolePermission } from './technical-assignment-permissions';
import { loadTechnicalAssignmentJournal, lockTechnicalAssignmentRecord } from './technical-assignment-storage';
import { technicalAssignmentTargetFields } from './technical-assignment-target';
import { TechnicalAssignmentError, technicalAssignmentClock, withTechnicalAssignmentManagementRead } from './technical-assignment-transaction';
import { hasSelectiveClientContext } from './selective-client-policy';
import { hasSelectiveContext } from './selective-project-policy';
import { isSelectivePractice } from './selective-practice-policy';
import { loadTechnicalAssignmentIndependentScope } from './selective-project-scope';
import { listClientDocumentOptions } from './selective-client-documents';
import { listTechnicalWorkItemOptions } from './technical-work-item-source';

const identifier = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
function deny(): never { throw new TechnicalAssignmentError('DENIED'); }
type Context = NonNullable<Awaited<ReturnType<typeof lockTechnicalAssignmentContext>>>;
function restricted(scope: AuthSession | Awaited<ReturnType<typeof loadTechnicalAssignmentIndependentScope>>, context: Context) {
  return hasSelectiveClientContext(scope, context) || hasSelectiveContext(scope, context)
    || (context.kind === 'TechnicalPractice' && isSelectivePractice(scope, context.targetId));
}

/** Read-only catalogue under the current personal authority. Selected recipient
 * and target are freshly locked; list entries are candidates, not grants. The
 * exact preview/confirmation independently rereads all admission facts. */
export async function readTechnicalAssignmentManagement(db: PrismaClient, claimed: AuthSession,
  raw: TechnicalTargetReference, recipientId: string | null = null) {
  const target = technicalTargetReference.parse(raw);
  if (recipientId !== null) identifier.parse(recipientId);
  return withTechnicalAssignmentManagementRead(db, claimed, target.kind, recipientId, async (tx, state) => {
    const context = await lockTechnicalAssignmentContext(tx, target, { allowInactive: true });
    if (!context || restricted(state.current, context)) deny();
    const fields = technicalFieldPreview(target.kind, technicalFieldCatalogue(target.kind).map(row => row.key),
      await technicalAssignmentTargetFields(tx, target));
    const people = await tx.user.findMany({ where: { active: true, deletedAt: null, role: { in: ['consulente', 'backoffice'] } },
      orderBy: [{ name: 'asc' }, { id: 'asc' }], take: 201,
      select: { id: true, name: true, email: true, role: true, active: true, permissionOverrides: true } });
    const column = target.kind === 'Project' ? '"projectId"' : '"practiceId"';
    const refs = await tx.$queryRaw<Array<{ recipientId: string }>>(Prisma.sql`
      SELECT "recipientId" FROM "TechnicalAssignment" WHERE kind=${target.kind}
      AND ${Prisma.raw(column)}=${target.targetId} ORDER BY "recipientId" LIMIT 201`);
    const assignments = [];
    for (const ref of refs.slice(0, 200)) {
      const record = await lockTechnicalAssignmentRecord(tx, { ...target, recipientId: ref.recipientId }, 'read');
      if (!record) throw new TechnicalAssignmentError('UNAVAILABLE');
      const journal = await loadTechnicalAssignmentJournal(tx, record);
      if (!readRetainedTechnicalAssignmentJournal(journal, state.key, await technicalAssignmentClock(tx))) {
        throw new TechnicalAssignmentError('UNAVAILABLE');
      }
      const person = await tx.user.findUnique({ where: { id: ref.recipientId }, select: { name: true, email: true } });
      if (!person) throw new TechnicalAssignmentError('UNAVAILABLE');
      assignments.push({ id: record.id, recipientId: ref.recipientId, recipientName: person.name, recipientEmail: person.email,
        revision: record.revision, selection: record.payload.selection, revokedAt: record.revokedAt });
    }
    const person = state.recipient;
    const personScope = person ? await loadTechnicalAssignmentIndependentScope(tx, person.id) : null;
    const eligible = context.operational && person !== null && person.active && !person.deletedAt
      && person.id !== state.authority.userId && admitsTechnicalRolePermission(person, target.kind)
      && personScope !== null && !restricted(personScope, context);
    const allowedActions = eligible ? technicalImplementedActions.filter(action => admitsTechnicalRolePermission(person!, target.kind, action)) : [];
    const documentOptions = [];
    let documentsLimited = false;
    if (eligible && person) {
      const candidates = await listClientDocumentOptions(tx, state.actor, context.clientId);
      documentsLimited = candidates.documentsLimited || candidates.documentOptions.length > 50;
      // Lock in deterministic version order. Full checks may exclude documents
      // visible to the Admin but outside this person's exact operational context.
      for (const option of candidates.documentOptions.slice(0, 50).sort((a, b) => a.versionId.localeCompare(b.versionId))) {
        try {
          const chosen = await snapshotTechnicalAssignmentDocuments(tx, state, context, [{ fileId: option.versionId, allowDownload: false }]);
          documentOptions.push({ ...chosen.documents[0], ...chosen.metadata[0] });
        } catch (error) {
          if (!(error instanceof TechnicalAssignmentError && error.code === 'DENIED')
            && !(error instanceof Error && ['SELECTIVE_CLIENT_DOCUMENT_UNAVAILABLE', 'SELECTIVE_PRACTICE_DOCUMENT_UNAVAILABLE'].includes(error.message))) throw error;
        }
      }
    }
    const selected = recipientId ? await lockTechnicalAssignmentRecord(tx, { ...target, recipientId }, 'read') : null;
    const workItems = eligible ? await listTechnicalWorkItemOptions(tx, state, context, documentOptions)
      : { options: [], limited: false };
    return { target, contextSha256: context.contextSha256, operational: context.operational, fields,
      fieldCatalogue: technicalFieldCatalogue(target.kind),
      people: people.slice(0, 200).filter(row => admitsTechnicalRolePermission(row, target.kind))
        .map(row => ({ id: row.id, name: row.name, email: row.email })), peopleLimited: people.length > 200,
      assignments, assignmentsLimited: refs.length > 200, documentOptions, documentsLimited,
      workItemOptions: workItems.options, workItemsLimited: workItems.limited,
      recipient: person ? { id: person.id, name: person.name, email: person.email, epoch: person.recordUpdateEpoch } : null,
      recipientEligible: eligible, allowedActions, revision: selected?.revision ?? 0,
      currentAssignmentId: selected?.id ?? null, currentRevokedAt: selected?.revokedAt ?? null,
      observedAt: (await technicalAssignmentClock(tx)).toISOString() };
  }, { inactiveRecipientForRevocation: true });
}
