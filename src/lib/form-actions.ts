'use server';
import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { prisma } from './prisma';
import { requirePermission } from './auth';
import { createLead, createProject, registerDocument, createPreAnalysis, createDossier, createContract, registerPayment, runMockAgent, approveAiOutput, updateClientServiceStatus, assignClientService, linkDocumentToService, uploadDocument, createDocumentChecklistItem, createStandardDocumentChecklist, updateDocumentChecklistItemStatus, linkDocumentToChecklistItem, unlinkDocumentFromChecklistItem, deactivateDocumentChecklistItem } from './actions';
import { UserFacingActionError } from './action-errors';

async function audit(actorId: string, event: string, entityType: string, entityId?: string, after?: unknown) { await prisma.auditLog.create({ data: { actorId, event, entityType, entityId, after: after as object } }); }
export async function createLeadAndRedirect(form: FormData) { const lead = await createLead(form); revalidatePath('/leads'); redirect(`/leads/${lead.id}`); }
export async function updateLeadStatus(form: FormData) { const s=await requirePermission('lead.write'); const id=String(form.get('id')||''); const status=String(form.get('status')||''); if(!id||!status) throw new Error('Dati lead mancanti'); const lead=await prisma.lead.update({where:{id},data:{status: status as never}}); await audit(s.userId,'lead_status_change','Lead',id,lead); revalidatePath(`/leads/${id}`); revalidatePath('/leads'); }
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
export async function completeTask(form: FormData) { const s=await requirePermission('service.write'); const id=String(form.get('id')||''); if(!id) throw new Error('Task mancante'); const task=await prisma.task.update({where:{id},data:{status:'chiuso',completedAt:new Date()}}); await audit(s.userId,'task_complete','Task',id,task); revalidatePath('/tasks'); }
export async function runMockAiAndRedirect(form: FormData) { const agentCode=String(form.get('agentCode')||''); const prompt=String(form.get('prompt')||''); const output=await runMockAgent(agentCode,{ prompt, source:'CRM interno FAI', humanReviewRequired:true }); revalidatePath('/ai/outputs-to-review'); redirect('/ai/outputs-to-review'); }
export async function approveAiOutputAndRefresh(form: FormData) { await approveAiOutput(String(form.get('id')||'')); revalidatePath('/ai/outputs-to-review'); }
export async function updateServiceStatusAndRefresh(form: FormData) { await updateClientServiceStatus(String(form.get('id')||''), String(form.get('status')||'')); revalidatePath('/clients'); }
export async function assignServiceAndRefresh(form: FormData) { await assignClientService(String(form.get('id')||''), String(form.get('assignedToId')||'')); revalidatePath('/clients'); }

export async function createChecklistItemAndRefresh(form: FormData) { const item = await createDocumentChecklistItem(form); revalidatePath(`/clients/${item.clientId}`); }
export async function createStandardChecklistAndRefresh(form: FormData) { await createStandardDocumentChecklist(form); revalidatePath(`/clients/${String(form.get('clientId') || '')}`); }
export async function updateChecklistItemStatusAndRefresh(form: FormData) { const item = await updateDocumentChecklistItemStatus(form); revalidatePath(`/clients/${item.clientId}`); }
export async function linkChecklistItemDocumentAndRefresh(form: FormData) { const item = await linkDocumentToChecklistItem(form); revalidatePath(`/clients/${item.clientId}`); }
export async function unlinkChecklistItemDocumentAndRefresh(form: FormData) { const item = await unlinkDocumentFromChecklistItem(form); revalidatePath(`/clients/${item.clientId}`); }
export async function deactivateChecklistItemAndRefresh(form: FormData) { const item = await deactivateDocumentChecklistItem(form); revalidatePath(`/clients/${item.clientId}`); }
