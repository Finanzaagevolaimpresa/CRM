'use server';
import {cookies,headers} from 'next/headers';
import {revalidatePath} from 'next/cache';
import {ZodError} from 'zod';
import {getSession} from './auth';
import {prisma} from './prisma';
import {isAllowedMutationOrigin} from './application-security-policy';
import {loadActivePrivilegedStepUpKey} from './application-key-registry';
import {privilegedAccessReadiness,privilegedStepUpCookieName} from './privileged-access';
import {replaceAdminCommunicationDraft,reconcileAdminDraftReplacement,AdminDraftContextError} from './admin-draft-context';
import {ApprovedCommunicationError} from './approved-communication-contract';
import {AdminOperationalStateError} from './admin-operational-state';
import {RecordUpdateError} from './record-update-contract';
import {SerializableConflictError} from './serializable';
export type DraftContextResult={ok:boolean;message:string;stepUp?:boolean;uncertain?:boolean;closed?:boolean;href?:string};
async function admission(){
  const session=await getSession(),h=await headers();
  return session?.role==='admin'&&isAllowedMutationOrigin({origin:h.get('origin'),secFetchSite:h.get('sec-fetch-site'),
    configuredOrigin:process.env.APP_ORIGIN??process.env.NEXT_PUBLIC_APP_URL})?session:null;
}
function failure(error:unknown):DraftContextResult{
  if(error instanceof RecordUpdateError)return {ok:false,stepUp:true,message:'Riconferma l’identità. Testo e scelte della bozza restano disponibili.'};
  if(error instanceof AdminDraftContextError)return {ok:false,message:{
    STALE:'La bozza originale è cambiata. Confronta i dati correnti prima di riprovare.',
    CLOSED:'Questo tentativo è chiuso. Prepara una nuova sostituzione.',
    INELIGIBLE:'La fonte non è una bozza operativa senza approvazioni o tentativi. Consulta la sua timeline.',
  }[error.code]};
  if(error instanceof ApprovedCommunicationError||error instanceof AdminOperationalStateError)return {ok:false,message:'Contesto, fonte, riservatezza o permessi non consentono la sostituzione. Le scelte sono conservate.'};
  if(error instanceof ZodError)return {ok:false,message:'Controlla destinatari, campi, motivazione e conferma.'};
  if(error instanceof SerializableConflictError)return {ok:false,message:'Operazione annullata per una modifica concorrente. La bozza resta disponibile.'};
  return {ok:false,uncertain:true,message:'Risposta non confermata. Verifica il tentativo prima di preparare un’altra bozza.'};
}
const value=(form:FormData,name:string)=>String(form.get(name)??'');
const addresses=(form:FormData,name:string)=>value(form,name).split(/[,;\r\n]+/).map(v=>v.trim()).filter(Boolean);
export async function replaceAdminDraftAction(form:FormData):Promise<DraftContextResult>{
  const session=await admission();if(!session)return {ok:false,message:'Sessione Admin o origine non ammessa.'};
  const ready=await privilegedAccessReadiness(session);
  if(!ready.active)return {ok:false,stepUp:ready.mode==='enforced'&&ready.keyReady,message:'Riconferma l’identità qui sotto e prosegui con la bozza conservata.'};
  try{
    const key=await loadActivePrivilegedStepUpKey(prisma),jar=await cookies();
    if(!key)return {ok:false,message:'Conferma privilegiata non disponibile.'};
    const result=await replaceAdminCommunicationDraft(prisma,session,{
      commandId:value(form,'messageId'),id:value(form,'replacementSourceId'),expectedVersion:value(form,'replacementVersion'),
      reason:value(form,'replacementReason'),confirmed:value(form,'replacementConfirmed')==='true',
      draft:{context:{kind:value(form,'contextKind'),id:value(form,'contextId')},mailboxId:value(form,'mailboxId'),replyTo:value(form,'replyTo'),
        to:addresses(form,'to'),cc:addresses(form,'cc'),bcc:addresses(form,'bcc'),subject:value(form,'subject'),body:value(form,'body'),
        classification:value(form,'classification'),recipientSelection:JSON.parse(value(form,'recipientSelection')),
        attachmentVersionIds:form.getAll('attachmentVersionId').map(String),contextFileIds:form.getAll('contextFileId').map(String)},
    },{key,sessionToken:jar.get(process.env.AUTH_COOKIE_NAME??'fai_crm_session')?.value??'',stepUpToken:jar.get(privilegedStepUpCookieName)?.value??''});
    revalidatePath('/communications');revalidatePath('/admin/lifecycle');revalidatePath('/admin/communication-drafts');
    return {ok:true,href:result.href,message:'Bozza sostitutiva registrata nel nuovo contesto e originale archiviata. Controlla la nuova bozza prima di richiedere approvazioni.'};
  }catch(error){return failure(error);}
}
export async function reconcileAdminDraftAction(raw:unknown):Promise<DraftContextResult>{
  const session=await admission();if(!session)return {ok:false,uncertain:true,message:'Accedi come Admin per verificare il tentativo.'};
  try{
    const result=await reconcileAdminDraftReplacement(prisma,session,raw);
    return result.status==='RECORDED'?{ok:true,href:result.href,message:'Sostituzione già registrata. Apri la bozza conservata.'}
      :result.status==='CLOSED'?{ok:false,closed:true,message:'Tentativo chiuso senza sostituzione; il vecchio comando non può arrivare in ritardo.'}
      :{ok:false,uncertain:true,message:'Nessuna sostituzione registrata osservata. Verifica ancora o chiudi il tentativo prima di ripartire.'};
  }catch(error){return {...failure(error),uncertain:true};}
}
