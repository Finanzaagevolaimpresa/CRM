'use server';
import { assertTechnicalServerAction } from '@/lib/technical-server-guards';
import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { createLead, updateLeadCommercial, convertLeadToClient, resolveLeadDuplicateCaseAction, initializeCommercialLeadInboxAction, claimCommercialLeadInboxAction, assignCommercialLeadInboxAction, unassignCommercialLeadInboxAction, recordCommercialLeadFirstResponseAction, closeCommercialLeadInboxAction, reopenCommercialLeadInboxAction, createCommercialOffer, updateCommercialOffer, createProject, registerDocument, createPreAnalysis, updatePreAnalysis, createDossier, createContract, registerPayment, runMockAgent, reviewAiOutput, approveAiOutput, updateClientServiceStatus, assignClientService, linkDocumentToService, uploadDocument, createDocumentChecklistItem, createStandardDocumentChecklist, updateDocumentChecklistItemStatus, linkDocumentToChecklistItem, unlinkDocumentFromChecklistItem, deactivateDocumentChecklistItem, createClientTask, updateClientTask, completeClientTask, updateClientServicePipeline, generateClientDossier, updateClientDossier, approveClientDossier, archiveClientDossier, runClientAiAgent, createClientDossierFromAiOutput, createTechnicalPractice, updateTechnicalPractice, updateTechnicalPracticeStatus, assignTechnicalPractice, archiveTechnicalPractice, createPracticeCommunicationDraft, updatePracticeCommunicationDraft, approvePracticeCommunicationDraft, markPracticeCommunicationAsUsed, archivePracticeCommunication } from './actions';
import { UserFacingActionError } from './action-errors';
import type { UploadResult } from './document-upload-contract';
export async function createLeadAndRedirect(form: FormData) {
  await assertTechnicalServerAction("form-actions:createLeadAndRedirect"); await createLead(form); revalidatePath('/leads'); revalidatePath('/leads/inbox'); redirect('/leads?created=1'); }
export async function updateLeadStatus(form: FormData) {
  await assertTechnicalServerAction("form-actions:updateLeadStatus"); await updateLeadCommercial(form); const id=String(form.get('id')||''); revalidatePath(`/leads/${id}`); revalidatePath('/leads'); revalidatePath('/dashboard'); }
export async function updateLeadCommercialAndRedirect(form: FormData) {
  await assertTechnicalServerAction("form-actions:updateLeadCommercialAndRedirect"); await updateLeadCommercial(form); const id=String(form.get('id')||''); revalidatePath(`/leads/${id}`); revalidatePath('/leads'); revalidatePath('/dashboard'); }
export async function resolveLeadDuplicateCaseAndRefresh(form: FormData) {
  await assertTechnicalServerAction("form-actions:resolveLeadDuplicateCaseAndRefresh"); await resolveLeadDuplicateCaseAction(form); revalidatePath('/leads/duplicates'); revalidatePath('/leads'); revalidatePath('/leads/inbox'); }
export async function convertLeadToClientAndRedirect(form: FormData) {
  await assertTechnicalServerAction("form-actions:convertLeadToClientAndRedirect"); const client = await convertLeadToClient(form); const id=String(form.get('id')||''); revalidatePath(`/leads/${id}`); revalidatePath('/leads'); revalidatePath('/leads/inbox'); revalidatePath('/clients'); revalidatePath('/dashboard'); redirect(`/clients/${client.id}`); }
async function revalidateCommercialLeadInbox(form: FormData) { const id=String(form.get('id')||''); revalidatePath(`/leads/${id}`); revalidatePath('/leads'); revalidatePath('/leads/inbox'); }
export async function initializeCommercialLeadInbox(form: FormData) {
  await assertTechnicalServerAction("form-actions:initializeCommercialLeadInbox"); await initializeCommercialLeadInboxAction(form); await revalidateCommercialLeadInbox(form); }
export async function claimCommercialLeadInbox(form: FormData) {
  await assertTechnicalServerAction("form-actions:claimCommercialLeadInbox"); await claimCommercialLeadInboxAction(form); await revalidateCommercialLeadInbox(form); }
export async function assignCommercialLeadInbox(form: FormData) {
  await assertTechnicalServerAction("form-actions:assignCommercialLeadInbox"); await assignCommercialLeadInboxAction(form); await revalidateCommercialLeadInbox(form); }
