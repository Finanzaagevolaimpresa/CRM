import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import type { AuthSession } from './auth';
import { technicalImplementedActions } from './technical-assignment-contract';
import { lockTechnicalAssignmentContext } from './technical-assignment-context';
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
import { readAdmittedTechnicalDocumentOptions } from './technical-document-catalog-source';
import { pageTechnicalDocuments, technicalDocumentCatalogueQuery, type TechnicalDocumentCatalogueQuery,
  type TechnicalDocumentOption } from './technical-document-catalog';
import { listTechnicalWorkItemOptions } from './technical-work-item-source';
import { technicalWorkItemCatalogueQuery, type TechnicalWorkItemCatalogueQuery } from './technical-work-item-catalog';

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
async function readManagementSnapshot(db: PrismaClient, claimed: AuthSession,
  raw: TechnicalTargetReference, recipientId: string | null = null,
  rawItemQuery: TechnicalWorkItemCatalogueQuery = technicalWorkItemCatalogueQuery.parse({}),
  rawDocumentQuery: TechnicalDocumentCatalogueQuery = technicalDocumentCatalogueQuery.parse({}), includeCatalogues = true) {
  const target = technicalTargetReference.parse(raw);
  const itemQuery = technicalWorkItemCatalogueQuery.parse(rawItemQuery);
  const documentQuery = technicalDocumentCatalogueQuery.parse(rawDocumentQuery);
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
    let admittedDocuments: TechnicalDocumentOption[] = [];
    let documentCatalogueValidUntil = Number.MAX_SAFE_INTEGER;
    let documentCatalogueAvailable = includeCatalogues;
    if (includeCatalogues && eligible && person) {
      try {
        const admitted = await readAdmittedTechnicalDocumentOptions(tx, state, context);
        admittedDocuments = admitted.options; documentCatalogueValidUntil = admitted.validUntil;
      }
      catch (error) {
        if (!(error instanceof TechnicalAssignmentError && error.code === 'UNAVAILABLE')) throw error;
        documentCatalogueAvailable = false;
      }
    }
    const documentCatalogue = pageTechnicalDocuments(admittedDocuments, documentQuery);
    const selected = recipientId ? await lockTechnicalAssignmentRecord(tx, { ...target, recipientId }, 'read') : null;
    let workItems = { options: [] as Awaited<ReturnType<typeof listTechnicalWorkItemOptions>>['options'], query: itemQuery, hasNext: false };
    let workItemCatalogueAvailable = includeCatalogues;
    if (includeCatalogues && eligible) {
      try { workItems = await listTechnicalWorkItemOptions(tx, state, context, admittedDocuments, itemQuery); }
      catch (error) {
        if (!(error instanceof TechnicalAssignmentError && error.code === 'UNAVAILABLE')) throw error;
        // A bounded catalogue failure must not remove the independent revocation
        // controls or silently return an apparently complete empty catalogue.
        workItemCatalogueAvailable = false;
      }
    }
    const observedAt = await technicalAssignmentClock(tx);
    // Off-page admissions determine offsets and checklist availability too.
    // If one expired during this read, publish neither metadata nor pagination.
    if (documentCatalogueValidUntil <= observedAt.getTime()) throw new TechnicalAssignmentError('UNAVAILABLE');
    return { target, contextSha256: context.contextSha256, operational: context.operational, fields,
      fieldCatalogue: technicalFieldCatalogue(target.kind),
      people: people.slice(0, 200).filter(row => admitsTechnicalRolePermission(row, target.kind))
        .map(row => ({ id: row.id, name: row.name, email: row.email })), peopleLimited: people.length > 200,
      assignments, assignmentsLimited: refs.length > 200, documentOptions: documentCatalogue.options,
      documentsLimited: !documentCatalogueAvailable, documentCatalogue, documentCatalogueAvailable,
      cataloguesUnavailable: !includeCatalogues,
      workItemOptions: workItems.options, workItemCatalogue: workItems, workItemCatalogueAvailable,
      recipient: person ? { id: person.id, name: person.name, email: person.email, epoch: person.recordUpdateEpoch } : null,
      recipientEligible: eligible, allowedActions, revision: selected?.revision ?? 0,
      currentAssignmentId: selected?.id ?? null, currentRevokedAt: selected?.revokedAt ?? null,
      observedAt: observedAt.toISOString() };
  }, { inactiveRecipientForRevocation: true });
}

export function readTechnicalAssignmentManagement(db: PrismaClient, claimed: AuthSession,
  target: TechnicalTargetReference, recipientId: string | null = null,
  itemQuery: TechnicalWorkItemCatalogueQuery = technicalWorkItemCatalogueQuery.parse({}),
  documentQuery: TechnicalDocumentCatalogueQuery = technicalDocumentCatalogueQuery.parse({})) {
  return readManagementSnapshot(db, claimed, target, recipientId, itemQuery, documentQuery);
}

/** A failed catalogue transaction cannot carry history or revocation data.
 * Start a separate, fully authenticated read without any catalogue queries.
 * Invalid authority, session, context or retained journal still fails closed.
 * This fallback performs no mutation and cannot prepare a new assignment. */
export async function readTechnicalAssignmentManagementForPage(db: PrismaClient, claimed: AuthSession,
  target: TechnicalTargetReference, recipientId: string | null = null) {
  try { return await readManagementSnapshot(db, claimed, target, recipientId); }
  catch { return readManagementSnapshot(db, claimed, target, recipientId, technicalWorkItemCatalogueQuery.parse({}), technicalDocumentCatalogueQuery.parse({}), false); }
}
