'use client';
import {useRef,useState,useSyncExternalStore,type ReactNode} from 'react';
import Link from 'next/link';
import {InlinePrivilegedConfirmation} from './inline-privileged-confirmation';
import {replaceAdminDraftAction,reconcileAdminDraftAction,type DraftContextResult} from '@/lib/admin-draft-context-actions';
const subscribe=()=>()=>{},hydrated=()=>true,server=()=>false;
export function AdminDraftContextForm({id,commandId,recovering=false,children}:{id:string;commandId:string;recovering?:boolean;children?:ReactNode}){
  const ready=useSyncExternalStore(subscribe,hydrated,server),sending=useRef(false),originalUrl=useRef<string|null>(null);
  const [busy,setBusy]=useState(false),[closeConfirmed,setCloseConfirmed]=useState(false);
  const [result,setResult]=useState<DraftContextResult|null>(recovering?{ok:false,uncertain:true,message:'Verifica il tentativo conservato prima di proseguire.'}:null);
  const frozen=!ready||busy||Boolean(result?.ok||result?.closed||result?.uncertain);
  async function save(form:HTMLFormElement){
    if(sending.current||frozen)return;
    const data=new FormData(form);sending.current=true;setBusy(true);
    originalUrl.current??=window.location.href;
    window.history.replaceState(window.history.state,'','/admin/communication-drafts/'+id+'?command='+commandId);
    try{
      const response=await replaceAdminDraftAction(data);setResult(response);
      if(!response.ok&&!response.uncertain)window.history.replaceState(window.history.state,'',originalUrl.current);
    }catch{setResult({ok:false,uncertain:true,message:'Risposta interrotta. Verifica la ricevuta prima di ripetere.'});}
    finally{sending.current=false;setBusy(false);}
  }
  async function reconcile(close=false){
    if(!ready||sending.current)return;sending.current=true;setBusy(true);
    try{setResult(await reconcileAdminDraftAction({id,commandId,close}));}
    catch{setResult({ok:false,uncertain:true,message:'Verifica interrotta. Il tentativo resta da riconciliare.'});}
    finally{sending.current=false;setBusy(false);}
  }
  return <div className="space-y-4" data-interactive-ready={ready} data-draft-context-command={commandId}>
    {children&&<form onSubmit={e=>{e.preventDefault();void save(e.currentTarget);}}><fieldset disabled={frozen} className="grid min-w-0 grid-cols-1 gap-3">{children}</fieldset></form>}
    {result&&<p role="status">{result.message}</p>}{result?.stepUp&&<InlinePrivilegedConfirmation/>}
    {result?.uncertain&&<section className="rounded-xl border border-amber-400 p-4 space-y-3"><p className="break-all">Riferimento: {commandId}</p>
      <button disabled={busy||!ready} className="block underline" onClick={()=>void reconcile()}>Verifica esito della sostituzione</button>
      <label className="block"><input type="checkbox" checked={closeConfirmed} onChange={e=>setCloseConfirmed(e.target.checked)}/> Chiudi il tentativo soltanto se non ha prodotto una bozza.</label>
      <button disabled={busy||!ready||!closeConfirmed} className="block underline" onClick={()=>void reconcile(true)}>Riconcilia e chiudi la sostituzione</button></section>}
    {result?.ok&&result.href&&<Link className="block font-bold underline" href={result.href}>Apri e verifica la bozza sostitutiva</Link>}
    {result?.closed&&<Link className="block underline" href={'/admin/communication-drafts/'+id}>Prepara una nuova sostituzione</Link>}
  </div>;
}