export async function unassignCommercialLeadInbox(form: FormData) {
  await assertTechnicalServerAction("form-actions:unassignCommercialLeadInbox"); await unassignCommercialLeadInboxAction(form); await revalidateCommercialLeadInbox(form); }
export async function recordCommercialLeadFirstResponse(form: FormData) {
  await assertTechnicalServerAction("form-actions:recordCommercialLeadFirstResponse"); await recordCommercialLeadFirstResponseAction(form); await revalidateCommercialLeadInbox(form); }
export async function closeCommercialLeadInbox(form: FormData) {
  await assertTechnicalServerAction("form-actions:closeCommercialLeadInbox"); await closeCommercialLeadInboxAction(form); await revalidateCommercialLeadInbox(form); }
export async function reopenCommercialLeadInbox(form: FormData) {
  await assertTechnicalServerAction("form-actions:reopenCommercialLeadInbox"); await reopenCommercialLeadInboxAction(form); await revalidateCommercialLeadInbox(form); }
export async function createCommercialOfferAndRedirect(form: FormData) {
  await assertTechnicalServerAction("form-actions:createCommercialOfferAndRedirect"); const offer = await createCommercialOffer(form); const leadId=String(form.get('leadId')||''); revalidatePath(`/leads/${leadId}`); revalidatePath('/leads'); revalidatePath('/dashboard'); redirect(`/commercial-offers/${offer.id}`); }
export async function updateCommercialOfferAndRefresh(form: FormData) {
  await assertTechnicalServerAction("form-actions:updateCommercialOfferAndRefresh"); const offer = await updateCommercialOffer(form); if (offer.leadId) revalidatePath(`/leads/${offer.leadId}`); revalidatePath(`/commercial-offers/${offer.id}`); revalidatePath('/dashboard'); }
export async function createProjectAndRedirect(form: FormData) {
  await assertTechnicalServerAction("form-actions:createProjectAndRedirect"); const project = await createProject(form); revalidatePath('/projects'); redirect(`/projects/${project.id}`); }
export async function registerDocumentAndRefresh(form: FormData) {
  await assertTechnicalServerAction("form-actions:registerDocumentAndRefresh"); await registerDocument(form); revalidatePath('/documents'); }
async function uploadErrorRedirectUrl(message: string, fallback = '/documents') {
  const referer = (await headers()).get('referer');
  const url = new URL(referer ?? fallback, 'http://localhost');
  url.searchParams.set('uploadError', message);
  return `${url.pathname}${url.search}${url.hash}`;
}
export async function uploadDocumentForBatch(form: FormData): Promise<UploadResult> {
  await assertTechnicalServerAction("form-actions:uploadDocumentForBatch");
  try {
    const document = await uploadDocument(form);
    revalidatePath('/documents');
    if (document.clientId) revalidatePath(`/clients/${document.clientId}`);
    return { ok: true };
  } catch (error) {
    if (error instanceof UserFacingActionError) return { ok: false, message: error.message };
    throw error;
  }
}
export async function uploadDocumentAndRefresh(form: FormData) {
  await assertTechnicalServerAction("form-actions:uploadDocumentAndRefresh");
  try {
    const document = await uploadDocument(form);
    revalidatePath('/documents');
    if (document.clientId) revalidatePath(`/clients/${document.clientId}`);
  } catch (error) {
    if (error instanceof UserFacingActionError) redirect(await uploadErrorRedirectUrl(error.message));
    throw error;
  }
}
export async function linkDocumentAndRefresh(form: FormData) {
  await assertTechnicalServerAction("form-actions:linkDocumentAndRefresh"); await linkDocumentToService(form); revalidatePath('/documents'); }
export async function createPreAnalysisAndRedirect(form: FormData) {
  await assertTechnicalServerAction("form-actions:createPreAnalysisAndRedirect"); const pre = await createPreAnalysis(form); revalidatePath('/preanalyses'); redirect(`/preanalyses/${pre.id}`); }
