'use server';

import { cookies, headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { ZodError } from 'zod';
import { requireSession } from './auth';
import { prisma } from './prisma';
import { isAllowedMutationOrigin } from './application-security-policy';
import { loadActivePrivilegedStepUpKey } from './application-key-registry';
import { privilegedStepUpCookieName, requireEnforcedPrivilegedMutation, PrivilegedAdmissionRequired } from './privileged-access';
import { previewPaymentCollection, confirmPaymentCollection, readPaymentCollectionReceipt } from './payment-collection';
import { PaymentCollectionError } from './payment-collection-contract';
import { RecordUpdateError } from './record-update-contract';
import { SerializableConflictError } from './serializable';
import { ProjectUnavailableError } from './project-lifecycle-lock';

async function actor() {
  const session = await requireSession(), h = await headers();
  if (!isAllowedMutationOrigin({ origin: h.get('origin'), secFetchSite: h.get('sec-fetch-site'),
    configuredOrigin: process.env.APP_ORIGIN ?? process.env.NEXT_PUBLIC_APP_URL })) throw new PaymentCollectionError('DENIED');
  return session;
}
function failure(error: unknown) {
  const certain = error instanceof ZodError || error instanceof PaymentCollectionError || error instanceof RecordUpdateError
    || error instanceof SerializableConflictError || error instanceof ProjectUnavailableError;
  const message = error instanceof PaymentCollectionError && error.code === 'CLOSED'
    ? 'Il pagamento è già registrato, collegato o non disponibile per una nuova conferma. Verifica l’esito precedente; non creare una rata duplicata.'
    : error instanceof PaymentCollectionError && error.code === 'DOCUMENT'
      ? 'La prova non è disponibile nella versione verificata e nel contesto richiesti. Controlla il documento nel fascicolo.'
      : certain ? 'Dati o autorizzazioni cambiati. Riapri il modulo e verifica la data effettiva, il contratto e il documento.'
        : 'Esito non confermato. Usa «Verifica esito» prima di ripetere la registrazione.';
  return { ok: false as const, uncertain: !certain, message };
}
export async function previewPaymentCollectionAction(raw: unknown) {
  const session = await actor();
  try { return { ok: true as const, preview: await previewPaymentCollection(prisma, session, raw) }; }
  catch (error) { return failure(error); }
}
export async function confirmPaymentCollectionAction(raw: unknown, digest: string) {
  const session = await actor();
  try {
    await requireEnforcedPrivilegedMutation(session, 'PAYMENT_COLLECTION_DECLARE', { inline: true });
    const key = await loadActivePrivilegedStepUpKey(prisma);
    if (!key) throw new PaymentCollectionError('DENIED');
    const store = await cookies();
    const result = await confirmPaymentCollection(prisma, session, raw, digest, { key,
      sessionToken: store.get(process.env.AUTH_COOKIE_NAME ?? 'fai_crm_session')?.value ?? '',
      stepUpToken: store.get(privilegedStepUpCookieName)?.value ?? '' });
    for (const path of ['/payments', `/payments/${result.paymentId}/collection`, `/clients/${result.clientId}`,
      `/clients/${result.clientId}/services/new`]) revalidatePath(path);
    return { ok: true as const, result };
  } catch (error) {
    if (error instanceof PrivilegedAdmissionRequired) return { ok: false as const, uncertain: false, stepUpRequired: true, message: error.formState.message };
    return failure(error);
  }
}
export async function verifyPaymentCollectionAction(clientId: string, paymentId: string, commandId: string) {
  const session = await actor();
  try { return { ok: true as const, result: await readPaymentCollectionReceipt(prisma, session, clientId, paymentId, commandId) }; }
  catch { return { ok: false as const, message: 'Verifica non disponibile. Non ripetere la conferma finché l’esito non è chiarito.' }; }
}
