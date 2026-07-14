'use server';
import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { prisma } from './prisma';
import { requirePermission } from './auth';
import { createLead, updateLeadCommercial, convertLeadToClient, createCommercialOffer, updateCommercialOffer, createProject, registerDocument, createPreAnalysis, createDossier, createContract, registerPayment, runMockAgent, reviewAiOutput, approveAiOutput, updateClientServiceStatus, assignClientService, linkDocumentToService, uploadDocument, createDocumentChecklistItem, createStandardDocumentChecklist, updateDocumentChecklistItemStatus, linkDocumentToChecklistItem, unlinkDocumentFromChecklistItem, deactivateDocumentChecklistItem, createClientTask, updateClientTask, completeClientTask, updateClientServicePipeline, generateClientDossier, updateClientDossier, approveClientDossier, archiveClientDossier, runClientAiAgent, createClientDossierFromAiOutput, createTechnicalPractice, updateTechnicalPractice, updateTechnicalPracticeStatus, assignTechnicalPractice, archiveTechnicalPractice, createPracticeCommunicationDraft, updatePracticeCommunicationDraft, approvePracticeCommunicationDraft, markPracticeCommunicationAsUsed, archivePracticeCommunication } from './actions';
import { UserFacingActionError } from './action-errors';

async function audit(actorId: string, event: string, entityType: string, entityId?: string, after?: unknown) { await prisma.auditLog.create({ data: { actorId, event, entityType, entityId, after: after as object } }); }
export async function createLeadAndRedirect(form: FormData) { const lead = await createLead(form); revalidatePath('/leads'); redirect(`/leads/${lead.id}`); }
export async function updateLeadStatus(form: FormData) { await updateLeadCommercial(form); const id=String(form.get('id')||''); revalidatePath(`/leads/${id}`); revalidatePath('/leads'); revalidatePath('/dashboard'); }
export async function updateLeadCommercialAndRedirect(form: FormData) { await updateLeadCommercial(form); const id=String(form.get('id')||''); revalidatePath(`/leads/${id}`); revalidatePath('/leads'); revalidatePath('/dashboard'); }
export async function convertLeadToClientAndRedirect(form: FormData) { const client = await convertLeadToClient(form); const id=String(form.get('id')||''); revalidatePath(`/leads/${id}`); revalidatePath('/leads'); revalidatePath('/clients'); revalidatePath('/dashboard'); redirect(`/clients/${client.id}`); }
export async function createCommercialOfferAndRedirect(form: FormData) { const offer = await createCommercialOffer(form); const leadId=String(form.get('leadId')||''); revalidatePath(`/leads/${leadId}`); revalidatePath('/leads'); revalidatePath('/dashboard'); redirect(`/commercial-offers/${offer.id}`); }
export async function updateCommercialOfferAndRefresh(form: FormData) { const offer = await updateCommercialOffer(form); if (offer.leadId) revalidatePath(`/leads/${offer.leadId}`); revalidatePath(`/commercial-offers/${offer.id}`); revalidatePath('/dashboard'); }
export async function createProjectAndRedirect(form: FormData) { const project = await createProject(form); revalidatePath('/projects'); redirect(`/projects/${project.id}`); }
export async function registerDocumentAndRefresh(form: FormData) { await registerDocument(form); revalidatePath('/documents'); }
async function uploadErrorRedirectUrl(message: string, fallback = '/documents') {
  const referer = (await headers()).get('referer');
  const url = new URL(referer ?? fallback, 'http://localhost');
  url.searchParams.set('uploadError', message);
  return `${url.pathname}${url.search}${url.hash}`;
}
export async function uploadDocumentAndRefresh(form: FormData) {
  try {
    const document = await uploadDocument(form);
    revalidatePath('/documents');
    if (document.clientId) revalidatePath(`/clients/${document.clientId}`);
  } catch (error) {
    if (error instanceof UserFacingActionError) redirect(await uploadErrorRedirectUrl(error.message));
    throw error;
  }
}
export async function linkDocumentAndRefresh(form: FormData) { await linkDocumentToService(form); revalidatePath('/documents'); }
export async function createPreAnalysisAndRedirect(form: FormData) { const pre = await createPreAnalysis(form); revalidatePath('/preanalyses'); redirect(`/preanalyses/${pre.id}`); }
export async function createDossierAndRedirect(form: FormData) { const dossier = await createDossier(form); revalidatePath('/dossiers'); redirect(`/dossiers/${dossier.id}`); }
export async function createContractAndRefresh(form: FormData) { await createContract(form); revalidatePath('/contracts'); }
export async function registerPaymentAndRefresh(form: FormData) { await registerPayment(form); revalidatePath('/payments'); }
export async function completeTask(form: FormData) { const task = await completeClientTask(form); revalidatePath('/tasks'); if (task.clientId) revalidatePath(`/clients/${task.clientId}`); revalidatePath('/dashboard'); }
export async function runMockAiAndRedirect(form: FormData) { const agentCode=String(form.get('agentCode')||''); const prompt=String(form.get('prompt')||''); const requestKey=String(form.get('requestKey')||''); const output=await runMockAgent(agentCode,{ prompt, source:'CRM interno FAI', humanReviewRequired:true },requestKey); revalidatePath('/ai/outputs-to-review'); redirect('/ai/outputs-to-review'); }
export async function runClientAiAgentAndRedirect(form: FormData) { const output = await runClientAiAgent(form); revalidatePath(`/clients/${output.clientId}`); revalidatePath('/ai/outputs-to-review'); redirect(`/ai/outputs/${output.id}`); }
export async function reviewAiOutputAndRefresh(form: FormData) { await reviewAiOutput(String(form.get('id')||'')); revalidatePath('/ai/outputs-to-review'); revalidatePath(`/ai/outputs/${String(form.get('id')||'')}`); }
export async function approveAiOutputAndRefresh(form: FormData) { await approveAiOutput(String(form.get('id')||'')); revalidatePath('/ai/outputs-to-review'); }
export async function createClientDossierFromAiOutputAndRedirect(form: FormData) { const dossier = await createClientDossierFromAiOutput(form); revalidatePath(`/clients/${dossier.clientId}`); revalidatePath(`/ai/outputs/${String(form.get('id') || '')}`); redirect(`/client-dossiers/${dossier.id}`); }
export async function updateServiceStatusAndRefresh(form: FormData) { await updateClientServiceStatus(String(form.get('id')||''), String(form.get('status')||'')); revalidatePath('/clients'); }
export async function assignServiceAndRefresh(form: FormData) { await assignClientService(String(form.get('id')||''), String(form.get('assignedToId')||'')); revalidatePath('/clients'); revalidatePath('/dashboard'); }
export async function updateServicePipelineAndRefresh(form: FormData) { const service = await updateClientServicePipeline(form); revalidatePath(`/clients/${service.clientId}`); revalidatePath('/clients'); revalidatePath('/dashboard'); }

