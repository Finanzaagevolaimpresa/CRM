'use server';

import { headers, cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { TechnicalAssignmentManagementState } from '@/components/technical-assignment-management';
import { requireSession } from './auth';
import { prisma } from './prisma';
import { isAllowedMutationOrigin } from './application-security-policy';
import { loadActivePrivilegedStepUpKey } from './application-key-registry';
import { privilegedStepUpCookieName, requireEnforcedPrivilegedMutation } from './privileged-access';
import { technicalAssignmentReference } from './technical-assignment-decision';
import { confirmTechnicalAssignment, previewTechnicalAssignment, readTechnicalAssignmentOutcome } from './technical-assignment-service';
import { TechnicalAssignmentError } from './technical-assignment-transaction';
import { technicalManagementPath } from './technical-assignment-display';
import { readTechnicalAssignmentManagement } from './technical-assignment-management';
import { technicalWorkItemCatalogueQuery, type TechnicalWorkItemCatalogue } from './technical-work-item-catalog';
import { technicalDocumentCatalogueQuery, type TechnicalDocumentCatalogue } from './technical-document-catalog';
import { technicalAssignmentFailure as failure } from './technical-assignment-failure';

function json(form: FormData, name: string) {
  const raw = form.get(name);
  if (typeof raw !== 'string' || raw.length > 24_000) throw new TechnicalAssignmentError('DENIED');
  return JSON.parse(raw) as unknown;
}
async function origin() {
  const h = await headers();
  if (!isAllowedMutationOrigin({ origin: h.get('origin'), secFetchSite: h.get('sec-fetch-site'),
    configuredOrigin: process.env.APP_ORIGIN ?? process.env.NEXT_PUBLIC_APP_URL })) throw new TechnicalAssignmentError('DENIED');
}

/** Read-only even though carried by a same-origin server action. It grants no
 * item and returns only the current catalogue for the personal Admin. */
export async function searchTechnicalWorkItemCatalogue(raw: unknown): Promise<{
  ok: boolean; message: string; catalogue?: TechnicalWorkItemCatalogue }> {
  try {
    const session = await requireSession();
    await origin();
    const request = z.object({ reference: technicalAssignmentReference,
      contextSha256: z.string().regex(/^[a-f0-9]{64}$/), recipientEpoch: z.number().int().positive(),
      query: technicalWorkItemCatalogueQuery }).strict().parse(raw);
    const data = await readTechnicalAssignmentManagement(prisma, session,
      { kind: request.reference.kind, targetId: request.reference.targetId },
      request.reference.recipientId, request.query);
    if (!data.workItemCatalogueAvailable || !data.recipientEligible || data.contextSha256 !== request.contextSha256
      || data.recipient?.epoch !== request.recipientEpoch) throw new TechnicalAssignmentError('STALE');
    return { ok: true, message: 'Catalogo aggiornato. Le scelte già effettuate sono conservate.', catalogue: data.workItemCatalogue };
  } catch { return { ok: false, message: 'Catalogo non disponibile con lo stato o i permessi correnti. Ricarica per verificare le scelte.' }; }
}

/** A catalogue search is a current read, never a document grant or a download. */
export async function searchTechnicalDocumentCatalogue(raw: unknown): Promise<{
  ok: boolean; message: string; catalogue?: TechnicalDocumentCatalogue }> {
  try {
    const session = await requireSession();
    await origin();
    const request = z.object({ reference: technicalAssignmentReference,
      contextSha256: z.string().regex(/^[a-f0-9]{64}$/), recipientEpoch: z.number().int().positive(),
      query: technicalDocumentCatalogueQuery }).strict().parse(raw);
    const data = await readTechnicalAssignmentManagement(prisma, session,
      { kind: request.reference.kind, targetId: request.reference.targetId }, request.reference.recipientId,
      technicalWorkItemCatalogueQuery.parse({}), request.query);
    if (!data.documentCatalogueAvailable || !data.recipientEligible || data.contextSha256 !== request.contextSha256
      || data.recipient?.epoch !== request.recipientEpoch) throw new TechnicalAssignmentError('STALE');
    return { ok: true, message: 'Catalogo aggiornato. Le versioni già scelte conservano la selezione originale.', catalogue: data.documentCatalogue };
  } catch { return { ok: false, message: 'Catalogo documenti non disponibile con lo stato o i permessi correnti. Ricarica per verificare le scelte.' }; }
}
export async function prepareTechnicalAssignment(_state: TechnicalAssignmentManagementState, form: FormData): Promise<TechnicalAssignmentManagementState> {
  const session = await requireSession();
  try {
    await origin();
    const ref = technicalAssignmentReference.parse(json(form, 'reference'));
    const operation = z.enum(['ASSIGN', 'REVOKE']).parse(form.get('operation'));
    const preview = await previewTechnicalAssignment(prisma, session, ref, operation, json(form, 'command'));
    return { ok: true, message: 'Riepilogo pronto. Nessun incarico è stato modificato.', preview };
  } catch (error) { return failure(error, true); }
}
export async function saveTechnicalAssignment(_state: TechnicalAssignmentManagementState, form: FormData): Promise<TechnicalAssignmentManagementState> {
  const session = await requireSession();
  await requireEnforcedPrivilegedMutation(session, 'TECHNICAL_ASSIGNMENT_MANAGE');
  try {
    await origin();
    const ref = technicalAssignmentReference.parse(json(form, 'reference'));
    const operation = z.enum(['ASSIGN', 'REVOKE']).parse(form.get('operation'));
    const store = await cookies(), key = await loadActivePrivilegedStepUpKey(prisma);
    if (!key) throw new TechnicalAssignmentError('UNAVAILABLE');
    const receipt = await confirmTechnicalAssignment(prisma, session, { key,
      sessionToken: store.get(process.env.AUTH_COOKIE_NAME ?? 'fai_crm_session')?.value ?? '',
      stepUpToken: store.get(privilegedStepUpCookieName)?.value ?? '' }, ref, operation, json(form, 'command'),
      String(form.get('token') ?? ''), form.get('confirmed') === 'on');
    revalidatePath(technicalManagementPath(ref));
    for (const path of ['/projects', '/technical-office/practices', '/technical-work', '/dashboard', '/search', '/notifications']) revalidatePath(path);
    return { ok: true, message: operation === 'ASSIGN' ? 'Incarico registrato con il solo perimetro confermato.'
      : 'Revoca registrata. Lo storico è conservato.', outcome: { status: 'RECORDED', receipt } };
  } catch (error) { return failure(error); }
}
export async function checkTechnicalAssignment(_state: TechnicalAssignmentManagementState, form: FormData): Promise<TechnicalAssignmentManagementState> {
  const session = await requireSession();
  try {
    await origin();
    const outcome = await readTechnicalAssignmentOutcome(prisma, session,
      technicalAssignmentReference.parse(json(form, 'reference')), String(form.get('commandId') ?? ''));
    return outcome.status === 'RECORDED' ? { ok: true, message: 'Decisione registrata. Ricarica per consultare gli incarichi correnti.', outcome }
      : { ok: false, uncertain: true, message: 'Decisione non osservata. Non ripetere l’operazione finché l’esito non è riconciliato.', outcome };
  } catch (error) { return { ...failure(error), uncertain: true }; }
}
