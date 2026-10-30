'use server';

import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { ZodError } from 'zod';
import { requirePermission } from './auth';
import { prisma } from './prisma';
import { loadActivePrivilegedStepUpKey } from './application-key-registry';
import { PrivilegedAdmissionRequired, requireEnforcedPrivilegedMutation, privilegedStepUpCookieName } from './privileged-access';
import { confirmPracticeSharing, previewPracticeSharing, revokePracticeSharing, readPracticeSharingReceipt, PracticeSharingError } from './selective-practice-access';

export type PracticeSharingState = { ok: boolean; message: string; stepUpRequired?: boolean; uncertain?: boolean;
  preview?: Awaited<ReturnType<typeof previewPracticeSharing>>;
  receipt?: NonNullable<Awaited<ReturnType<typeof readPracticeSharingReceipt>>> };
function failure(error: unknown): PracticeSharingState {
  if (error instanceof PrivilegedAdmissionRequired) return error.formState;
  if (error instanceof ZodError) return { ok: false, message: 'Selezione non valida. Prepara una nuova anteprima.' };
  if (error instanceof PracticeSharingError) return { ok: false, message: error.code === 'STALE'
    ? 'Dati, destinatario o permessi cambiati. Ricarica la scheda e prepara una nuova anteprima.'
    : 'Operazione non consentita: verifica sessione e abilitazione personale.' };
  return { ok: false, uncertain: true, message: 'Esito non confermato. Verifica la ricevuta prima di una nuova operazione.' };
}
async function credentials() {
  const store = await cookies(), key = await loadActivePrivilegedStepUpKey(prisma);
  if (!key) throw new PracticeSharingError('UNAVAILABLE');
  return { key, sessionToken: store.get(process.env.AUTH_COOKIE_NAME ?? 'fai_crm_session')?.value ?? '',
    stepUpToken: store.get(privilegedStepUpCookieName)?.value ?? '' };
}
function refresh() {
  for (const path of ['/technical-office/practices', '/shared-practices', '/dashboard', '/search', '/notifications', '/communications']) revalidatePath(path);
}
export async function preparePracticeSharing(_previous: PracticeSharingState, form: FormData): Promise<PracticeSharingState> {
  const session = await requirePermission('technical.read');
  try {
    const preview = await previewPracticeSharing(prisma, session, JSON.parse(String(form.get('selection') ?? '')));
    return { ok: true, message: 'Anteprima preparata. Nessun accesso è stato concesso.', preview };
  } catch (error) { return failure(error); }
}
export async function confirmPracticeSharingAction(_previous: PracticeSharingState, form: FormData): Promise<PracticeSharingState> {
  const session = await requirePermission('technical.write');
  try {
    await requireEnforcedPrivilegedMutation(session, 'SELECTIVE_PRACTICE_ACCESS_CONFIRM', { inline: true });
    if (form.get('confirmed') !== 'on') throw new PracticeSharingError('DENIED');
    const receipt = await confirmPracticeSharing(prisma, session, JSON.parse(String(form.get('selection') ?? '')),
      String(form.get('token') ?? ''), await credentials());
    refresh();
    return { ok: true, message: 'Accesso confermato: la persona può consultare i campi e le versioni scelti per questa pratica.', receipt };
  } catch (error) { return failure(error); }
}
export async function revokePracticeSharingAction(_previous: PracticeSharingState, form: FormData): Promise<PracticeSharingState> {
  const session = await requirePermission('technical.write');
  try {
    await requireEnforcedPrivilegedMutation(session, 'SELECTIVE_PRACTICE_ACCESS_REVOKE', { inline: true });
    if (form.get('confirmed') !== 'on') throw new PracticeSharingError('DENIED');
    const receipt = await revokePracticeSharing(prisma, session, { grantId: String(form.get('grantId') ?? ''),
      revision: Number(form.get('revision')), commandId: String(form.get('commandId') ?? '') }, await credentials());
    refresh();
    return { ok: true, message: 'Accesso revocato. I permessi più ampi precedenti restano disattivati per questa pratica.', receipt };
  } catch (error) { return failure(error); }
}
export async function checkPracticeSharingReceipt(_previous: PracticeSharingState, form: FormData): Promise<PracticeSharingState> {
  const session = await requirePermission('technical.read');
  try {
    const receipt = await readPracticeSharingReceipt(prisma, session, String(form.get('commandId') ?? ''), String(form.get('practiceId') ?? ''));
    return receipt ? { ok: true, receipt, message: `Operazione registrata, revisione ${receipt.revision}. Ricarica lo stato corrente.` }
      : { ok: false, uncertain: true, message: 'Ricevuta non ancora disponibile. Ricarica e verifica lo stato prima di riprovare.' };
  } catch (error) { return failure(error); }
}
