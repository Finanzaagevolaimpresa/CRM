'use server';
import { cookies, headers } from 'next/headers';
import { ZodError } from 'zod';
import { requireSession } from './auth';
import { prisma } from './prisma';
import { isAllowedMutationOrigin } from './application-security-policy';
import { loadActivePrivilegedStepUpKey } from './application-key-registry';
import { privilegedStepUpCookieName, requireEnforcedPrivilegedMutation } from './privileged-access';
import { RecordUpdateError } from './record-update-contract';
import { SerializableConflictError } from './serializable';
import { previewRecordReminder } from './record-reminder-preview';
import { confirmRecordReminder, readRecordReminderReceipt } from './record-reminder-confirmation';
import { cancelRecordReminder, readRecordReminderCancellation } from './record-reminder-revocation';

async function credentials() {
  const h = await headers();
  if (!isAllowedMutationOrigin({ origin: h.get('origin'), secFetchSite: h.get('sec-fetch-site'),
    configuredOrigin: process.env.APP_ORIGIN ?? process.env.NEXT_PUBLIC_APP_URL })) throw new RecordUpdateError('DENIED');
  const key = await loadActivePrivilegedStepUpKey(prisma);
  if (!key) throw new RecordUpdateError('DENIED');
  const store = await cookies();
  return { key, sessionToken: store.get(process.env.AUTH_COOKIE_NAME ?? 'fai_crm_session')?.value ?? '',
    stepUpToken: store.get(privilegedStepUpCookieName)?.value ?? '' };
}
function failure(error: unknown) {
  const definite = error instanceof RecordUpdateError || error instanceof ZodError || error instanceof SerializableConflictError;
  return { ok: false as const, definite, message: definite
    ? 'Operazione non registrata: controlla conferma personale, scadenza, persone e permessi correnti. Prepara un nuovo riepilogo.'
    : 'Esito non confermato. Usa «Verifica esito» e conserva il riferimento; non ripetere il salvataggio.' };
}
// These pages are force-dynamic and admit the current source on each request.
// Do not re-render the submitting page before its action result is delivered:
// the retained decision in its URL would replace the live form with recovery
// and discard a confirmed result. Explicit navigation reads the current state.
export async function previewRecordReminderAction(raw: unknown) {
  const session = await requireSession();
  try { return { ok: true as const, preview: await previewRecordReminder(prisma, session, await credentials(), raw) }; }
  catch (error) { return failure(error); }
}
export async function confirmRecordReminderAction(raw: unknown,
  token: Parameters<typeof confirmRecordReminder>[4], confirmed: boolean) {
  const session = await requireSession();
  await requireEnforcedPrivilegedMutation(session, 'RECORD_UPDATE_MANAGE');
  try {
    const result = await confirmRecordReminder(prisma, session, await credentials(), raw, token, confirmed);
    return { ok: true as const, result };
  } catch (error) { return failure(error); }
}
export async function verifyRecordReminderAction(commandId: string) {
  const session = await requireSession();
  try { return { ok: true as const, result: await readRecordReminderReceipt(prisma, session, await credentials(), commandId) }; }
  catch { return { ok: false as const, message: 'Verifica non disponibile. Riconferma la tua identità e riprova soltanto la verifica.' }; }
}
export async function cancelRecordReminderAction(raw: unknown, confirmed: boolean) {
  const session = await requireSession();
  await requireEnforcedPrivilegedMutation(session, 'RECORD_UPDATE_MANAGE');
  try {
    const result = await cancelRecordReminder(prisma, session, await credentials(), raw, confirmed);
    return { ok: true as const, result };
  } catch (error) { return failure(error); }
}
export async function verifyRecordReminderCancellationAction(raw: unknown) {
  const session = await requireSession();
  try { return { ok: true as const, result: await readRecordReminderCancellation(prisma, session, await credentials(), raw) }; }
  catch { return { ok: false as const, message: 'Verifica non disponibile. Conserva il riferimento e non ripetere l’annullamento.' }; }
}
