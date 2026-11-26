'use server';
import { cookies } from 'next/headers';
import { redirect, unstable_rethrow } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { ZodError } from 'zod';
import { requireSession } from './auth';
import { prisma } from './prisma';
import { assertTechnicalServerAction } from './technical-server-guards';
import { loadActivePrivilegedStepUpKey } from './application-key-registry';
import { PrivilegedAdmissionRequired, privilegedStepUpCookieName, requireEnforcedPrivilegedMutation } from './privileged-access';
import { documentFields, OperationalDocumentError } from './operational-document-contract';
import { confirmOperationalDocument, createOperationalDocument, createOperationalProforma, saveOperationalTemplate } from './operational-documents';

type FormState = { error: string | null; stepUpRequired?: boolean };
function failure(error: unknown): FormState {
  unstable_rethrow(error);
  if (error instanceof PrivilegedAdmissionRequired) return { error: error.formState.message, stepUpRequired: error.status === 'required' };
  if (error instanceof ZodError) return { error: 'Verifica i campi del modulo. Nessuna conferma registrata.' };
  if (error instanceof OperationalDocumentError) return { error: {
    DENIED: 'Documento non disponibile nel tuo perimetro attuale. Verifica assegnazione e sessione.',
    STALE: 'Modello o dati di partenza cambiati. Ricarica l’anteprima prima di generare una nuova bozza.',
    MISSING: 'Completa i dati mancanti e conferma le condizioni sul caso prima di proseguire.',
    CONFLICT: 'Scegli esplicitamente il dato da utilizzare per ogni conflitto.',
    TEMPLATE: 'Verifica i campi del modello e conferma il testo autorizzato prima della pubblicazione.',
    UNCONFIRMED: 'Conferma prima il contenuto del contratto.', INVALID_AMOUNT: 'Imponibile, IVA e totale non sono coerenti.',
    PDF_CHARACTER: 'Un carattere non è supportato dal PDF. Il documento originale è conservato; verifica il testo prima di proseguire.',
  }[error.code] };
  return { error: 'Salvataggio non confermato. Riapri Documenti e Contratti e verifica il risultato prima di ripetere.' };
}
export async function saveOperationalTemplateAction(_previous: FormState, form: FormData): Promise<FormState> {
  await assertTechnicalServerAction('operational-document-actions:saveOperationalTemplateAction');
  const actor = await requireSession(); let result;
  try {
    await requireEnforcedPrivilegedMutation(actor, 'RECORD_UPDATE_MANAGE', { inline: true });
    const key = await loadActivePrivilegedStepUpKey(prisma); if (!key) throw new OperationalDocumentError('DENIED');
    const cookie = await cookies();
    result = await saveOperationalTemplate(prisma, actor, { commandId: form.get('commandId'), templateId: form.get('templateId'),
      expectedVersion: Number(form.get('expectedVersion')), operation: form.get('operation'), title: form.get('title'), kind: form.get('kind'),
      body: form.get('body'), required: form.getAll('required'), approved: form.get('approved') === 'on',
      ...(form.get('sourceTemplateId') ? { sourceTemplateId: form.get('sourceTemplateId') } : {}) }, { key,
      sessionToken: cookie.get(process.env.AUTH_COOKIE_NAME ?? 'fai_crm_session')?.value ?? '', stepUpToken: cookie.get(privilegedStepUpCookieName)?.value ?? '' });
  } catch (error) { return failure(error); }
  revalidatePath('/document-library', 'layout'); redirect('/document-library/templates/' + result.id);
}
export async function createOperationalDocumentAction(_previous: FormState, form: FormData): Promise<FormState> {
  await assertTechnicalServerAction('operational-document-actions:createOperationalDocumentAction');
  const actor = await requireSession(); let result;
  try {
    result = await createOperationalDocument(prisma, actor, { commandId: form.get('commandId'),
      context: form.get('leadId') ? { leadId: form.get('leadId') } : { clientId: form.get('clientId') },
      templateCommandId: form.get('templateCommandId'), ...(form.get('serviceRevisionId') ? { serviceRevisionId: form.get('serviceRevisionId') } : {}),
      ...(form.get('contractId') ? { contractId: form.get('contractId') } : {}), sourceHash: form.get('sourceHash'),
      choices: Object.fromEntries(documentFields.map(field => [field, String(form.get(field) ?? '')])), termsConfirmed: form.get('termsConfirmed') === 'on' });
  } catch (error) { return failure(error); }
  revalidatePath('/document-library', 'layout'); redirect('/document-library/' + result.id);
}
export async function confirmOperationalDocumentAction(_previous: FormState, form: FormData): Promise<FormState> {
  await assertTechnicalServerAction('operational-document-actions:confirmOperationalDocumentAction');
  const actor = await requireSession(); let result;
  try { result = await confirmOperationalDocument(prisma, actor, { commandId: form.get('commandId'), documentId: form.get('documentId'),
    contentHash: form.get('contentHash'), confirmed: form.get('confirmed') === 'on' }); }
  catch (error) { return failure(error); }
  revalidatePath('/document-library/' + result.id); redirect('/document-library/' + result.id);
}
export async function createOperationalProformaAction(_previous: FormState, form: FormData): Promise<FormState> {
  await assertTechnicalServerAction('operational-document-actions:createOperationalProformaAction');
  const actor = await requireSession(); let result;
  try { result = await createOperationalProforma(prisma, actor, { commandId: form.get('commandId'), documentId: form.get('documentId'),
    contentHash: form.get('contentHash'), templateCommandId: form.get('templateCommandId'), dueDate: form.get('dueDate'), confirmed: form.get('confirmed') === 'on' }); }
  catch (error) { return failure(error); }
  revalidatePath('/document-library', 'layout'); redirect('/document-library/' + result.id);
}
