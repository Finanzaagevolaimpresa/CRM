'use server';

import { revalidatePath } from 'next/cache';
import { requireSession } from './auth';
import { prisma } from './prisma';
import { PrivilegedAdmissionRequired, requireEnforcedPrivilegedMutation } from './privileged-access';
import { confirmSelectiveAccess, previewSelectiveAccess, revokeSelectiveAccess, SelectiveAccessError } from './selective-project-access';

export type SharingState = { ok: boolean; message: string; stepUpRequired?: boolean; preview?: Awaited<ReturnType<typeof previewSelectiveAccess>> };
function failure(error: unknown): SharingState {
  if (error instanceof PrivilegedAdmissionRequired) return error.formState;
  return { ok: false, message: error instanceof SelectiveAccessError && error.code === 'STALE'
    ? 'Dati o permessi cambiati. Riapri la selezione e prepara una nuova anteprima.'
    : 'Operazione non completata. Verifica selezione, sessione e abilitazione personale.' };
}
export async function prepareSharingPreview(_previous: SharingState, form: FormData): Promise<SharingState> {
  const session = await requireSession();
  try {
    const raw = JSON.parse(String(form.get('selection') ?? ''));
    const preview = await previewSelectiveAccess(prisma, session, raw);
    return { ok: true, message: 'Anteprima in sola lettura. Nessun accesso è stato concesso.', preview };
  } catch (error) { return failure(error); }
}
export async function confirmSharing(_previous: SharingState, form: FormData): Promise<SharingState> {
  const session = await requireSession();
  try {
    await requireEnforcedPrivilegedMutation(session, 'SELECTIVE_PROJECT_ACCESS_CONFIRM', { inline: true });
    if (form.get('personalConfirmation') !== 'on') throw new SelectiveAccessError('DENIED');
    await confirmSelectiveAccess(prisma, session, String(form.get('token') ?? ''), true);
    revalidatePath('/projects'); revalidatePath('/shared-projects');
    return { ok: true, message: 'Accesso selettivo confermato. La selezione è ora il limite del destinatario su questo progetto.' };
  } catch (error) { return failure(error); }
}
export async function revokeSharing(_previous: SharingState, form: FormData): Promise<SharingState> {
  const session = await requireSession();
  try {
    await requireEnforcedPrivilegedMutation(session, 'SELECTIVE_PROJECT_ACCESS_REVOKE', { inline: true });
    await revokeSelectiveAccess(prisma, session, String(form.get('grantId') ?? ''), Number(form.get('revision')), true);
    revalidatePath('/projects'); revalidatePath('/shared-projects');
    return { ok: true, message: 'Accesso revocato. Le nuove richieste sono bloccate; le copie già acquisite non sono recuperabili.' };
  } catch (error) { return failure(error); }
}
