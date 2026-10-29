'use server';

import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { ZodError } from 'zod';
import { requirePermission } from './auth';
import { prisma } from './prisma';
import { loadActivePrivilegedStepUpKey } from './application-key-registry';
import { PrivilegedAdmissionRequired, requireEnforcedPrivilegedMutation, privilegedStepUpCookieName } from './privileged-access';
import { confirmLeadSharing, previewLeadSharing, revokeLeadSharing, readLeadSharingReceipt, LeadSharingError } from './selective-lead-access';

export type LeadSharingState = { ok: boolean; message: string; stepUpRequired?: boolean; uncertain?: boolean;
  preview?: Awaited<ReturnType<typeof previewLeadSharing>>;
  receipt?: NonNullable<Awaited<ReturnType<typeof readLeadSharingReceipt>>> };
function failure(error: unknown): LeadSharingState {
  if (error instanceof PrivilegedAdmissionRequired) return error.formState;
  if (error instanceof ZodError) return { ok: false, message: 'Selezione non valida. Prepara una nuova anteprima.' };
  if (error instanceof LeadSharingError) return { ok: false, message: error.code === 'STALE'
    ? 'Dati, destinatario o permessi cambiati. Ricarica la scheda e prepara una nuova anteprima.'
    : 'Operazione non consentita: verifica sessione e abilitazione personale.' };
  return { ok: false, uncertain: true, message: 'Esito non confermato. Verifica la ricevuta prima di una nuova operazione.' };
}
async function credentials() {
  const store = await cookies(), key = await loadActivePrivilegedStepUpKey(prisma);
  if (!key) throw new LeadSharingError('UNAVAILABLE');
  return { key, sessionToken: store.get(process.env.AUTH_COOKIE_NAME ?? 'fai_crm_session')?.value ?? '',
    stepUpToken: store.get(privilegedStepUpCookieName)?.value ?? '' };
}
function refresh() {
  for (const path of ['/leads', '/shared-leads', '/dashboard', '/search', '/notifications', '/communications']) revalidatePath(path);
}
export async function prepareLeadSharing(_previous: LeadSharingState, form: FormData): Promise<LeadSharingState> {
  const session = await requirePermission('lead.read');
  try {
    const preview = await previewLeadSharing(prisma, session, JSON.parse(String(form.get('selection') ?? '')));
    return { ok: true, message: 'Anteprima preparata. Nessun accesso è stato concesso.', preview };
  } catch (error) { return failure(error); }
}
export async function confirmLeadSharingAction(_previous: LeadSharingState, form: FormData): Promise<LeadSharingState> {
  const session = await requirePermission('lead.write');
  try {
    await requireEnforcedPrivilegedMutation(session, 'SELECTIVE_LEAD_ACCESS_CONFIRM', { inline: true });
    if (form.get('confirmed') !== 'on') throw new LeadSharingError('DENIED');
    const receipt = await confirmLeadSharing(prisma, session, JSON.parse(String(form.get('selection') ?? '')),
      String(form.get('token') ?? ''), await credentials());
    refresh();
    return { ok: true, message: 'Accesso confermato: la persona può leggere soltanto i campi scelti.', receipt };
  } catch (error) { return failure(error); }
}
export async function revokeLeadSharingAction(_previous: LeadSharingState, form: FormData): Promise<LeadSharingState> {
  const session = await requirePermission('lead.write');
  try {
    await requireEnforcedPrivilegedMutation(session, 'SELECTIVE_LEAD_ACCESS_REVOKE', { inline: true });
    if (form.get('confirmed') !== 'on') throw new LeadSharingError('DENIED');
    const receipt = await revokeLeadSharing(prisma, session, { grantId: String(form.get('grantId') ?? ''),
      revision: Number(form.get('revision')), commandId: String(form.get('commandId') ?? '') }, await credentials());
    refresh();
    return { ok: true, message: 'Accesso revocato. I permessi più ampi precedenti restano disattivati per questo lead.', receipt };
  } catch (error) { return failure(error); }
}
export async function checkLeadSharingReceipt(_previous: LeadSharingState, form: FormData): Promise<LeadSharingState> {
  const session = await requirePermission('lead.read');
  try {
    const receipt = await readLeadSharingReceipt(prisma, session, String(form.get('commandId') ?? ''));
    return receipt ? { ok: true, receipt, message: `Operazione registrata, revisione ${receipt.revision}. Ricarica lo stato corrente.` }
      : { ok: false, uncertain: true, message: 'Ricevuta non ancora disponibile. Ricarica e verifica lo stato prima di riprovare.' };
  } catch (error) { return failure(error); }
}