export type PreAnalysisFormState = { status: 'idle' | 'success' | 'error'; message?: string; version?: string; values?: Record<string, string> };
function actionMessage(error: unknown) {
  if (error instanceof UserFacingActionError) return error.message;
  if (error && typeof error === 'object' && 'issues' in error) return 'Controlla i campi: ogni testo deve essere valido e non superare la lunghezza consentita.';
  throw error;
}
export async function createManualPreAnalysis(_state: PreAnalysisFormState, form: FormData): Promise<PreAnalysisFormState> {
  await assertTechnicalServerAction("form-actions:createManualPreAnalysis");
  let pre;
  try { pre = await createPreAnalysis(form); }
  catch (error) { return { status: 'error', message: actionMessage(error) }; }
  revalidatePath('/preanalyses');
  revalidatePath(`/clients/${pre.clientId}`);
  revalidatePath(`/projects/${pre.projectId}`);
  redirect(`/preanalyses/${pre.id}?saved=created`);
}
export async function updateManualPreAnalysis(_state: PreAnalysisFormState, form: FormData): Promise<PreAnalysisFormState> {
  await assertTechnicalServerAction("form-actions:updateManualPreAnalysis");
  try {
    const pre = await updatePreAnalysis(form);
    revalidatePath('/preanalyses'); revalidatePath(`/preanalyses/${pre.id}`); revalidatePath(`/clients/${pre.clientId}`); revalidatePath(`/projects/${pre.projectId}`);
    return { status: 'success', message: 'Bozza interna salvata.', version: pre.updatedAt.toISOString() };
  } catch (error) { return { status: 'error', message: actionMessage(error), values: Object.fromEntries(['internalSummary', 'scenarioA', 'scenarioB', 'blockingConditions', 'requiredDocuments'].map((field) => [field, String(form.get(field) ?? '')])), version: String(form.get('version') ?? '') }; }
}
export async function createDossierAndRedirect(form: FormData) {
  await assertTechnicalServerAction("form-actions:createDossierAndRedirect"); const dossier = await createDossier(form); revalidatePath('/dossiers'); redirect(`/dossiers/${dossier.id}`); }
export async function createContractAndRefresh(form: FormData) {
  await assertTechnicalServerAction("form-actions:createContractAndRefresh"); await createContract(form); revalidatePath('/contracts'); }
export async function registerPaymentAndRefresh(form: FormData) {
  await assertTechnicalServerAction("form-actions:registerPaymentAndRefresh"); await registerPayment(form); revalidatePath('/payments'); }
export async function completeTask(form: FormData) {
  await assertTechnicalServerAction("form-actions:completeTask"); const task = await completeClientTask(form); revalidatePath('/tasks'); if (task.clientId) revalidatePath(`/clients/${task.clientId}`); revalidatePath('/dashboard'); }
export async function runMockAiAndRedirect(form: FormData) {
  await assertTechnicalServerAction("form-actions:runMockAiAndRedirect"); const agentCode=String(form.get('agentCode')||''); const prompt=String(form.get('prompt')||''); const requestKey=String(form.get('requestKey')||''); const supersedesRequestId=String(form.get('supersedesRequestId')||'') || undefined; const request=await runMockAgent(agentCode,{ prompt, source:'CRM interno FAI', humanReviewRequired:true },requestKey,supersedesRequestId); revalidatePath('/settings/ai-authorizations'); revalidatePath('/notifications'); revalidatePath('/dashboard'); redirect(`/settings/ai-authorizations/${request.id}`); }
export async function runClientAiAgentAndRedirect(form: FormData) {
  await assertTechnicalServerAction("form-actions:runClientAiAgentAndRedirect"); const request = await runClientAiAgent(form); if (request.clientId) revalidatePath(`/clients/${request.clientId}`); revalidatePath('/settings/ai-authorizations'); revalidatePath('/notifications'); revalidatePath('/dashboard'); redirect(`/settings/ai-authorizations/${request.id}`); }
export async function reviewAiOutputAndRefresh(form: FormData) {
  await assertTechnicalServerAction("form-actions:reviewAiOutputAndRefresh"); await reviewAiOutput(String(form.get('id')||'')); revalidatePath('/ai/outputs-to-review'); revalidatePath(`/ai/outputs/${String(form.get('id')||'')}`); }
export async function approveAiOutputAndRefresh(form: FormData) {
  await assertTechnicalServerAction("form-actions:approveAiOutputAndRefresh"); await approveAiOutput(String(form.get('id')||'')); revalidatePath('/ai/outputs-to-review'); }
export async function createClientDossierFromAiOutputAndRedirect(form: FormData) {
  await assertTechnicalServerAction("form-actions:createClientDossierFromAiOutputAndRedirect"); const dossier = await createClientDossierFromAiOutput(form); revalidatePath(`/clients/${dossier.clientId}`); revalidatePath(`/ai/outputs/${String(form.get('id') || '')}`); redirect(`/client-dossiers/${dossier.id}`); }
