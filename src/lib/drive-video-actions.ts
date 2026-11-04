'use server';
import { unstable_rethrow } from 'next/navigation';
import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requireSession } from './auth';
import { prisma } from './prisma';
import { assertTechnicalServerAction } from './technical-server-guards';
import { loadActivePrivilegedStepUpKey } from './application-key-registry';
import { PrivilegedAdmissionRequired, privilegedStepUpCookieName, requireEnforcedPrivilegedMutation } from './privileged-access';
import { VideoLibraryError } from './video-library';
import { previewDriveVideo, confirmDriveVideo, settleDriveVideo } from './drive-video-library';

async function proof() {
  const key = await loadActivePrivilegedStepUpKey(prisma);
  if (!key) throw new VideoLibraryError('DENIED');
  const store = await cookies();
  return { key, sessionToken: store.get(process.env.AUTH_COOKIE_NAME ?? 'fai_crm_session')?.value ?? '',
    stepUpToken: store.get(privilegedStepUpCookieName)?.value ?? '' };
}
function failure(error: unknown) {
  if (error instanceof z.ZodError) return 'Controlla il link del file Google Drive, il titolo, l’account assistenza, le persone e la scadenza.';
  if (error instanceof VideoLibraryError && error.code === 'CONTENT_REVIEW_REQUIRED') return 'Sono selezionati tecnici: conferma la verifica del contenuto del video, del titolo e della descrizione.';
  if (error instanceof VideoLibraryError && error.code === 'STALE') return 'Scheda, file o destinatari cambiati. Verifica l’esito e riapri la scheda corrente. Una sostituzione del link richiede prima una bozza privata.';
  return 'Operazione non confermata. Conserva le scelte e verifica l’esito prima di un nuovo tentativo.';
}
export async function previewDriveVideoAction(command: unknown) {
  await assertTechnicalServerAction('drive-video-actions:previewDriveVideoAction');
  const session = await requireSession();
  try { return { ok: true as const, value: await previewDriveVideo(prisma, session, command) }; }
  catch (error) { unstable_rethrow(error); return { ok: false as const, message: failure(error) }; }
}
export async function confirmDriveVideoAction(command: unknown, token: string) {
  await assertTechnicalServerAction('drive-video-actions:confirmDriveVideoAction');
  const session = await requireSession();
  try {
    await requireEnforcedPrivilegedMutation(session, 'VIDEO_LIBRARY_MANAGE', { inline: true });
    const value = await confirmDriveVideo(prisma, session, command, token, await proof());
    revalidatePath('/videos', 'layout'); return { ok: true as const, value };
  } catch (error) {
    if (error instanceof PrivilegedAdmissionRequired) {
      try {
        const value = await settleDriveVideo(prisma, session, command, token);
        if (value.confirmed) return { ok: true as const, value };
        return { ok: false as const, closed: true, stepUpRequired: true,
          message: 'Tentativo chiuso senza modifica. Conferma l’identità qui e prepara un nuovo riepilogo: le scelte sono conservate.' };
      } catch (settlementError) { unstable_rethrow(settlementError); return { ok: false as const, message: failure(settlementError) }; }
    }
    unstable_rethrow(error); return { ok: false as const, message: failure(error) };
  }
}
export async function verifyDriveVideoAction(command: unknown, token: string) {
  await assertTechnicalServerAction('drive-video-actions:verifyDriveVideoAction');
  const session = await requireSession();
  try { return { ok: true as const, value: await settleDriveVideo(prisma, session, command, token) }; }
  catch (error) { unstable_rethrow(error); return { ok: false as const, message: failure(error) }; }
}
