'use client';
import { useActionState, useState } from 'react';
import { prepareProformaEmailAction, recordProformaArchiveAction } from '@/lib/operational-document-delivery-actions';
import { InlinePrivilegedConfirmation } from './inline-privileged-confirmation';
import { useInteractiveReady } from './interactive-ready-marker';
const field = 'w-full rounded-xl border p-3', button = 'rounded-xl bg-fai-green px-5 py-3 font-bold text-white disabled:opacity-50';
type Base = { documentId: string; contentHash: string; commandId: string };
export function ProformaEmailForm(props: Base & { email: string; mailboxes: { id: string; address: string }[] }) {
  const ready = useInteractiveReady();
  const [commandId] = useState(props.commandId), [values, setValues] = useState({ mailboxId: '', to: props.email, subject: 'Proforma per il servizio concordato', body: 'In allegato la proforma del servizio concordato. Rimaniamo a disposizione per eventuali chiarimenti.' });
  const [confirmed, setConfirmed] = useState(false), [state, action, pending] = useActionState(prepareProformaEmailAction, { error: null });
  const change = (name: keyof typeof values, value: string) => { setValues(current => ({ ...current, [name]: value })); setConfirmed(false); };
  return <><form action={action} data-interactive-ready={ready}><fieldset disabled={!ready} className="space-y-3"><input type="hidden" name="documentId" value={props.documentId}/><input type="hidden" name="contentHash" value={props.contentHash}/><input type="hidden" name="commandId" value={commandId}/>
    <label className="block">Mittente aziendale<select name="mailboxId" aria-label="Mittente aziendale" className={field} required value={values.mailboxId} onChange={event => change('mailboxId', event.target.value)}><option value="">Seleziona mittente</option>{props.mailboxes.map(row => <option key={row.id} value={row.id}>{row.address}</option>)}</select></label>
    <label className="block">Destinatario<input name="to" type="email" className={field} required value={values.to} onChange={event => change('to', event.target.value)}/></label>
    <label className="block">Oggetto<input name="subject" className={field} required maxLength={200} value={values.subject} onChange={event => change('subject', event.target.value)}/></label>
    <label className="block">Testo autorizzato per il caso<textarea name="body" aria-label="Testo autorizzato per il caso" className={field} rows={5} required maxLength={12000} value={values.body} onChange={event => change('body', event.target.value)}/></label>
    <label className="block"><input type="checkbox" name="confirmed" required checked={confirmed} onChange={event => setConfirmed(event.target.checked)}/> Ho verificato destinatario, testo e anteprima PDF. Preparo la bozza da sottoporre alle approvazioni della posta.</label>
    {state.error && <p role="alert">{state.error}</p>}<button disabled={pending} className={button}>Prepara bozza email con PDF</button>
  </fieldset></form>{state.stepUpRequired && <InlinePrivilegedConfirmation/>}</>;
}
export function ProformaArchiveForm(props: Base & { pdfSha256: string; folders: { id: string; title: string }[] }) {
  const ready = useInteractiveReady();
  const [commandId] = useState(props.commandId), [values, setValues] = useState({ folderId: '', fileUrl: '', evidence: '', occurredAt: '' });
  const [checks, setChecks] = useState({ confirmed: false, folderMembershipConfirmed: false, accessConfirmed: false });
  const [state, action, pending] = useActionState(recordProformaArchiveAction, { error: null });
  const change = (name: keyof typeof values, value: string) => { setValues(current => ({ ...current, [name]: value })); setChecks({ confirmed: false, folderMembershipConfirmed: false, accessConfirmed: false }); };
  return <><form action={action} data-interactive-ready={ready}><fieldset disabled={!ready} className="space-y-3"><input type="hidden" name="documentId" value={props.documentId}/><input type="hidden" name="contentHash" value={props.contentHash}/><input type="hidden" name="commandId" value={commandId}/><input type="hidden" name="pdfSha256" value={props.pdfSha256}/>
    <p className="break-all text-sm">SHA256 del PDF da confrontare con il file archiviato: {props.pdfSha256}</p>
    <label className="block">Cartella del fascicolo<select name="folderId" aria-label="Cartella del fascicolo" className={field} required value={values.folderId} onChange={event => change('folderId', event.target.value)}><option value="">Seleziona cartella</option>{props.folders.map(row => <option key={row.id} value={row.id}>{row.title}</option>)}</select></label>
    <label className="block">Link del PDF già archiviato in Drive<input name="fileUrl" type="url" required className={field} value={values.fileUrl} onChange={event => change('fileUrl', event.target.value)}/></label>
    <label className="block">Data e ora dell’archiviazione<input name="occurredAt" type="datetime-local" required className={field} value={values.occurredAt} onChange={event => change('occurredAt', event.target.value)}/></label>
    <label className="block">Evidenza della verifica<textarea name="evidence" aria-label="Evidenza della verifica" required minLength={10} maxLength={1000} className={field} value={values.evidence} onChange={event => change('evidence', event.target.value)}/></label>
    {Object.entries({ confirmed: 'Ho confrontato l’hash del file archiviato con il PDF di questa versione.', folderMembershipConfirmed: 'Ho verificato che il file si trova nella cartella indicata.', accessConfirmed: 'Ho verificato i permessi Google per i destinatari autorizzati.' }).map(([name, label]) => <label key={name} className="block"><input type="checkbox" name={name} required checked={checks[name as keyof typeof checks]} onChange={event => setChecks(current => ({ ...current, [name]: event.target.checked }))}/> {label}</label>)}
    {state.error && <p role="alert">{state.error}</p>}<button disabled={pending} className={button}>Registra evidenza archivio Drive</button>
  </fieldset></form>{state.stepUpRequired && <InlinePrivilegedConfirmation/>}</>;
}
