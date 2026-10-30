'use client';
import { useRef, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import type { readAdminOperationalState } from '@/lib/admin-operational-lifecycle';
import { adminOperationalStates, adminOperationalLabels, type AdminOperationalState } from '@/lib/admin-operational-state';
import { saveAdminOperationalStateAction, reconcileAdminOperationalStateAction, type OperationalResult } from '@/lib/admin-operational-lifecycle-actions';
import { InlinePrivilegedConfirmation } from './inline-privileged-confirmation';
type Data=Awaited<ReturnType<typeof readAdminOperationalState>>;
const subscribe=()=>()=>{}, hydrated=()=>true, server=()=>false;
export function AdminOperationalLifecycleEditor({data,commandId,recovering}:{data:Data;commandId:string;recovering:boolean}){
  const ready=useSyncExternalStore(subscribe,hydrated,server),sending=useRef(false);
  const [expectedVersion]=useState(data.expectedVersion),[state,setState]=useState<AdminOperationalState>(data.state==='ACTIVE'?'BLOCKED':'ACTIVE');
  const [reason,setReason]=useState(''),[confirmed,setConfirmed]=useState(false),[closeConfirmed,setCloseConfirmed]=useState(false),[busy,setBusy]=useState(false);
  const [result,setResult]=useState<OperationalResult|null>(recovering?{ok:false,uncertain:true,message:'Verifica il tentativo conservato prima di proseguire.'}:null);
  const frozen=!ready||busy||Boolean(result?.uncertain||result?.ok||result?.closed);
  const path='/admin/lifecycle/'+data.model+'/'+encodeURIComponent(data.id);
  function remember(pending:boolean){
    const url=new URL(window.location.href);
    if(pending)url.searchParams.set('decision',commandId);else url.searchParams.delete('decision');
    window.history.replaceState(window.history.state,'',url);
  }
  async function save(){
    if(sending.current||frozen||!confirmed)return;
    sending.current=true;setBusy(true);remember(true);
    try{
      const response=await saveAdminOperationalStateAction({commandId,model:data.model,id:data.id,expectedVersion,state,reason,confirmed:true});
      setResult(response);if(!response.ok&&!response.uncertain)remember(false);
    }catch{setResult({ok:false,uncertain:true,message:'Risposta interrotta. Verifica l’esito del tentativo conservato.'});}
    finally{sending.current=false;setBusy(false);}
  }
  async function reconcile(close=false){
    if(sending.current||!ready)return;sending.current=true;setBusy(true);
    try{setResult(await reconcileAdminOperationalStateAction({commandId,model:data.model,id:data.id,close}));}
    catch{setResult({ok:false,uncertain:true,message:'Verifica interrotta. Il tentativo resta da riconciliare.'});}
    finally{sending.current=false;setBusy(false);}
  }
  return <div className="space-y-5" data-interactive-ready={ready}>
    <nav className="flex flex-wrap gap-4"><Link className="underline" href={data.href}>Apri la scheda nel suo contesto</Link>
      <Link className="underline" href={'/admin/lifecycle?model='+data.model}>Tutte le schede di questa area</Link></nav>
    <section className="space-y-2 rounded-xl border p-4"><h2 className="font-bold">{data.kindLabel}: {data.label}</h2>
      <p>Stato corrente: <strong>{adminOperationalLabels[data.state]}</strong> · revisione {data.version}</p>
      <p>Il blocco sospende il lavoro corrente mantenendo la consultazione. Archivio e cestino nascondono la scheda alle altre persone. La fonte e le prove storiche restano conservate.</p>
      {['ControlledIntake','PracticeReadiness'].includes(data.model)&&<p>La sospensione si estende alle attività e alle comunicazioni collegate alla pratica. Puoi ancora consultare i documenti e le evidenze secondo i permessi correnti.</p>}
      {data.model==='Document'?<p>Ogni cambio di stato invalida le vecchie selezioni del documento. Al ripristino occorre concedere esplicitamente le versioni desiderate; nessuna concessione viene riattivata.</p>
        :<p>Il ripristino non esegue invii, avvii personali o nuove approvazioni. Per una comunicazione ripristinata salva una nuova versione prima di richiederne l’approvazione.</p>}
    </section>
    {data.canWrite?<form onSubmit={event=>{event.preventDefault();void save();}} className="space-y-4">
      <fieldset disabled={frozen} className="space-y-4">
        <label className="block font-semibold">Nuovo stato<select aria-label="Nuovo stato" className="block w-full rounded-xl border p-3" value={state}
          onChange={event=>{setState(event.target.value as AdminOperationalState);setConfirmed(false);}}>
          {adminOperationalStates.filter(value=>value!==data.state).map(value=><option key={value} value={value}>{value==='ACTIVE'?'Ripristina operatività':adminOperationalLabels[value]}</option>)}
        </select></label>
        <label className="block font-semibold">Motivazione<textarea className="block w-full rounded-xl border p-3" required minLength={3} maxLength={2000}
          value={reason} onChange={event=>setReason(event.target.value)}/></label>
        <section aria-label="Riepilogo del cambio di stato" className="rounded-xl border p-4">
          <p>{data.label}: {adminOperationalLabels[data.state]} → {adminOperationalLabels[state]}</p>
          <label><input type="checkbox" required checked={confirmed} onChange={event=>setConfirmed(event.target.checked)}/> Confermo il cambio di stato e la conservazione delle prove originali.</label>
        </section>
        <button disabled={!confirmed} className="rounded-xl bg-blue-900 px-4 py-3 font-bold text-white">Registra stato amministrativo</button>
      </fieldset>
    </form>:<p>I permessi correnti consentono soltanto la consultazione.</p>}
    {result&&<p role="status">{result.message}</p>}
    {result?.stepUp&&<InlinePrivilegedConfirmation/>}
    {result?.uncertain&&<section className="space-y-3 rounded-xl border border-amber-400 p-4"><p className="break-all">Riferimento: {commandId}</p>
      <button disabled={busy||!ready} className="block underline" onClick={()=>void reconcile()}>Verifica esito registrato</button>
      <label className="block"><input type="checkbox" checked={closeConfirmed} onChange={event=>setCloseConfirmed(event.target.checked)}/> Chiudi il tentativo soltanto se non ha prodotto una modifica.</label>
      <button disabled={busy||!ready||!closeConfirmed} className="block underline" onClick={()=>void reconcile(true)}>Riconcilia e chiudi il tentativo</button>
    </section>}
    {result?.ok&&<Link className="block font-bold underline" href={path}>Riapri e verifica lo stato</Link>}
    {(result?.closed||(!result?.uncertain&&!result?.ok))&&<Link className="block underline" href={path}>Riapri i dati correnti per una nuova operazione</Link>}
    <section className="space-y-3"><h2 className="font-bold">Cronologia amministrativa</h2>
      {data.history.length?<ol className="space-y-3">{data.history.map(row=><li key={row.commandId} className="rounded-xl border p-3">
        <p>{new Date(row.createdAt).toLocaleString('it-IT')} · {row.reason}</p></li>)}</ol>:<p>Nessun cambio di stato registrato.</p>}
      {data.page>1&&<Link className="mr-4 underline" href={path+'?page='+(data.page-1)}>Cronologia precedente</Link>}
      {data.hasMore&&<Link className="underline" href={path+'?page='+(data.page+1)}>Altre operazioni</Link>}
    </section>
  </div>;
}
