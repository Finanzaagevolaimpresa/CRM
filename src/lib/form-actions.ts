'use server';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { prisma } from './prisma';
import { requirePermission } from './auth';
import { createLead, createProject, registerDocument, createPreAnalysis, createDossier, createContract, registerPayment, runMockAgent, approveAiOutput, updateClientServiceStatus, assignClientService, linkDocumentToService } from './actions';

async function audit(actorId: string, event: string, entityType: string, entityId?: string, after?: unknown) { await prisma.auditLog.create({ data: { actorId, event, entityType, entityId, after: after as object } }); }
export async function createLeadAndRedirect(form: FormData) { const lead = await createLead(form); revalidatePath('/leads'); redirect(`/leads/${lead.id}`); }
export async function updateLeadStatus(form: FormData) { const s=await requirePermission('lead.write'); const id=String(form.get('id')||''); const status=String(form.get('status')||''); if(!id||!status) throw new Error('Dati lead mancanti'); const lead=await prisma.lead.update({where:{id},data:{status: status as never}}); await audit(s.userId,'lead_status_change','Lead',id,lead); revalidatePath(`/leads/${id}`); revalidatePath('/leads'); }
export async function createProjectAndRedirect(form: FormData) { const project = await createProject(form); revalidatePath('/projects'); redirect(`/projects/${project.id}`); }
export async function registerDocumentAndRefresh(form: FormData) { await registerDocument(form); revalidatePath('/documents'); }
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