export async function createChecklistItemAndRefresh(form: FormData) { const item = await createDocumentChecklistItem(form); revalidatePath(`/clients/${item.clientId}`); }
export async function createStandardChecklistAndRefresh(form: FormData) { await createStandardDocumentChecklist(form); revalidatePath(`/clients/${String(form.get('clientId') || '')}`); }
export async function updateChecklistItemStatusAndRefresh(form: FormData) { const item = await updateDocumentChecklistItemStatus(form); revalidatePath(`/clients/${item.clientId}`); }
export async function linkChecklistItemDocumentAndRefresh(form: FormData) { const item = await linkDocumentToChecklistItem(form); revalidatePath(`/clients/${item.clientId}`); }
export async function unlinkChecklistItemDocumentAndRefresh(form: FormData) { const item = await unlinkDocumentFromChecklistItem(form); revalidatePath(`/clients/${item.clientId}`); }
export async function deactivateChecklistItemAndRefresh(form: FormData) { const item = await deactivateDocumentChecklistItem(form); revalidatePath(`/clients/${item.clientId}`); }

export async function createClientTaskAndRefresh(form: FormData) { const task = await createClientTask(form); revalidatePath(`/clients/${task.clientId}`); revalidatePath('/tasks'); revalidatePath('/dashboard'); }
export async function updateClientTaskAndRefresh(form: FormData) { const task = await updateClientTask(form); if (task.clientId) revalidatePath(`/clients/${task.clientId}`); revalidatePath('/tasks'); revalidatePath('/dashboard'); }

