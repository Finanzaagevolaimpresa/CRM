'use client';
import { useRef, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import type { readAdminCommunicationFile, AdminCommunicationFileCommand } from '@/lib/admin-communication-files';
import type { CommunicationContext } from '@/lib/approved-communication-contract';
import { replaceAdminCommunicationFileAction, searchAdminCommunicationFileContextsAction } from '@/lib/admin-communication-file-actions';
import { verifyAdminRecordAction, closeAdminRecordAction, type AdminSaveResult } from '@/lib/admin-record-actions';
import { InlinePrivilegedConfirmation } from './inline-privileged-confirmation';

type Data = Awaited<ReturnType<typeof readAdminCommunicationFile>>;
const kinds = { LEAD: 'Lead', CLIENT: 'Cliente', READINESS: 'Pratica preventivo e avvio', TECHNICAL: 'Pratica tecnica', INTERNAL: 'Conversazione interna' } as const;
const subscribe = () => () => {}, hydrated = () => true, server = () => false;
export function AdminCommunicationFileEditor({ data, commandId, versionId, recovering }: {
  data: Data; commandId: string; versionId: string; recovering: boolean;
}) {
  const fileRef = useRef<File | null>(null), sending = useRef(false);
  const ready = useSyncExternalStore(subscribe, hydrated, server), [busy,setBusy] = useState(false);
  const [sourceVersion] = useState(data.expectedVersion);
  const [fileName,setFileName] = useState(data.fileName), [selectedFile,setSelectedFile] = useState('');
  const [classification,setClassification] = useState(data.classification as AdminCommunicationFileCommand['classification']);
  const [action,setAction] = useState<AdminCommunicationFileCommand['action']>(data.revokedAt ? 'RESTORE' : 'REPLACE');
  const [reason,setReason] = useState(''), [confirmed,setConfirmed] = useState(false), [closeConfirmed,setCloseConfirmed] = useState(false);
  const [target,setTarget] = useState({ context: data.context, label: data.contextLabel });
  const [kind,setKind] = useState<CommunicationContext['kind']>(data.context.kind), [query,setQuery] = useState('');
  const [choices,setChoices] = useState<{ context: CommunicationContext; label: string }[]>([]);
  const [page,setPage] = useState(1), [more,setMore] = useState(false), [searchMessage,setSearchMessage] = useState('');
  const [result,setResult] = useState<AdminSaveResult | null>(recovering ? { ok: false, uncertain: true,
    message: 'Verifica il tentativo conservato. Nessun salvataggio viene ripetuto automaticamente.' } : null);
  const [submitted,setSubmitted] = useState<AdminCommunicationFileCommand | null>(null);
  const frozen = !ready || busy || Boolean(result?.uncertain || result?.ok || result?.closed);
  const inputClass = 'block w-full max-w-full rounded-xl border p-3';
  function remember(value: boolean) {
    const url = new URL(window.location.href);
    if (value) url.searchParams.set('decision',commandId); else url.searchParams.delete('decision');
    window.history.replaceState(window.history.state,'',url);
  }
  async function search(nextPage: number) {
    if (sending.current) return; sending.current=true;setBusy(true);
    try {
      const response = await searchAdminCommunicationFileContextsAction({ kind, query, page: nextPage });
      if (!response.ok) { setSearchMessage('Ricerca non disponibile per l’autorità corrente. La destinazione scelta è conservata.'); return; }
      setChoices(response.value.choices);setPage(response.value.page);setMore(response.value.hasMore);
      setSearchMessage(response.value.choices.length ? '' : 'Nessun contesto accessibile in questa pagina.');
    } catch { setSearchMessage('Ricerca interrotta. Riprova senza cambiare la destinazione scelta.'); }
    finally {sending.current=false;setBusy(false);}
  }
  async function submit(replay = false) {
    if (sending.current || !ready || (!replay && (!confirmed || result?.uncertain))) return;
    const command = replay ? submitted : { commandId, id: versionId, sourceId: data.id, expectedVersion: sourceVersion,
      action, context: target.context, fileName, classification, reason, confirmed: true as const };
    if (!command) return;
    setSubmitted(command); sending.current=true;setBusy(true);remember(true);
    try {
      const form = new FormData();form.set('command',JSON.stringify(command));
      if (command.action === 'REPLACE' && fileRef.current) form.set('file',fileRef.current);
      const saved = await replaceAdminCommunicationFileAction(form);setResult(saved);
      if (!saved.ok && !saved.uncertain) remember(false);
    } catch {setResult({ok:false,uncertain:true,message:'Risposta interrotta: verifica l’esito del comando prima di proseguire.'});}
    finally {sending.current=false;setBusy(false);}
  }
  async function reconcile(close = false) {
    if (sending.current) return;sending.current=true;setBusy(true);
    try {
      const response = close ? await closeAdminRecordAction({commandId,model:'CommunicationContextFile',id:versionId})
        : await verifyAdminRecordAction(commandId);
      setResult(response);
    } catch {setResult({ok:false,uncertain:true,message:'Verifica non disponibile. Conserva il riferimento e riprova.'});}
    finally {sending.current=false;setBusy(false);}
  }
  return <div className="space-y-6">
    <nav className="flex flex-wrap gap-4"><Link className="underline" href={`/admin/records/CommunicationContextFile/${data.id}`}>Fonte e rettifiche</Link>
      <Link className="underline" href={`/communications?kind=${data.context.kind}&practice=${encodeURIComponent(data.context.id)}`}>Apri il contesto</Link></nav>
    <section className="space-y-2 rounded-xl border p-4"><h2 className="font-bold">Versione originale</h2>
      <p>{data.fileName} · {data.sizeBytes} byte · {data.revokedAt ? 'Revocata' : 'Disponibile'} · {kinds[data.context.kind]}: {data.contextLabel}</p>
      <p className="break-all text-sm">SHA256: {data.sha256}</p>
      <p>La fonte resta conservata. La nuova versione non sostituisce gli allegati nelle comunicazioni già preparate e non invia messaggi.</p>
      {data.sourceId && <Link className="block underline" href={`/admin/communication-files/${data.sourceId}`}>Apri la versione precedente</Link>}
    </section>
    {data.canWrite ? <form onSubmit={event=>{event.preventDefault();void submit();}} className="space-y-4">
      <fieldset disabled={frozen} className="space-y-4">
        <label className="block">Operazione<select className={inputClass} value={action} onChange={event=>{setAction(event.target.value as typeof action);setConfirmed(false);}}>
          <option value="REPLACE">Crea una versione corretta e revoca la precedente se disponibile</option>
          {data.revokedAt && <option value="RESTORE">Recupera i byte conservati come nuova versione</option>}
        </select></label>
        {action === 'REPLACE' && <label className="block">Nuovo contenuto, facoltativo<input type="file" className={inputClass}
          accept=".pdf,.png,.jpg,.jpeg,.webp,.txt,.csv,.doc,.docx,.xls,.xlsx,.odt,.ods,.p7m,.xml,.zip"
          onChange={event=>{fileRef.current=event.target.files?.[0]??null;setSelectedFile(fileRef.current?.name??'');setConfirmed(false);}}/>
          <span className="text-sm">{selectedFile ? 'Selezionato: '+selectedFile : 'Senza nuovo file vengono riutilizzati i byte originali verificati.'}</span></label>}
        <label className="block">Nome della nuova versione<input className={inputClass} value={fileName} required maxLength={200} onChange={event=>{setFileName(event.target.value);setConfirmed(false);}}/></label>
        <label className="block">Riservatezza<select className={inputClass} value={classification} onChange={event=>{setClassification(event.target.value as typeof classification);setConfirmed(false);}}>
          <option value="ORDINARY">Ordinaria</option><option value="SENSITIVE">Materiale sensibile</option><option value="COMPLAINT">Reclamo · solo Admin</option></select></label>
        <section className="space-y-3 rounded-xl border p-4"><h2 className="font-bold">Destinazione della nuova versione</h2>
          <p aria-label="Destinazione scelta">{kinds[target.context.kind]}: {target.label}</p>
          <label>Tipo di contesto<select className={inputClass} value={kind} onChange={event=>{setKind(event.target.value as typeof kind);setChoices([]);setMore(false);}}>
            {Object.entries(kinds).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
          <label>Cerca per nome<input className={inputClass} value={query} maxLength={120} onChange={event=>setQuery(event.target.value)}/></label>
          <button type="button" className="underline" onClick={()=>void search(1)}>Cerca destinazione</button>
          {searchMessage && <p role="status">{searchMessage}</p>}
          <ul className="space-y-2">{choices.map(choice=><li key={choice.context.kind+':'+choice.context.id}><button type="button" className="underline"
            onClick={()=>{setTarget(choice);setConfirmed(false);setChoices([]);}}>{kinds[choice.context.kind]}: {choice.label}</button></li>)}</ul>
          {page>1 && <button type="button" onClick={()=>void search(page-1)}>Pagina precedente</button>}
          {more && <button type="button" onClick={()=>void search(page+1)}>Pagina successiva</button>}
        </section>
        <label className="block">Motivo della correzione o del recupero<textarea className={inputClass} required minLength={3} maxLength={2000} value={reason} onChange={event=>setReason(event.target.value)}/></label>
        <div className="rounded-xl border p-4"><h2 className="font-bold">Riepilogo</h2><p>{fileName} · {classification==='ORDINARY'?'Ordinaria':classification==='SENSITIVE'?'Sensibile':'Reclamo'} · {kinds[target.context.kind]}: {target.label}</p>
          <p>{action==='RESTORE'?'Recupero dei byte originali.':selectedFile?'Contenuto dal file selezionato: '+selectedFile:'Correzione dei metadati con i byte originali.'} La fonte e la sua eventuale revoca restano nello storico.</p>
          <label><input type="checkbox" required checked={confirmed} onChange={event=>setConfirmed(event.target.checked)}/> Confermo la nuova versione e la destinazione indicate. La selezionerò esplicitamente nella bozza da usare.</label></div>
        <button className="rounded-xl bg-blue-900 px-4 py-3 font-bold text-white" disabled={!confirmed}>Registra nuova versione</button>
      </fieldset>
    </form> : <p>La gestione dei file richiede l’autorità sulle comunicazioni e l’accesso corrente a questo contesto.</p>}
    {result && <p role="status">{result.message}</p>}
    {result?.stepUp && <InlinePrivilegedConfirmation/>}
    {result?.uncertain && <section className="space-y-3 rounded-xl border border-amber-400 p-4"><p className="break-all">Riferimento del tentativo: {commandId}</p>
      <button disabled={busy} className="block underline" onClick={()=>void reconcile()}>Verifica esito registrato</button>
      {submitted && <button disabled={busy} className="block underline" onClick={()=>void submit(true)}>Riprendi lo stesso comando conservato</button>}
      <label className="block"><input type="checkbox" checked={closeConfirmed} onChange={event=>setCloseConfirmed(event.target.checked)}/> Chiudi il tentativo se non ha prodotto una versione.</label>
      <button disabled={busy||!closeConfirmed} className="block underline" onClick={()=>void reconcile(true)}>Riconcilia e chiudi il tentativo</button>
    </section>}
    {result?.ok && result.receipt && <Link className="block font-bold underline" href={`/admin/communication-files/${result.receipt.id}`}>Apri la nuova versione registrata</Link>}
    {result?.closed && <Link className="block underline" href={`/admin/communication-files/${data.id}`}>Prepara una nuova operazione</Link>}
    <section className="space-y-3"><h2 className="font-bold">Versioni generate da questa fonte</h2>
      {data.children.length ? <ul>{data.children.map(file=><li key={file.id}><Link className="underline" href={`/admin/communication-files/${file.id}`}>{file.fileName} · {file.revokedAt?'Revocata':'Disponibile'}</Link></li>)}</ul> : <p>Nessuna versione successiva accessibile in questa pagina.</p>}
      {data.page>1 && <Link className="mr-4 underline" href={`?page=${data.page-1}`}>Pagina precedente delle versioni</Link>}
      {data.hasMore && <Link className="underline" href={`?page=${data.page+1}`}>Altre versioni</Link>}
    </section>
  </div>;
}