export async function updateServiceStatusAndRefresh(form: FormData) {
  await assertTechnicalServerAction("form-actions:updateServiceStatusAndRefresh"); await updateClientServiceStatus(String(form.get('id')||''), String(form.get('status')||'')); revalidatePath('/clients'); }
export async function assignServiceAndRefresh(form: FormData) {
  await assertTechnicalServerAction("form-actions:assignServiceAndRefresh"); await assignClientService(String(form.get('id')||''), String(form.get('assignedToId')||'')); revalidatePath('/clients'); revalidatePath('/dashboard'); }
export async function updateServicePipelineAndRefresh(form: FormData) {
  await assertTechnicalServerAction("form-actions:updateServicePipelineAndRefresh"); const service = await updateClientServicePipeline(form); revalidatePath(`/clients/${service.clientId}`); revalidatePath('/clients'); revalidatePath('/dashboard'); }

export async function createChecklistItemAndRefresh(form: FormData) {
  await assertTechnicalServerAction("form-actions:createChecklistItemAndRefresh"); const item = await createDocumentChecklistItem(form); revalidatePath(`/clients/${item.clientId}`); }
export async function createStandardChecklistAndRefresh(form: FormData) {
  await assertTechnicalServerAction("form-actions:createStandardChecklistAndRefresh"); await createStandardDocumentChecklist(form); revalidatePath(`/clients/${String(form.get('clientId') || '')}`); }
export async function updateChecklistItemStatusAndRefresh(form: FormData) {
  await assertTechnicalServerAction("form-actions:updateChecklistItemStatusAndRefresh"); const item = await updateDocumentChecklistItemStatus(form); revalidatePath(`/clients/${item.clientId}`); }
export async function linkChecklistItemDocumentAndRefresh(form: FormData) {
  await assertTechnicalServerAction("form-actions:linkChecklistItemDocumentAndRefresh"); const item = await linkDocumentToChecklistItem(form); revalidatePath(`/clients/${item.clientId}`); }
export async function unlinkChecklistItemDocumentAndRefresh(form: FormData) {
  await assertTechnicalServerAction("form-actions:unlinkChecklistItemDocumentAndRefresh"); const item = await unlinkDocumentFromChecklistItem(form); revalidatePath(`/clients/${item.clientId}`); }
export async function deactivateChecklistItemAndRefresh(form: FormData) {
  await assertTechnicalServerAction("form-actions:deactivateChecklistItemAndRefresh"); const item = await deactivateDocumentChecklistItem(form); revalidatePath(`/clients/${item.clientId}`); }

export async function createClientTaskAndRefresh(form: FormData) {
  await assertTechnicalServerAction("form-actions:createClientTaskAndRefresh"); const task = await createClientTask(form); revalidatePath(`/clients/${task.clientId}`); revalidatePath('/tasks'); revalidatePath('/dashboard'); }
export async function updateClientTaskAndRefresh(form: FormData) {
  await assertTechnicalServerAction("form-actions:updateClientTaskAndRefresh"); const task = await updateClientTask(form); if (task.clientId) revalidatePath(`/clients/${task.clientId}`); revalidatePath('/tasks'); revalidatePath('/dashboard'); }

export async function generateClientDossierAndRedirect(form: FormData) {
  await assertTechnicalServerAction("form-actions:generateClientDossierAndRedirect"); const dossier = await generateClientDossier(form); revalidatePath(`/clients/${dossier.clientId}`); revalidatePath('/dossiers'); redirect(`/client-dossiers/${dossier.id}`); }
export async function updateClientDossierAndRefresh(form: FormData) {
  await assertTechnicalServerAction("form-actions:updateClientDossierAndRefresh"); const dossier = await updateClientDossier(form); revalidatePath(`/clients/${dossier.clientId}`); revalidatePath(`/client-dossiers/${dossier.id}`); }
export async function approveClientDossierAndRefresh(form: FormData) {
  await assertTechnicalServerAction("form-actions:approveClientDossierAndRefresh"); const dossier = await approveClientDossier(form); revalidatePath(`/clients/${dossier.clientId}`); revalidatePath(`/client-dossiers/${dossier.id}`); }
