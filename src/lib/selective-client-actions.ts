'use server';

import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { ZodError } from 'zod';
import { requirePermission } from './auth';
import { prisma } from './prisma';
import { loadActivePrivilegedStepUpKey } from './application-key-registry';
import { PrivilegedAdmissionRequired, requireEnforcedPrivilegedMutation, privilegedStepUpCookieName } from './privileged-access';
import { confirmClientSharing, previewClientSharing, revokeClientSharing, readClientSharingReceipt, ClientSharingError } from './selective-client-access';

export type ClientSharingState = { ok: boolean; message: string; stepUpRequired?: boolean; uncertain?: boolean;
  preview?: Awaited<ReturnType<typeof previewClientSharing>>;
  receipt?: NonNullable<Awaited<ReturnType<typeof readClientSharingReceipt>>> };
function failure(error: unknown): ClientSharingState {
  if (error instanceof PrivilegedAdmissionRequired) return error.formState;
  if (error instanceof ZodError) return { ok: false, message: 'Selezione non valida. Prepara una nuova anteprima.' };
  if (error instanceof ClientSharingError) return { ok: false, message: error.code === 'STALE'
    ? 'Dati, destinatario o permessi cambiati. Ricarica la scheda e prepara una nuova anteprima.'
    : 'Operazione non consentita: verifica sessione e abilitazione personale.' };
  return { ok: false, uncertain: true, message: 'Esito non confermato. Verifica la ricevuta prima di una nuova operazione.' };
}
async function credentials() {
  const store = await cookies(), key = await loadActivePrivilegedStepUpKey(prisma);
  if (!key) throw new ClientSharingError('UNAVAILABLE');
  return { key, sessionToken: store.get(process.env.AUTH_COOKIE_NAME ?? 'fai_crm_session')?.value ?? '',
    stepUpToken: store.get(privilegedStepUpCookieName)?.value ?? '' };
}
function refresh() {
  for (const path of ['/clients', '/shared-clients', '/dashboard', '/search', '/notifications', '/communications']) revalidatePath(path);
}
export async function prepareClientSharing(_previous: ClientSharingState, form: FormData): Promise<ClientSharingState> {
  const session = await requirePermission('client.read');
  try {
    const preview = await previewClientSharing(prisma, session, JSON.parse(String(form.get('selection') ?? '')));
    return { ok: true, message: 'Anteprima preparata. Nessun accesso è stato concesso.', preview };
  } catch (error) { return failure(error); }
}
export async function confirmClientSharingAction(_previous: ClientSharingState, form: FormData): Promise<ClientSharingState> {
  const session = await requirePermission('client.write');
  try {
    await requireEnforcedPrivilegedMutation(session, 'SELECTIVE_CLIENT_ACCESS_CONFIRM', { inline: true });
    if (form.get('confirmed') !== 'on') throw new ClientSharingError('DENIED');
    const receipt = await confirmClientSharing(prisma, session, JSON.parse(String(form.get('selection') ?? '')),
      String(form.get('token') ?? ''), await credentials());
    refresh();
    return { ok: true, message: 'Accesso confermato: la persona può leggere soltanto i campi e le versioni scelti.', receipt };
  } catch (error) { return failure(error); }
}
export async function revokeClientSharingAction(_previous: ClientSharingState, form: FormData): Promise<ClientSharingState> {
  const session = await requirePermission('client.write');
  try {
    await requireEnforcedPrivilegedMutation(session, 'SELECTIVE_CLIENT_ACCESS_REVOKE', { inline: true });
    if (form.get('confirmed') !== 'on') throw new ClientSharingError('DENIED');
    const receipt = await revokeClientSharing(prisma, session, { grantId: String(form.get('grantId') ?? ''),
      revision: Number(form.get('revision')), commandId: String(form.get('commandId') ?? '') }, await credentials());
    refresh();
    return { ok: true, message: 'Accesso revocato. I permessi più ampi precedenti restano disattivati per questo cliente.', receipt };
  } catch (error) { return failure(error); }
}
export async function checkClientSharingReceipt(_previous: ClientSharingState, form: FormData): Promise<ClientSharingState> {
  const session = await requirePermission('client.read');
  try {
    const receipt = await readClientSharingReceipt(prisma, session, String(form.get('commandId') ?? ''), String(form.get('clientId') ?? ''));
    return receipt ? { ok: true, receipt, message: `Operazione registrata, revisione ${receipt.revision}. Ricarica lo stato corrente.` }
      : { ok: false, uncertain: true, message: 'Ricevuta non ancora disponibile. Ricarica e verifica lo stato prima di riprovare.' };
  } catch (error) { return failure(error); }
}