export async function generateClientDossierAndRedirect(form: FormData) { const dossier = await generateClientDossier(form); revalidatePath(`/clients/${dossier.clientId}`); revalidatePath('/dossiers'); redirect(`/client-dossiers/${dossier.id}`); }
export async function updateClientDossierAndRefresh(form: FormData) { const dossier = await updateClientDossier(form); revalidatePath(`/clients/${dossier.clientId}`); revalidatePath(`/client-dossiers/${dossier.id}`); }
export async function approveClientDossierAndRefresh(form: FormData) { const dossier = await approveClientDossier(form); revalidatePath(`/clients/${dossier.clientId}`); revalidatePath(`/client-dossiers/${dossier.id}`); }
export async function archiveClientDossierAndRefresh(form: FormData) { const dossier = await archiveClientDossier(form); revalidatePath(`/clients/${dossier.clientId}`); revalidatePath(`/client-dossiers/${dossier.id}`); }

export async function createTechnicalPracticeAndRedirect(form: FormData) { const practice = await createTechnicalPractice(form); revalidatePath('/technical-office'); revalidatePath('/technical-office/practices'); revalidatePath(`/clients/${practice.clientId}`); redirect(`/technical-office/practices/${practice.id}`); }
export async function updateTechnicalPracticeAndRefresh(form: FormData) { const practice = await updateTechnicalPractice(form); revalidatePath(`/technical-office/practices/${practice.id}`); revalidatePath('/technical-office/practices'); revalidatePath(`/clients/${practice.clientId}`); }
export async function updateTechnicalPracticeStatusAndRefresh(form: FormData) { const practice = await updateTechnicalPracticeStatus(form); revalidatePath(`/technical-office/practices/${practice.id}`); revalidatePath('/technical-office'); revalidatePath('/technical-office/practices'); revalidatePath(`/clients/${practice.clientId}`); }
export async function assignTechnicalPracticeAndRefresh(form: FormData) { const practice = await assignTechnicalPractice(form); revalidatePath(`/technical-office/practices/${practice.id}`); revalidatePath('/technical-office/practices'); revalidatePath(`/clients/${practice.clientId}`); }
export async function archiveTechnicalPracticeAndRefresh(form: FormData) { const practice = await archiveTechnicalPractice(form); revalidatePath('/technical-office'); revalidatePath('/technical-office/practices'); revalidatePath(`/clients/${practice.clientId}`); redirect('/technical-office/practices'); }


export async function createPracticeCommunicationDraftAndRefresh(form: FormData) { const communication = await createPracticeCommunicationDraft(form); revalidatePath(`/technical-office/practices/${communication.technicalPracticeId}`); revalidatePath(`/clients/${communication.clientId}`); revalidatePath('/dashboard'); }
export async function updatePracticeCommunicationDraftAndRefresh(form: FormData) { const communication = await updatePracticeCommunicationDraft(form); revalidatePath(`/technical-office/practices/${communication.technicalPracticeId}`); revalidatePath(`/clients/${communication.clientId}`); revalidatePath('/dashboard'); }
export async function approvePracticeCommunicationDraftAndRefresh(form: FormData) { const communication = await approvePracticeCommunicationDraft(form); revalidatePath(`/technical-office/practices/${communication.technicalPracticeId}`); revalidatePath(`/clients/${communication.clientId}`); revalidatePath('/dashboard'); }
export async function markPracticeCommunicationAsUsedAndRefresh(form: FormData) { const communication = await markPracticeCommunicationAsUsed(form); revalidatePath(`/technical-office/practices/${communication.technicalPracticeId}`); revalidatePath(`/clients/${communication.clientId}`); revalidatePath('/dashboard'); }
export async function archivePracticeCommunicationAndRefresh(form: FormData) { const communication = await archivePracticeCommunication(form); revalidatePath(`/technical-office/practices/${communication.technicalPracticeId}`); revalidatePath(`/clients/${communication.clientId}`); revalidatePath('/dashboard'); }
