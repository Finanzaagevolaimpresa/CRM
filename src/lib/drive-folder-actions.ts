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
import { DriveFolderError } from './drive-folder-contract';
import { previewDriveFolder, confirmDriveFolder, settleDriveFolder } from './drive-folder-library';

async function proof() {
  const key = await loadActivePrivilegedStepUpKey(prisma);
  if (!key) throw new DriveFolderError('DENIED');
  const store = await cookies();
  return { key, sessionToken: store.get(process.env.AUTH_COOKIE_NAME ?? 'fai_crm_session')?.value ?? '',
    stepUpToken: store.get(privilegedStepUpCookieName)?.value ?? '' };
}
function failure(error: unknown) {
  if (error instanceof z.ZodError) return 'Controlla cliente, titolo, link https della cartella Drive, persone e scadenza.';
  if (error instanceof DriveFolderError) {
    if (error.code === 'CONTENT_REVIEW_REQUIRED') return 'Sono selezionati tecnici: verifica cartella, sottocartelle, titolo e nome cliente. Pagamenti, contratti firmati e note riservate non possono essere esposti.';
    if (error.code === 'DUPLICATE') return 'Questa cartella ha già un riferimento CRM, anche se disabilitato. Cercalo nella gestione e modifica quello esistente.';
    if (error.code === 'CLIENT_UNAVAILABLE') return 'Il cliente non è disponibile o è sospeso. Verifica la scheda cliente; nessuna cartella è stata creata.';
    if (error.code === 'RECIPIENT_UNAVAILABLE') return 'Seleziona almeno una persona disponibile per l’attivazione. Abilita «Aprire Fascicoli Drive» nella sua scheda account prima di selezionarla; elimina eventuali destinatari non più disponibili.';
    if (error.code === 'STALE') return 'Riferimento, cliente o destinatari cambiati. Riapri la scheda corrente. Per sostituire link o cliente salva prima una bozza privata.';
  }
  return 'Operazione non confermata. Le scelte sono conservate: verifica l’esito prima di un nuovo tentativo.';
}
function refresh() { revalidatePath('/drive-folders', 'layout'); revalidatePath('/clients', 'layout'); revalidatePath('/shared-clients', 'layout'); }
export async function previewDriveFolderAction(command: unknown) {
  await assertTechnicalServerAction('drive-folder-actions:previewDriveFolderAction');
  const session = await requireSession();
  try { return { ok: true as const, value: await previewDriveFolder(prisma, session, command) }; }
  catch (error) { unstable_rethrow(error); return { ok: false as const, message: failure(error) }; }
}
export async function confirmDriveFolderAction(command: unknown, token: string) {
  await assertTechnicalServerAction('drive-folder-actions:confirmDriveFolderAction');
  const session = await requireSession();
  try {
    await requireEnforcedPrivilegedMutation(session, 'DRIVE_FOLDER_MANAGE', { inline: true });
    const value = await confirmDriveFolder(prisma, session, command, token, await proof());
    refresh(); return { ok: true as const, value };
  } catch (error) {
    if (error instanceof PrivilegedAdmissionRequired) {
      try {
        const value = await settleDriveFolder(prisma, session, command, token);
        if (value.confirmed) { refresh(); return { ok: true as const, value }; }
        return { ok: false as const, closed: true, stepUpRequired: true,
          message: 'Tentativo chiuso senza modifica. Conferma l’identità qui e prepara un nuovo riepilogo: le scelte sono conservate.' };
      } catch (settlementError) { unstable_rethrow(settlementError); return { ok: false as const, message: failure(settlementError) }; }
    }
    unstable_rethrow(error); return { ok: false as const, message: failure(error) };
  }
}
export async function verifyDriveFolderAction(command: unknown, token: string) {
  await assertTechnicalServerAction('drive-folder-actions:verifyDriveFolderAction');
  const session = await requireSession();
  try { const value = await settleDriveFolder(prisma, session, command, token); refresh(); return { ok: true as const, value }; }
  catch (error) { unstable_rethrow(error); return { ok: false as const, message: failure(error) }; }
}
