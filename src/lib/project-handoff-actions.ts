'use server';
import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { ZodError } from 'zod';
import { requireSession } from './auth';
import { prisma } from './prisma';
import { loadActivePrivilegedStepUpKey } from './application-key-registry';
import { privilegedStepUpCookieName, requireEnforcedPrivilegedMutation, PrivilegedAdmissionRequired } from './privileged-access';
import { previewProjectHandoff, confirmProjectHandoff, readProjectHandoffReceipt } from './project-handoff';
import { ProjectHandoffError } from './project-handoff-contract';
import { RecordUpdateError } from './record-update-contract';
import { SerializableConflictError } from './serializable';
function failure(error: unknown) {
  const stepUpRequired = error instanceof PrivilegedAdmissionRequired;
  const definite = stepUpRequired || error instanceof ProjectHandoffError || error instanceof RecordUpdateError || error instanceof ZodError || error instanceof SerializableConflictError;
  const message = stepUpRequired ? 'Conferma la tua identità. Il riepilogo resta disponibile; la sua scadenza viene comunque verificata prima del salvataggio.' : error instanceof ProjectHandoffError && error.code === 'EXISTS'
    ? 'Una pratica è già collegata. Riapri il passaggio dal progetto per consultarla.'
    : definite ? 'Preparazione non salvata: dati, sessione o autorizzazioni non sono più validi. Riapri il progetto e prepara un nuovo riepilogo.'
      : 'Esito non confermato. Usa «Verifica esito»; non ripetere la creazione.';
  return { ok: false as const, definite, stepUpRequired, message };
}
export async function previewProjectHandoffAction(raw: unknown) {
  const session = await requireSession();
  try {
    const key = await loadActivePrivilegedStepUpKey(prisma);
    if (!key) throw new ProjectHandoffError('DENIED');
    return { ok: true as const, preview: await previewProjectHandoff(prisma, session, raw, key) };
  } catch (error) { return failure(error); }
}
export async function confirmProjectHandoffAction(raw: unknown, preview: unknown) {
  const session = await requireSession();
  try {
    await requireEnforcedPrivilegedMutation(session, 'R05_RESPONSIBILITY', { inline: true });
    const key = await loadActivePrivilegedStepUpKey(prisma);
    if (!key) throw new ProjectHandoffError('DENIED');
    const store = await cookies();
    const result = await confirmProjectHandoff(prisma, session, raw, preview, {
      key, sessionToken: store.get(process.env.AUTH_COOKIE_NAME ?? 'fai_crm_session')?.value ?? '',
      stepUpToken: store.get(privilegedStepUpCookieName)?.value ?? '',
    });
    revalidatePath('/projects'); revalidatePath('/technical-office'); revalidatePath('/technical-office/practices');
    return { ok: true as const, result };
  } catch (error) { return failure(error); }
}
export async function verifyProjectHandoffAction(projectId: string, commandId: string) {
  const session = await requireSession();
  try { return { ok: true as const, result: await readProjectHandoffReceipt(prisma, session, projectId, commandId) }; }
  catch { return { ok: false as const, message: 'Verifica non disponibile. Mantieni il riferimento e non ripetere la creazione.' }; }
}
