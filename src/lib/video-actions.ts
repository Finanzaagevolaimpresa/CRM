'use server';
import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { unstable_rethrow } from 'next/navigation';
import { z } from 'zod';
import { requireSession } from './auth';
import { prisma } from './prisma';
import { loadActivePrivilegedStepUpKey } from './application-key-registry';
import { PrivilegedAdmissionRequired, privilegedStepUpCookieName, requireEnforcedPrivilegedMutation } from './privileged-access';
import { uploadVideo, previewVideo, confirmVideo, readVideoReceipt, settleVideoAttempt, searchVideoFiles, VideoLibraryError } from './video-library';

async function proof() {
  const key = await loadActivePrivilegedStepUpKey(prisma);
  if (!key) throw new VideoLibraryError('DENIED');
  const store = await cookies();
  return { key, sessionToken: store.get(process.env.AUTH_COOKIE_NAME ?? 'fai_crm_session')?.value ?? '',
    stepUpToken: store.get(privilegedStepUpCookieName)?.value ?? '' };
}
function failure(error: unknown) {
  if (error instanceof z.ZodError) return 'Controlla titolo, destinatari, scadenza e file.';
  if (error instanceof VideoLibraryError && error.code === 'QUOTA') return 'Quota della libreria esaurita. Nessun nuovo file è stato registrato.';
  if (error instanceof VideoLibraryError && error.code === 'STALE') return 'Video o permessi cambiati: prepara un nuovo riepilogo dalla scheda corrente.';
  return 'Operazione non confermata. Verifica l’esito prima di ripetere una modifica.';
}
export async function uploadVideoAction(form: FormData) {
  const session = await requireSession();
  try {
    await requireEnforcedPrivilegedMutation(session, 'VIDEO_LIBRARY_MANAGE', { inline: true });
    const file = form.get('file'), id = z.string().uuid().parse(form.get('commandId'));
    if (!(file instanceof File)) throw new VideoLibraryError('DENIED');
    const result = await uploadVideo(prisma, session, id, file, await proof());
    revalidatePath('/videos/manage');
    return { ok: true as const, videoId: result.videoId };
  } catch (error) {
    if (error instanceof PrivilegedAdmissionRequired) return { ok: false as const, stepUpRequired: true,
      message: 'Conferma la tua identità qui, poi riprendi lo stesso caricamento. Il file scelto è conservato.' };
    unstable_rethrow(error); return { ok: false as const, message: failure(error) };
  }
}
export async function verifyVideoUploadAction(id: string) {
  const session = await requireSession();
  try {
    const result = await readVideoReceipt(prisma, session, id);
    return result.confirmed && result.videoId ? { ok: true as const, videoId: result.videoId }
      : { ok: false as const, message: 'Caricamento non confermato. Mantieni il riferimento e verifica nuovamente prima di un nuovo caricamento.' };
  } catch (error) { return { ok: false as const, message: failure(error) }; }
}
export async function previewVideoAction(command: unknown) {
  const session = await requireSession();
  try { return { ok: true as const, value: await previewVideo(prisma, session, command) }; }
  catch (error) { return { ok: false as const, message: failure(error) }; }
}
export async function searchVideoFilesAction(query: string, offset: number) {
  const session = await requireSession();
  try { return { ok: true as const, value: await searchVideoFiles(prisma, session, query, offset) }; }
  catch (error) { unstable_rethrow(error); return { ok: false as const, message: failure(error) }; }
}
export async function confirmVideoAction(command: unknown, digest: string) {
  const session = await requireSession();
  try {
    await requireEnforcedPrivilegedMutation(session, 'VIDEO_LIBRARY_MANAGE', { inline: true });
    const value = await confirmVideo(prisma, session, command, digest, await proof());
    revalidatePath('/videos', 'layout');
    return { ok: true as const, value };
  } catch (error) {
    if (error instanceof PrivilegedAdmissionRequired) {
      try {
        const value = await settleVideoAttempt(prisma, session, command, digest);
        if (value.confirmed) return { ok: true as const, value };
        return { ok: false as const, stepUpRequired: true, closed: true,
          message: 'Tentativo chiuso senza modifica. Riconferma la tua identità qui e prepara un nuovo riepilogo: le scelte sono conservate.' };
      } catch (settlementError) { unstable_rethrow(settlementError); return { ok: false as const, message: failure(settlementError) }; }
    }
    unstable_rethrow(error); return { ok: false as const, message: failure(error) };
  }
}
export async function verifyVideoAction(command: unknown, digest: string) {
  const session = await requireSession();
  try { return { ok: true as const, value: await settleVideoAttempt(prisma, session, command, digest) }; }
  catch (error) { return { ok: false as const, message: failure(error) }; }
}
