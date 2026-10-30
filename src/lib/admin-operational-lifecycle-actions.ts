'use server';
import { cookies, headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { ZodError } from 'zod';
import { getSession } from './auth';
import { prisma } from './prisma';
import { isAllowedMutationOrigin } from './application-security-policy';
import { loadActivePrivilegedStepUpKey } from './application-key-registry';
import { privilegedStepUpCookieName, privilegedAccessReadiness } from './privileged-access';
import { saveAdminOperationalState, reconcileAdminOperationalState } from './admin-operational-lifecycle';
import { AdminOperationalStateError } from './admin-operational-state';
import { RecordUpdateError } from './record-update-contract';
import { ApprovedCommunicationError } from './approved-communication-contract';
import { PracticeReadinessError } from './practice-readiness';
import { TechnicalAssignmentError } from './technical-assignment-transaction';
import { SerializableConflictError } from './serializable';

export type OperationalResult = { ok: boolean; message: string; stepUp?: boolean; uncertain?: boolean; closed?: boolean };
async function sessionAndOrigin() {
  const session=await getSession(), h=await headers();
  return session?.role==='admin' && isAllowedMutationOrigin({origin:h.get('origin'),secFetchSite:h.get('sec-fetch-site'),
    configuredOrigin:process.env.APP_ORIGIN??process.env.NEXT_PUBLIC_APP_URL})?session:null;
}
function failure(error:unknown):OperationalResult {
  if(error instanceof RecordUpdateError)return {ok:false,stepUp:true,message:'Riconferma l’identità per proseguire. Stato scelto e motivazione sono conservati.'};
  if(error instanceof AdminOperationalStateError)return {ok:false,message:{
    DENIED:'Permessi o contesto non consentono questa operazione.',
    INACTIVE:'Il contesto è sospeso. Riapri prima il contesto amministrativo indicato.',
    INVALID:'Controlla i dati e la conferma.',
    STALE:'Lo stato o la fonte sono cambiati. Confronta la scheda attuale con le scelte conservate.',
    IN_FLIGHT:'Un invio è ancora aperto o incerto. Riconcilia il suo esito prima di sospendere il contesto.',
    CLOSED:'Il tentativo è già chiuso. Prepara una nuova operazione.',
  }[error.code]};
  if(error instanceof ApprovedCommunicationError||error instanceof PracticeReadinessError||error instanceof TechnicalAssignmentError)
    return {ok:false,message:'La scheda non è disponibile nel contesto e con i permessi correnti.'};
  if(error instanceof SerializableConflictError)return {ok:false,message:'Operazione annullata per una modifica concorrente. Le scelte sono conservate.'};
  if(error instanceof ZodError)return {ok:false,message:'Controlla lo stato scelto, la motivazione e la conferma.'};
  return {ok:false,uncertain:true,message:'Esito da verificare. Conserva il riferimento e verifica prima di preparare un’altra operazione.'};
}
export async function saveAdminOperationalStateAction(raw:unknown):Promise<OperationalResult>{
  const session=await sessionAndOrigin();
  if(!session)return {ok:false,message:'Sessione Admin o origine non ammessa.'};
  const readiness=await privilegedAccessReadiness(session);
  if(!readiness.active)return {ok:false,stepUp:readiness.mode==='enforced'&&readiness.keyReady,
    message:'Riconferma l’identità qui sotto. Stato scelto e motivazione restano disponibili.'};
  try{
    const key=await loadActivePrivilegedStepUpKey(prisma),jar=await cookies();
    if(!key)return {ok:false,message:'Conferma privilegiata non disponibile.'};
    await saveAdminOperationalState(prisma,session,raw,{key,
      sessionToken:jar.get(process.env.AUTH_COOKIE_NAME??'fai_crm_session')?.value??'',
      stepUpToken:jar.get(privilegedStepUpCookieName)?.value??''});
    revalidatePath('/admin/lifecycle');revalidatePath('/communications');revalidatePath('/controlled-intakes');revalidatePath('/practice-readiness');revalidatePath('/clients');
    return {ok:true,message:'Stato amministrativo registrato. Riapri la scheda per verificarlo.'};
  }catch(error){return failure(error);}
}
export async function reconcileAdminOperationalStateAction(raw:unknown):Promise<OperationalResult>{
  const session=await sessionAndOrigin();if(!session)return {ok:false,uncertain:true,message:'Sessione Admin o origine non ammessa. Il tentativo resta da verificare.'};
  try{
    const result=await reconcileAdminOperationalState(prisma,session,raw);
    return result.status==='RECORDED'?{ok:true,message:'Operazione già registrata. Riapri la scheda per verificarla.'}
      :result.status==='CLOSED'?{ok:false,closed:true,message:'Tentativo chiuso senza modifica. Il comando precedente non può essere eseguito in ritardo.'}
      :{ok:false,uncertain:true,message:'Nessun esito registrato osservato. Puoi verificare ancora oppure chiudere questo tentativo prima di una nuova scelta.'};
  }catch(error){return {...failure(error),uncertain:true};}
}
