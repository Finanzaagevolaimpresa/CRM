'use server';
import { cookies,headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { ZodError } from 'zod';
import { getSession } from './auth';
import { prisma } from './prisma';
import { isAllowedMutationOrigin } from './application-security-policy';
import { loadActivePrivilegedStepUpKey } from './application-key-registry';
import { privilegedStepUpCookieName,privilegedAccessReadiness } from './privileged-access';
import { saveAdminPrivateDocumentMetadata,reconcileAdminPrivateDocumentMetadata } from './admin-private-document-metadata';
import { PrivateDocumentMetadataError } from './private-document-metadata';
import { RecordUpdateError } from './record-update-contract';
import { TechnicalAssignmentError } from './technical-assignment-transaction';
import { SerializableConflictError } from './serializable';

export type MetadataResult={ok:boolean;message:string;stepUp?:boolean;uncertain?:boolean;closed?:boolean};
async function sessionAndOrigin(){
  const session=await getSession(),h=await headers();
  return session?.role==='admin'&&isAllowedMutationOrigin({origin:h.get('origin'),secFetchSite:h.get('sec-fetch-site'),
    configuredOrigin:process.env.APP_ORIGIN??process.env.NEXT_PUBLIC_APP_URL})?session:null;
}
function failure(error:unknown):MetadataResult{
  if(error instanceof RecordUpdateError)return {ok:false,stepUp:true,message:'Riconferma l’identità. I metadati e la motivazione sono conservati.'};
  if(error instanceof PrivateDocumentMetadataError)return {ok:false,message:{
    DENIED:'Permessi o contesto non consentono la correzione.',
    INVALID:'I metadati non sono validi oppure sono uguali a quelli correnti.',
    STALE:'Il documento è cambiato. Confronta i dati correnti con la bozza conservata.',
    CLOSED:'Questo tentativo è chiuso. Apri una nuova operazione.',
    INTEGRITY:'La fonte o lo storico richiedono una verifica. Nessuna correzione è ammessa.',
  }[error.code]};
  if(error instanceof TechnicalAssignmentError)return {ok:false,message:'Il documento non è disponibile con l’autorità personale e il contesto correnti.'};
  if(error instanceof SerializableConflictError)return {ok:false,message:'Operazione annullata per una modifica concorrente. La bozza è conservata.'};
  if(error instanceof ZodError)return {ok:false,message:'Controlla titolo, classificazione, scadenza e conferma.'};
  return {ok:false,uncertain:true,message:'Esito da verificare. Conserva il riferimento prima di preparare un’altra operazione.'};
}
export async function saveAdminPrivateDocumentMetadataAction(raw:unknown):Promise<MetadataResult>{
  const session=await sessionAndOrigin();if(!session)return {ok:false,message:'Sessione Admin o origine non ammessa.'};
  const readiness=await privilegedAccessReadiness(session);
  if(!readiness.active)return {ok:false,stepUp:readiness.mode==='enforced'&&readiness.keyReady,
    message:'Riconferma l’identità qui sotto. La bozza resta disponibile.'};
  try{
    const key=await loadActivePrivilegedStepUpKey(prisma),jar=await cookies();
    if(!key)return {ok:false,message:'Conferma privilegiata non disponibile.'};
    await saveAdminPrivateDocumentMetadata(prisma,session,raw,{key,
      sessionToken:jar.get(process.env.AUTH_COOKIE_NAME??'fai_crm_session')?.value??'',
      stepUpToken:jar.get(privilegedStepUpCookieName)?.value??''});
    revalidatePath('/admin/private-documents');revalidatePath('/clients');revalidatePath('/admin/lifecycle');
    return {ok:true,message:'Metadati amministrativi registrati. Le vecchie selezioni del documento sono invalidate; scegli esplicitamente nuove concessioni se necessarie.'};
  }catch(error){return failure(error);}
}
export async function reconcileAdminPrivateDocumentMetadataAction(raw:unknown):Promise<MetadataResult>{
  const session=await sessionAndOrigin();if(!session)return {ok:false,uncertain:true,message:'Sessione Admin o origine non ammessa. Verifica il tentativo dopo l’accesso.'};
  try{
    const result=await reconcileAdminPrivateDocumentMetadata(prisma,session,raw);
    return result.status==='RECORDED'?{ok:true,message:'Correzione già registrata. Riapri il documento per verificarla.'}
      :result.status==='CLOSED'?{ok:false,closed:true,message:'Tentativo chiuso senza correzione. Il comando precedente non può arrivare in ritardo.'}
      :{ok:false,uncertain:true,message:'Nessun esito registrato osservato. Verifica ancora o chiudi il tentativo prima di ripartire.'};
  }catch(error){return {...failure(error),uncertain:true};}
}