export async function archiveClientDossierAndRefresh(form: FormData) {
  await assertTechnicalServerAction("form-actions:archiveClientDossierAndRefresh"); const dossier = await archiveClientDossier(form); revalidatePath(`/clients/${dossier.clientId}`); revalidatePath(`/client-dossiers/${dossier.id}`); }

export async function createTechnicalPracticeAndRedirect(form: FormData) {
  await assertTechnicalServerAction("form-actions:createTechnicalPracticeAndRedirect"); const practice = await createTechnicalPractice(form); revalidatePath('/technical-office'); revalidatePath('/technical-office/practices'); revalidatePath(`/clients/${practice.clientId}`); redirect(`/technical-office/practices/${practice.id}`); }
export async function updateTechnicalPracticeAndRefresh(form: FormData) {
  await assertTechnicalServerAction("form-actions:updateTechnicalPracticeAndRefresh"); const practice = await updateTechnicalPractice(form); revalidatePath(`/technical-office/practices/${practice.id}`); revalidatePath('/technical-office/practices'); revalidatePath(`/clients/${practice.clientId}`); }
export async function updateTechnicalPracticeStatusAndRefresh(form: FormData) {
  await assertTechnicalServerAction("form-actions:updateTechnicalPracticeStatusAndRefresh"); const practice = await updateTechnicalPracticeStatus(form); revalidatePath(`/technical-office/practices/${practice.id}`); revalidatePath('/technical-office'); revalidatePath('/technical-office/practices'); revalidatePath(`/clients/${practice.clientId}`); }
export async function assignTechnicalPracticeAndRefresh(form: FormData) {
  await assertTechnicalServerAction("form-actions:assignTechnicalPracticeAndRefresh"); const practice = await assignTechnicalPractice(form); revalidatePath(`/technical-office/practices/${practice.id}`); revalidatePath('/technical-office/practices'); revalidatePath(`/clients/${practice.clientId}`); }
export async function archiveTechnicalPracticeAndRefresh(form: FormData) {
  await assertTechnicalServerAction("form-actions:archiveTechnicalPracticeAndRefresh"); const practice = await archiveTechnicalPractice(form); revalidatePath('/technical-office'); revalidatePath('/technical-office/practices'); revalidatePath(`/clients/${practice.clientId}`); redirect('/technical-office/practices'); }


export async function createPracticeCommunicationDraftAndRefresh(form: FormData) {
  await assertTechnicalServerAction("form-actions:createPracticeCommunicationDraftAndRefresh"); const communication = await createPracticeCommunicationDraft(form); revalidatePath(`/technical-office/practices/${communication.technicalPracticeId}`); revalidatePath(`/clients/${communication.clientId}`); revalidatePath('/dashboard'); }
export async function updatePracticeCommunicationDraftAndRefresh(form: FormData) {
  await assertTechnicalServerAction("form-actions:updatePracticeCommunicationDraftAndRefresh"); const communication = await updatePracticeCommunicationDraft(form); revalidatePath(`/technical-office/practices/${communication.technicalPracticeId}`); revalidatePath(`/clients/${communication.clientId}`); revalidatePath('/dashboard'); }
export async function approvePracticeCommunicationDraftAndRefresh(form: FormData) {
  await assertTechnicalServerAction("form-actions:approvePracticeCommunicationDraftAndRefresh"); const communication = await approvePracticeCommunicationDraft(form); revalidatePath(`/technical-office/practices/${communication.technicalPracticeId}`); revalidatePath(`/clients/${communication.clientId}`); revalidatePath('/dashboard'); }
export async function markPracticeCommunicationAsUsedAndRefresh(form: FormData) {
  await assertTechnicalServerAction("form-actions:markPracticeCommunicationAsUsedAndRefresh"); const communication = await markPracticeCommunicationAsUsed(form); revalidatePath(`/technical-office/practices/${communication.technicalPracticeId}`); revalidatePath(`/clients/${communication.clientId}`); revalidatePath('/dashboard'); }
export async function archivePracticeCommunicationAndRefresh(form: FormData) {
  await assertTechnicalServerAction("form-actions:archivePracticeCommunicationAndRefresh"); const communication = await archivePracticeCommunication(form); revalidatePath(`/technical-office/practices/${communication.technicalPracticeId}`); revalidatePath(`/clients/${communication.clientId}`); revalidatePath('/dashboard'); }
