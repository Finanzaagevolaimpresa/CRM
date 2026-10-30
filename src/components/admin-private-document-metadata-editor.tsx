'use client';
import { useRef,useState,useSyncExternalStore } from 'react';
import Link from 'next/link';
import type { readAdminPrivateDocumentMetadata } from '@/lib/admin-private-document-metadata';
import type { PrivateMetadataValues } from '@/lib/private-document-metadata';
import { saveAdminPrivateDocumentMetadataAction,reconcileAdminPrivateDocumentMetadataAction,type MetadataResult } from '@/lib/admin-private-document-metadata-actions';
import { InlinePrivilegedConfirmation } from './inline-privileged-confirmation';
type Data=Awaited<ReturnType<typeof readAdminPrivateDocumentMetadata>>;
const labels={TECHNICAL_DOCUMENT:'Documento tecnico',CONTRACT:'Contratto',PAYMENT:'Pagamento',OTHER_CONFIDENTIAL:'Altro documento riservato'} as const;
const subscribe=()=>()=>{},hydrated=()=>true,server=()=>false;
const localDate=(value:string|null)=>value?new Date(new Date(value).getTime()-new Date(value).getTimezoneOffset()*60000).toISOString().slice(0,16):'';
export function AdminPrivateDocumentMetadataEditor({data,commandId,recovering}:{data:Data;commandId:string;recovering:boolean}){
  const ready=useSyncExternalStore(subscribe,hydrated,server),sending=useRef(false);
  const [expectedVersion]=useState(data.expectedVersion),[title,setTitle]=useState(data.current.values.title),
    [classification,setClassification]=useState(data.current.values.classification),[expires,setExpires]=useState(localDate(data.current.values.expiresAt)),
    [reason,setReason]=useState(''),[confirmed,setConfirmed]=useState(false),[closeConfirmed,setCloseConfirmed]=useState(false),[busy,setBusy]=useState(false);
  const [result,setResult]=useState<MetadataResult|null>(recovering?{ok:false,uncertain:true,message:'Verifica il tentativo conservato prima di proseguire.'}:null);
  const frozen=!ready||busy||Boolean(result?.uncertain||result?.ok||result?.closed),path='/admin/private-documents/'+encodeURIComponent(data.id);
  function remember(pending:boolean){const url=new URL(window.location.href);if(pending)url.searchParams.set('decision',commandId);else url.searchParams.delete('decision');window.history.replaceState(window.history.state,'',url);}
  function restore(values:PrivateMetadataValues){if(frozen)return;setTitle(values.title);setClassification(values.classification);setExpires(localDate(values.expiresAt));setConfirmed(false);}
  async function save(){
    if(sending.current||frozen||!confirmed)return;
    sending.current=true;setBusy(true);remember(true);
    try{
      const response=await saveAdminPrivateDocumentMetadataAction({commandId,id:data.id,expectedVersion,
        values:{title,classification,expiresAt:expires?new Date(expires).toISOString():null},reason,confirmed:true});
      setResult(response);if(!response.ok&&!response.uncertain)remember(false);
    }catch{setResult({ok:false,uncertain:true,message:'Risposta interrotta. Verifica il tentativo conservato prima di ripetere.'});}
    finally{sending.current=false;setBusy(false);}
  }
  async function reconcile(close=false){
    if(sending.current||!ready)return;sending.current=true;setBusy(true);
    try{setResult(await reconcileAdminPrivateDocumentMetadataAction({commandId,id:data.id,close}));}
    catch{setResult({ok:false,uncertain:true,message:'Verifica interrotta. Il tentativo resta da riconciliare.'});}
    finally{sending.current=false;setBusy(false);}
  }
  function summary(values:PrivateMetadataValues){return <p>{values.title} · {labels[values.classification]} · {values.expiresAt?'scadenza '+new Date(values.expiresAt).toLocaleString('it-IT'):'senza scadenza amministrativa'}</p>;}
  return <div className="space-y-5" data-interactive-ready={ready}>
    <nav className="flex flex-wrap gap-4"><Link className="underline" href={'/clients/'+encodeURIComponent(data.clientId)+'/acquired-documents'}>Torna ai documenti acquisiti</Link>
      <Link className="underline" href={'/admin/lifecycle/Document/'+encodeURIComponent(data.id)}>Blocca, archivia o ripristina il documento</Link></nav>
    <section className="rounded-xl border p-4 space-y-2"><h2 className="font-bold">Metadati correnti · revisione {data.current.revision}</h2>{summary(data.current.values)}
      <p>{data.fileName} · contenuto originale versione 1</p><p>La correzione invalida le precedenti selezioni. La visibilità resta privata e ogni nuova condivisione richiede destinatario e versione espliciti.</p>
      <p>La classificazione non elimina le tutele finanziarie o di riservatezza della fonte. Il file, l’autore e la prova dell’acquisizione restano conservati.</p></section>
    {data.canWrite?<form className="space-y-4" onSubmit={e=>{e.preventDefault();void save();}}><fieldset disabled={frozen} className="space-y-4">
      <label className="block font-semibold">Titolo amministrativo<input className="block w-full border rounded-xl p-3" required maxLength={240} value={title} onChange={e=>{setTitle(e.target.value);setConfirmed(false);}}/></label>
      <label className="block font-semibold">Classificazione amministrativa<select className="block w-full border rounded-xl p-3" value={classification} onChange={e=>{setClassification(e.target.value as PrivateMetadataValues['classification']);setConfirmed(false);}}>
        {Object.entries(labels).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
      <label className="block font-semibold">Scadenza amministrativa<input className="block w-full border rounded-xl p-3" type="datetime-local" value={expires} onChange={e=>{setExpires(e.target.value);setConfirmed(false);}}/></label>
      <label className="block font-semibold">Motivazione<textarea className="block w-full border rounded-xl p-3" required minLength={3} maxLength={2000} value={reason} onChange={e=>setReason(e.target.value)}/></label>
      <section aria-label="Riepilogo della correzione" className="rounded-xl border p-4"><p>{title} · {labels[classification]} · {expires||'senza scadenza amministrativa'}</p>
        <label><input type="checkbox" required checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/> Confermo la correzione, la conservazione della fonte e l’invalidazione delle vecchie selezioni.</label></section>
      <button disabled={!confirmed} className="bg-blue-900 rounded-xl px-4 py-3 font-bold text-white">Registra metadati amministrativi</button>
    </fieldset></form>:<p>I permessi correnti consentono soltanto la consultazione.</p>}
    {result&&<p role="status">{result.message}</p>}{result?.stepUp&&<InlinePrivilegedConfirmation/>}
    {result?.uncertain&&<section className="space-y-3 border border-amber-400 rounded-xl p-4"><p className="break-all">Riferimento: {commandId}</p>
      <button disabled={busy||!ready} className="block underline" onClick={()=>void reconcile()}>Verifica esito registrato</button>
      <label className="block"><input type="checkbox" checked={closeConfirmed} onChange={e=>setCloseConfirmed(e.target.checked)}/> Chiudi il tentativo soltanto se non ha prodotto una correzione.</label>
      <button disabled={busy||!ready||!closeConfirmed} className="block underline" onClick={()=>void reconcile(true)}>Riconcilia e chiudi il tentativo</button></section>}
    {result?.ok&&<Link className="block font-bold underline" href={path}>Riapri e verifica i metadati</Link>}
    {(result?.closed||(!result?.uncertain&&!result?.ok))&&<Link className="block underline" href={path}>Riapri i dati correnti per una nuova operazione</Link>}
    <section className="space-y-3"><h2 className="font-bold">Fonte originale</h2>{summary(data.original.values)}
      {data.canWrite&&<button disabled={frozen} className="underline" onClick={()=>restore(data.original.values)}>Riprendi i metadati originali nella bozza</button>}</section>
    <section className="space-y-3"><h2 className="font-bold">Cronologia delle correzioni</h2>
      {data.history.length?<ol className="space-y-3">{data.history.map(row=><li key={row.commandId} className="rounded-xl border p-3">
        <p>Revisione {row.after.revision} · {new Date(row.createdAt).toLocaleString('it-IT')} · {row.reason}</p>{summary(row.after.values)}
        {data.canWrite&&<button disabled={frozen} className="underline" onClick={()=>restore(row.after.values)}>Riprendi questi metadati nella bozza</button>}</li>)}</ol>:<p>Nessuna correzione amministrativa registrata.</p>}
      {data.page>1&&<Link className="mr-4 underline" href={path+'?page='+(data.page-1)}>Cronologia precedente</Link>}{data.hasMore&&<Link className="underline" href={path+'?page='+(data.page+1)}>Altre correzioni</Link>}
    </section>
  </div>;
}

