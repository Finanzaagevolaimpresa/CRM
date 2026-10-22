'use server';

import { cookies, headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { ZodError } from 'zod';
import type { LeadEditUiState } from '@/components/selective-lead-editor';
import type { LeadEditManagementState } from '@/components/selective-lead-edit-management';
import { requirePermission } from './auth';
import { prisma } from './prisma';
import { isAllowedMutationOrigin } from './application-security-policy';
import { loadActivePrivilegedStepUpKey } from './application-key-registry';
import { requireEnforcedPrivilegedMutation, privilegedStepUpCookieName } from './privileged-access';
import { LeadEditError } from './selective-lead-edit-transaction';
import { previewLeadEdit, confirmLeadEdit, readLeadEditOutcomeByReference } from './selective-lead-edit-service';
import { previewLeadEditingSelection, confirmLeadEditingSelection, revokeLeadEditing,
  readLeadEditingDecision } from './selective-lead-edit-management';

function failure(error: unknown) {
  if (error instanceof ZodError || error instanceof SyntaxError) {
    return { ok: false, message: 'Dati non validi. Ricarica la pagina e prepara una nuova anteprima.' };
  }
  if (error instanceof LeadEditError) return { ok: false, message: error.code === 'STALE'
    ? 'Dati o permessi cambiati. Ricarica la pagina e prepara una nuova anteprima.'
    : 'Operazione non consentita. Verifica sessione e abilitazione corrente.' };
  return { ok: false, uncertain: true, message: 'Esito non confermato. Verifica la ricevuta prima di una nuova operazione.' };
}
function input(form: FormData, name: string) {
  const raw = form.get(name);
  if (typeof raw !== 'string' || raw.length > 16_000) throw new LeadEditError('DENIED');
  return JSON.parse(raw) as unknown;
}
async function origin() {
  const h = await headers();
  if (!isAllowedMutationOrigin({ origin: h.get('origin'), secFetchSite: h.get('sec-fetch-site'),
    configuredOrigin: process.env.APP_ORIGIN ?? process.env.NEXT_PUBLIC_APP_URL })) throw new LeadEditError('DENIED');
}
async function credentials() {
  const store = await cookies(), key = await loadActivePrivilegedStepUpKey(prisma);
  if (!key) throw new LeadEditError('UNAVAILABLE');
  return { key, sessionToken: store.get(process.env.AUTH_COOKIE_NAME ?? 'fai_crm_session')?.value ?? '',
    stepUpToken: store.get(privilegedStepUpCookieName)?.value ?? '' };
}
function refresh() {
  for (const path of ['/leads', '/shared-leads', '/dashboard', '/search', '/notifications']) revalidatePath(path);
  for (const path of ['/leads/[id]/sharing', '/leads/[id]/sharing/editing', '/leads/[id]/edit-selected', '/shared-leads/[id]']) {
    revalidatePath(path, 'page');
  }
}
export async function prepareSelectedLeadEdit(_state: LeadEditUiState, form: FormData): Promise<LeadEditUiState> {
  const session = await requirePermission('lead.read');
  try {
    await origin();
    const preview = await previewLeadEdit(prisma, session, input(form, 'command'));
    return { ok: true, message: 'Anteprima pronta. Il lead non è stato modificato.', preview };
  } catch (error) { return failure(error); }
}
export async function confirmSelectedLeadEdit(_state: LeadEditUiState, form: FormData): Promise<LeadEditUiState> {
  // The narrow signed capability supplies only the two selected operations.
  // Requiring a broad role permission here would undo that separate decision.
  const session = await requirePermission('lead.read');
  try {
    await origin();
    const receipt = await confirmLeadEdit(prisma, session, input(form, 'command'),
      String(form.get('token') ?? ''), form.get('confirmed') === 'on');
    refresh();
    return { ok: true, receipt, message: 'Modifica registrata una sola volta. Gli altri campi sono rimasti invariati.' };
  } catch (error) { return failure(error); }
}
export async function checkSelectedLeadEdit(_state: LeadEditUiState, form: FormData): Promise<LeadEditUiState> {
  const session = await requirePermission('lead.read');
  try {
    await origin();
    const receipt = await readLeadEditOutcomeByReference(prisma, session,
      { leadId: String(form.get('leadId') ?? ''), commandId: String(form.get('commandId') ?? '') });
    return receipt ? { ok: true, receipt, message: 'Modifica registrata. Puoi ricaricare i dati correnti.' }
      : { ok: false, uncertain: true, message: 'Ricevuta non disponibile: non avviare una nuova modifica finché l’esito non è riconciliato.' };
  } catch (error) { return failure(error); }
}
export async function prepareLeadEditingAccess(_state: LeadEditManagementState, form: FormData): Promise<LeadEditManagementState> {
  const session = await requirePermission('lead.read');
  try {
    await origin();
    const preview = await previewLeadEditingSelection(prisma, session, input(form, 'selection'));
    return { ok: true, message: 'Anteprima pronta. Nessun permesso di modifica è stato concesso.', preview };
  } catch (error) { return failure(error); }
}
export async function confirmLeadEditingAccess(_state: LeadEditManagementState, form: FormData): Promise<LeadEditManagementState> {
  const session = await requirePermission('lead.write');
  await requireEnforcedPrivilegedMutation(session, 'SELECTIVE_LEAD_EDIT_CONFIRM');
  try {
    if (form.get('confirmed') !== 'on') throw new LeadEditError('DENIED');
    const receipt = await confirmLeadEditingSelection(prisma, session, input(form, 'selection'),
      String(form.get('token') ?? ''), await credentials());
    refresh();
    return { ok: true, receipt, message: 'Permessi di modifica registrati per i soli campi confermati.' };
  } catch (error) { return failure(error); }
}
export async function revokeLeadEditingAccess(_state: LeadEditManagementState, form: FormData): Promise<LeadEditManagementState> {
  const session = await requirePermission('lead.write');
  await requireEnforcedPrivilegedMutation(session, 'SELECTIVE_LEAD_EDIT_REVOKE');
  try {
    if (form.get('confirmed') !== 'on') throw new LeadEditError('DENIED');
    const receipt = await revokeLeadEditing(prisma, session, { grantId: String(form.get('grantId') ?? ''),
      revision: Number(form.get('revision')), commandId: String(form.get('commandId') ?? '') }, await credentials());
    refresh();
    return { ok: true, receipt, message: 'Modifica revocata. La selezione di lettura mantiene le proprie condizioni.' };
  } catch (error) { return failure(error); }
}
export async function checkLeadEditingDecision(_state: LeadEditManagementState, form: FormData): Promise<LeadEditManagementState> {
  const session = await requirePermission('lead.read');
  try {
    await origin();
    const receipt = await readLeadEditingDecision(prisma, session, String(form.get('commandId') ?? ''));
    return receipt ? { ok: true, receipt,
      message: `Operazione registrata: ${receipt.operation === 'GRANT' ? 'abilitazione' : 'revoca'}, revisione ${receipt.revision}. Ricarica lo stato corrente.` }
      : { ok: false, uncertain: true, message: 'Ricevuta non disponibile. Non ripetere l’operazione prima di averne riconciliato l’esito.' };
  } catch (error) { return failure(error); }
}
