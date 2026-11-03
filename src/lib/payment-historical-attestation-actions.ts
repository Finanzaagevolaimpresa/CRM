'use server';
import { assertTechnicalServerAction } from './technical-server-guards';
import { cookies, headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { ZodError } from 'zod';
import { requireSession } from './auth';
import { prisma } from './prisma';
import { isAllowedMutationOrigin } from './application-security-policy';
import { loadActivePrivilegedStepUpKey } from './application-key-registry';
import { privilegedStepUpCookieName, requireEnforcedPrivilegedMutation, PrivilegedAdmissionRequired } from './privileged-access';
import { previewHistoricalPayment, confirmHistoricalPayment, readHistoricalPaymentReceipt } from './payment-historical-attestation';
import { HistoricalPaymentError } from './payment-historical-attestation-contract';
import { PaymentCollectionError } from './payment-collection-contract';
import { RecordUpdateError } from './record-update-contract';
import { SerializableConflictError } from './serializable';
import { ProjectUnavailableError } from './project-lifecycle-lock';

async function actor() {
  const session = await requireSession(), h = await headers();
  if (session.role !== 'admin' || !isAllowedMutationOrigin({ origin: h.get('origin'), secFetchSite: h.get('sec-fetch-site'),
    configuredOrigin: process.env.APP_ORIGIN ?? process.env.NEXT_PUBLIC_APP_URL })) throw new HistoricalPaymentError('DENIED');
  return session;
}
function failure(error: unknown) {
  const certain = error instanceof ZodError || error instanceof HistoricalPaymentError || error instanceof PaymentCollectionError
    || error instanceof RecordUpdateError || error instanceof SerializableConflictError || error instanceof ProjectUnavailableError;
  const message = error instanceof HistoricalPaymentError && error.code === 'EXPIRED'
    ? 'Il riepilogo è scaduto. I dati restano nel modulo: controlla un nuovo riepilogo prima di confermare.'
    : certain ? 'La rettifica non è stata registrata: verifica dati, stato corrente e autorizzazioni. Gli importi non vengono modificati.'
      : 'Esito non confermato. Usa Verifica esito sullo stesso riferimento prima di una nuova registrazione.';
  return { ok: false as const, uncertain: !certain, message };
}
export async function previewHistoricalPaymentAction(raw: unknown) {
  await assertTechnicalServerAction('payment-historical-attestation-actions:previewHistoricalPaymentAction');
  try { return { ok: true as const, preview: await previewHistoricalPayment(prisma, await actor(), raw) }; }
  catch (error) { return failure(error); }
}
export async function confirmHistoricalPaymentAction(raw: unknown, digest: string) {
  await assertTechnicalServerAction('payment-historical-attestation-actions:confirmHistoricalPaymentAction');
  try {
    const session = await actor();
    await requireEnforcedPrivilegedMutation(session, 'PAYMENT_HISTORICAL_ATTESTATION', { inline: true });
    const key = await loadActivePrivilegedStepUpKey(prisma);
    if (!key) throw new HistoricalPaymentError('DENIED');
    const store = await cookies();
    const result = await confirmHistoricalPayment(prisma, session, raw, digest, { key,
      sessionToken: store.get(process.env.AUTH_COOKIE_NAME ?? 'fai_crm_session')?.value ?? '',
      stepUpToken: store.get(privilegedStepUpCookieName)?.value ?? '' });
    for (const path of ['/payments', '/dashboard', '/customer-progress',
      `/payments/${result.paymentId}/historical-attestation`, `/payments/${result.paymentId}/collection`,
      `/admin/records/Payment/${result.paymentId}`, `/clients/${result.clientId}`]) revalidatePath(path);
    return { ok: true as const, result };
  } catch (error) {
    if (error instanceof PrivilegedAdmissionRequired) return { ok: false as const, uncertain: false,
      stepUpRequired: true, message: error.formState.message };
    return failure(error);
  }
}
export async function verifyHistoricalPaymentAction(clientId: string, paymentId: string, commandId: string) {
  await assertTechnicalServerAction('payment-historical-attestation-actions:verifyHistoricalPaymentAction');
  try { return { ok: true as const, result: await readHistoricalPaymentReceipt(prisma, await actor(), clientId, paymentId, commandId) }; }
  catch { return { ok: false as const, message: 'Esito non verificabile. Conserva il riferimento e ripeti soltanto la verifica.' }; }
}
