'use server';
import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { requirePermission } from './auth';
import { assertTechnicalServerAction } from './technical-server-guards';
import { requireEnforcedPrivilegedMutation } from './privileged-access';
import { prisma } from './prisma';
import { assignCommercialLeadInboxItem, proposeCommercialLeadAssignee } from './commercial-lead-inbox';
import { CommercialLeadInboxError } from './commercial-lead-inbox-contract';

const command = z.object({ id:z.uuid(),leadId:z.string().min(1).max(128),targetUserId:z.string().min(1).max(128),
  expectedInboxVersion:z.coerce.number().int().positive(),reason:z.string().trim().min(3).max(500),decision:z.enum(['propose','confirm']) });
export async function saveLeadAssignmentProposal(_previous:{ok:boolean;message:string}, form:FormData) {
  await assertTechnicalServerAction('lead-assignment-proposal-actions:saveLeadAssignmentProposal');
  const parsed=command.safeParse(Object.fromEntries(form));
  if(!parsed.success) return {ok:false,message:'Controlla referente e motivazione.'};
  const value=parsed.data, actor=await requirePermission(value.decision==='confirm'?'lead.inbox.assign':'lead.write');
  if(!actor.sessionId) return {ok:false,message:'Accedi nuovamente.'};
  if(value.decision==='confirm') {
    if(actor.role!=='admin') return {ok:false,message:'La conferma è riservata all’Admin.'};
    await requireEnforcedPrivilegedMutation(actor,'N14_LEAD_INBOX_ASSIGN');
  }
  try {
    const identity={userId:actor.userId,sessionId:actor.sessionId};
    if(value.decision==='confirm') await assignCommercialLeadInboxItem(prisma,{actor:{...identity,requireManualAdmin:true},
      leadId:value.leadId,targetUserId:value.targetUserId,expectedInboxVersion:value.expectedInboxVersion,proposalId:value.id});
    else await proposeCommercialLeadAssignee(prisma,identity,value);
    for(const path of ['/dashboard','/leads/work','/leads/inbox','/notifications','/leads/'+value.leadId]) revalidatePath(path);
    return {ok:true,message:value.decision==='confirm'?'Assegnazione confermata e subito operativa.':'Proposta registrata. L’Admin può confermare o scegliere un altro referente.'};
  } catch(error) {
    if(error instanceof CommercialLeadInboxError) return {ok:false,message:'Scheda o proposta cambiata: ricarica e verifica il referente corrente.'};
    throw error;
  }
}
