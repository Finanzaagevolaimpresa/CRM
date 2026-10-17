'use server';
import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { z, ZodError } from 'zod';
import { requireSession } from './auth';
import { prisma } from './prisma';
import { loadActivePrivilegedStepUpKey } from './application-key-registry';
import { privilegedStepUpCookieName, requireEnforcedPrivilegedMutation } from './privileged-access';
import { previewRecordUpdate, confirmRecordUpdate, readRecordUpdateReceipt } from './record-updates';
import { readRecordUpdate } from './record-update-delivery';
import { RecordUpdateError } from './record-update-contract';
import { updateCommandSchema } from './record-update-input';
import { SerializableConflictError } from './serializable';

function errorMessage(error: unknown) {
  if (error instanceof ZodError) return 'Controlla i campi, le date e la scelta dei destinatari.';
  if (error instanceof SerializableConflictError || (error instanceof RecordUpdateError && error.code === 'STALE'))
    return 'La scheda o le autorizzazioni sono cambiate. Ricarica la pagina e prepara un nuovo riepilogo.';
  if (error instanceof RecordUpdateError) return 'Scelta non disponibile: verifica persone attive, permessi, eventi e almeno un destinatario ammesso.';
  return 'Esito non confermato. Usa «Verifica esito» prima di preparare un altro salvataggio.';
}
export async function previewRecordUpdateAction(raw: unknown) {
  const session = await requireSession();
  try { return { ok: true as const, preview: await previewRecordUpdate(prisma, session, raw) }; }
  catch (error) { return { ok: false as const, message: errorMessage(error) }; }
}
export async function confirmRecordUpdateAction(raw: unknown, digest: string) {
  const session = await requireSession();
  await requireEnforcedPrivilegedMutation(session, 'RECORD_UPDATE_MANAGE');
  try {
    const key = await loadActivePrivilegedStepUpKey(prisma);
    if (!key) throw new RecordUpdateError('DENIED');
    const store = await cookies();
    const result = await confirmRecordUpdate(prisma, session, raw, digest, {
      key, sessionToken: store.get(process.env.AUTH_COOKIE_NAME ?? 'fai_crm_session')?.value ?? '',
      stepUpToken: store.get(privilegedStepUpCookieName)?.value ?? '',
    });
    for (const path of ['/notifications', '/notifications/updates', '/leads', '/clients', '/projects', '/technical-office/practices']) revalidatePath(path);
    const input = updateCommandSchema.parse(raw);
    const base = { LEAD: '/leads', CLIENT: '/clients', PROJECT: '/projects', PRACTICE: '/technical-office/practices' }[input.kind];
    revalidatePath(`${base}/${input.recordId}`);
    revalidatePath(`/record-updates/${input.kind}/${input.recordId}`);
    return { ok: true as const, result };
  } catch (error) { return { ok: false as const, message: errorMessage(error) }; }
}
export async function verifyRecordUpdateResultAction(commandId: string) {
  const session = await requireSession();
  try {
    z.string().uuid().parse(commandId);
    return { ok: true as const, result: await readRecordUpdateReceipt(prisma, session, commandId) };
  } catch { return { ok: false as const, message: 'Verifica non disponibile. Il salvataggio non va ripetuto finché l’esito non è chiarito.' }; }
}
export async function markRecordUpdateReadAction(form: FormData) {
  const session = await requireSession();
  const id = z.string().uuid().parse(form.get('id'));
  await readRecordUpdate(prisma, session, id, true);
  revalidatePath('/notifications'); revalidatePath('/notifications/updates');
  revalidatePath(`/notifications/updates/${id}`);
}
