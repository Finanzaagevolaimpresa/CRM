'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import type { CommunicationContext } from '@/lib/approved-communication-contract';
import { uploadCommunicationFileAction, revokeCommunicationFileAction } from '@/lib/communication-file-actions';

type ContextFile = { id: string; fileName: string; sizeBytes: number; sha256: string; classification: string };
export function CommunicationFiles({ context, files, canWrite, requestId, isAdmin = false }: {
  context: CommunicationContext; files: ContextFile[]; canWrite: boolean; requestId: string; isAdmin?: boolean;
}) {
  const router = useRouter(), pending = useRef(false);
  const [busy,setBusy] = useState(false), [blocked,setBlocked] = useState(false), [message,setMessage] = useState('');
  async function mutate(operation: () => Promise<'RECORDED' | 'CHECK_CURRENT'>) {
    if (pending.current || blocked) return;
    pending.current=true;setBusy(true);setMessage('');
    try {
      const result=await operation();
      setBlocked(true);
      setMessage(result==='RECORDED'?'Operazione registrata. Aggiorna l’elenco prima di proseguire.':'Esito da verificare. Ricarica e controlla l’elenco prima di ripetere.');
      if(result==='RECORDED')router.refresh();
    }catch{setBlocked(true);setMessage('Risposta non ricevuta. Ricarica e verifica prima di ripetere.');}
    finally{pending.current=false;setBusy(false);}
  }
  async function download(file: ContextFile) {
    if(pending.current)return;pending.current=true;setBusy(true);setMessage('');
    try{
      const form=new FormData();form.set('kind',context.kind);form.set('contextId',context.id);form.set('sha256',file.sha256);
      const response=await fetch(`/communications/files/${file.id}`,{method:'POST',body:form,cache:'no-store'});
      if(!response.ok||response.headers.get('content-type')!=='application/octet-stream'||response.headers.get('content-length')!==String(file.sizeBytes))throw new Error('UNAVAILABLE');
      const bytes=await response.arrayBuffer();
      const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(v=>v.toString(16).padStart(2,'0')).join('');
      if(bytes.byteLength!==file.sizeBytes||hash!==file.sha256)throw new Error('INTEGRITY');
      const url=URL.createObjectURL(new Blob([bytes],{type:'application/octet-stream'})),link=document.createElement('a');
      link.href=url;link.download=file.fileName;link.click();setTimeout(()=>URL.revokeObjectURL(url),30_000);
    }catch{setMessage('Allegato non disponibile. Aggiorna la comunicazione.');}
    finally{pending.current=false;setBusy(false);}
  }
  return <section className="grid gap-4">
    <p className="text-sm">File riservati a questo contesto. Per inserirli in un’email selezionali nella bozza. Massimo 20 MiB per file e per messaggio, 200 MiB e 100 file per contesto, inclusi quelli revocati.</p>
    {canWrite?<form action={form=>mutate(()=>uploadCommunicationFileAction(form))} className="grid gap-3 rounded-xl border p-3">
      <input type="hidden" name="id" value={requestId}/><input type="hidden" name="kind" value={context.kind}/><input type="hidden" name="contextId" value={context.id}/>
      <label>Allegato da caricare<input className="block max-w-full" type="file" name="file" required accept=".pdf,.png,.jpg,.jpeg,.webp,.txt,.csv,.doc,.docx,.xls,.xlsx,.odt,.ods,.p7m,.xml,.zip"/></label>
      <label>Riservatezza del file<select name="classification" className="block w-full rounded-xl border p-2"><option value="ORDINARY">Ordinaria</option><option value="SENSITIVE">Materiale sensibile</option><option value="COMPLAINT">Reclamo · solo Admin</option></select></label>
      <p className="text-sm">PDF, immagini PNG/JPEG/WebP, testo/CSV, documenti Office/OpenDocument, XML, P7M e ZIP. Una nuova versione si carica come file distinto.</p>
      <button disabled={busy||blocked} className="rounded-xl border p-2 font-bold">Carica allegato nel contesto</button>
    </form>:null}
    <ul className="grid gap-3">{files.map(file=><li key={file.id} className="grid gap-2 break-words rounded-xl border p-3">
      <p>{file.fileName} · {file.sizeBytes} byte · {file.classification==='ORDINARY'?'Ordinario':file.classification==='SENSITIVE'?'Sensibile':'Reclamo'}</p>
      {isAdmin && <Link className="font-bold underline" href={`/admin/records/CommunicationContextFile/${file.id}`}>Fonte e rettifiche amministrative del file</Link>}
      <button className="text-left font-bold underline" disabled={busy} onClick={()=>download(file)}>Scarica {file.fileName}</button>
      {canWrite?<details><summary className="cursor-pointer">Revoca disponibilità</summary><form action={form=>form.get('confirm')==='REVOKE'?mutate(()=>revokeCommunicationFileAction({id:file.id,context,sha256:file.sha256})):Promise.resolve()} className="grid gap-2">
        <p>Blocca download e nuovi invii che includono questo file. Il file e lo storico restano conservati.</p>
        <label><input type="checkbox" required name="confirm" value="REVOKE"/> Confermo la revoca di questo allegato.</label>
        <button disabled={busy||blocked} className="rounded-xl border p-2">Conferma revoca</button>
      </form></details>:null}
    </li>)}</ul>
    {!files.length?<p>Nessun allegato caricato nel contesto.</p>:null}
    {message?<p role="status">{message}</p>:null}
  </section>;
}
