'use client';

import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { confirmOrdinaryEmailAction, previewOrdinaryEmailAction, rejectOrdinaryEmailAction } from '@/lib/ordinary-email-actions';
import { ordinaryPreviewMatches, type OrdinaryEmailPreview } from '@/lib/ordinary-email-ui-contract';

const button = 'rounded-xl border px-4 py-2 font-bold disabled:cursor-not-allowed disabled:opacity-50';
const subscribe = () => () => {};
const browserReady = () => true;
const serverReady = () => false;
type Props = { messageId: string; revision: number; snapshotHash: string; eligible: boolean; stepUpActive: boolean; children: ReactNode };

export function OrdinaryEmailReview({ children, ...shown }: Props) {
  const ready = useSyncExternalStore(subscribe, browserReady, serverReady);
  const router = useRouter(), epoch = useRef(0), busyRef = useRef(false);
  const [preview, setPreview] = useState<OrdinaryEmailPreview | null>(null);
  const [dirty, setDirty] = useState(false), [busy, setBusy] = useState(false), [confirmed, setConfirmed] = useState(false);
  const [sendConfirmed, setSendConfirmed] = useState(false);
  const [checkCurrent, setCheckCurrent] = useState(false), [notice, setNotice] = useState('');
  useEffect(() => {
    function invalidate() { epoch.current++; setPreview(null); setConfirmed(false); setSendConfirmed(false); }
    const timer = preview ? window.setTimeout(() => { invalidate(); setNotice('Anteprima scaduta. Aprila di nuovo per verificare la versione corrente.'); }, Math.max(0, new Date(preview.expiresAt).getTime() - Date.now())) : undefined;
    function hidden() { if (document.visibilityState === 'hidden') invalidate(); }
    function restored(event: PageTransitionEvent) { if (event.persisted) invalidate(); }
    document.addEventListener('visibilitychange', hidden); window.addEventListener('pageshow', restored);
    return () => { window.clearTimeout(timer); document.removeEventListener('visibilitychange', hidden); window.removeEventListener('pageshow', restored); };
  }, [preview]);

  async function openPreview() {
    if (!ready || busyRef.current || dirty || checkCurrent || !shown.eligible) return;
    busyRef.current = true; setBusy(true); setConfirmed(false); setSendConfirmed(false); setPreview(null); setNotice('');
    const started = ++epoch.current;
    try {
      const result = await previewOrdinaryEmailAction({ messageId: shown.messageId });
      if (started !== epoch.current) return;
      if (result.status !== 'READY' || !ordinaryPreviewMatches(result.preview, shown, Date.now())) {
        setCheckCurrent(true); setNotice('Versione o accesso non più disponibili. Aggiorna la comunicazione.'); return;
      }
      setPreview(result.preview);
    } catch { if (started === epoch.current) setNotice('Anteprima non disponibile. Verifica la connessione e aggiorna la comunicazione.'); }
    finally { busyRef.current = false; setBusy(false); }
  }

  async function refuse() {
    if (busyRef.current || dirty || checkCurrent || !confirmed || !shown.stepUpActive || !preview
      || !ordinaryPreviewMatches(preview, shown, Date.now())) return;
    busyRef.current = true; setBusy(true); setConfirmed(false); setSendConfirmed(false);
    // Discard the proof before the mutation. Failure/lost response never offers
    // a retry; only a fresh page/current persisted revision can start again.
    setPreview(null); setCheckCurrent(true); ++epoch.current;
    try {
      const result = await rejectOrdinaryEmailAction({ messageId: shown.messageId, expectedRevision: preview.revision,
        snapshotHash: preview.snapshotHash, personalConfirmation: 'RIFIUTO_QUESTA_VERSIONE' });
      setNotice(result.status === 'REJECTED' ? `Rifiuto registrato. Nuova bozza v${result.revision}, da approvare.`
        : 'Esito da verificare. Aggiorna la comunicazione e consulta la timeline prima di altre decisioni.');
      if (result.status === 'REJECTED') router.refresh();
    } catch { setNotice('Risposta non ricevuta. Aggiorna la comunicazione e consulta la timeline. Il rifiuto non verrà ripetuto automaticamente.'); }
    finally { busyRef.current = false; setBusy(false); }
  }

  async function send() {
    if (busyRef.current || dirty || checkCurrent || !sendConfirmed || !shown.stepUpActive || !preview?.sendAvailable
      || !ordinaryPreviewMatches(preview, shown, Date.now())) return;
    busyRef.current = true; setBusy(true); setConfirmed(false); setSendConfirmed(false);
    setPreview(null); setCheckCurrent(true); ++epoch.current;
    try {
      const result = await confirmOrdinaryEmailAction({ messageId: shown.messageId, requestId: crypto.randomUUID(),
        previewToken: preview.token, personalConfirmation: 'APPROVO_E_INVIO_IL_MESSAGGIO_ESATTO' });
      setNotice(result.status === 'CHECK_CURRENT' ? 'Esito da verificare. Aggiorna la comunicazione e consulta le ricevute. Non ripetere l’invio.'
        : result.outcome === 'ACCEPTED' ? 'Accettata dal server. Consulta la ricevuta: non certifica la consegna o la lettura.'
        : result.outcome === 'NOT_SENT' ? 'Invio non avvenuto. Consulta la ricevuta prima di una nuova decisione.'
        : 'Esito incerto. Consulta la ricevuta e non ripetere l’invio.');
      if (result.status === 'RECORDED') router.refresh();
    } catch { setNotice('Risposta non ricevuta. Aggiorna la comunicazione e consulta le ricevute. L’invio non verrà ripetuto automaticamente.'); }
    finally { busyRef.current = false; setBusy(false); }
  }

  return <div data-ordinary-ready={String(ready)} onInputCapture={event => {
    if (!(event.target instanceof Element) || !event.target.closest('form[data-message-draft]')) return;
    epoch.current++; setDirty(true); setPreview(null); setConfirmed(false); setSendConfirmed(false);
    setNotice('Modifiche non salvate: salva la nuova versione prima di aprire un’altra anteprima.');
  }}>
    {children}
    {shown.eligible ? <section aria-label="Decisione personale email" className="mt-4 grid min-w-0 gap-3 rounded-xl border p-4">
      <h3 className="font-bold">Email ordinaria · versione salvata {shown.revision}</h3>
      <p className="text-sm">Verifica mittente, destinatari, testo e versioni degli allegati prima della tua decisione.</p>
      <div className="flex flex-wrap gap-3"><button type="button" className={button} disabled={!ready || busy || dirty || checkCurrent} onClick={openPreview}>Anteprima email ordinaria</button>
        {checkCurrent ? <button type="button" className={button} disabled={busy} onClick={() => window.location.reload()}>Aggiorna comunicazione</button> : null}</div>
      {notice ? <p role="status" className="text-sm">{notice}</p> : null}
      {preview ? <section aria-label="Anteprima della versione esatta" className="grid min-w-0 gap-3 rounded-xl bg-slate-50 p-4">
        <h4 className="font-bold break-words">{preview.summary.subject} · v{preview.revision}</h4>
        <dl className="grid gap-1 break-words text-sm">
          {([['Da', preview.summary.from], ['Reply-To', preview.summary.replyTo], ['A', preview.summary.to.join(', ')],
            ['CC', preview.summary.cc.join(', ') || 'Nessuna'], ['BCC', preview.summary.bcc.join(', ') || 'Nessuna']] as const).map(([label, value]) =>
            <div key={label}><dt className="inline font-bold">{label}: </dt><dd className="inline break-all">{value}</dd></div>)}
        </dl>
        <p className="whitespace-pre-wrap break-words">{preview.summary.body}</p>
        <ul className="grid gap-2 break-all text-sm" aria-label="Versioni esatte degli allegati">
          {preview.summary.attachments.map(file => <li key={file.versionId}><b>{file.filename}</b> · {file.bytes} byte<br />Versione {file.versionId}<br />SHA256 {file.sha256}</li>)}
        </ul>
        <p className="text-sm">Anteprima valida fino a <time dateTime={preview.expiresAt}>{new Date(preview.expiresAt).toLocaleTimeString('it-IT')}</time>. Ogni modifica richiede una nuova verifica.</p>
        <details className="text-xs break-all"><summary>Impronta della versione</summary>{preview.snapshotHash}</details>
        <p className="text-sm">Il rifiuto conserva questa versione e le sue approvazioni. Il messaggio torna in una nuova bozza da approvare.</p>
        {!shown.stepUpActive ? <p className="text-sm"><Link className="font-bold underline" href="/settings/security">Conferma la tua identità</Link> prima di decidere, poi riapri questa anteprima.</p> : null}
        {preview.sendAvailable ? <div className="grid gap-3 rounded-xl border p-3">
          <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={sendConfirmed} disabled={!shown.stepUpActive || busy}
            onChange={event => { setSendConfirmed(event.target.checked); setConfirmed(false); }} />Approvo e invio personalmente questa versione esatta, inclusi mittente, destinatari, testo e allegati.</label>
          <button type="button" className={button} disabled={!sendConfirmed || !shown.stepUpActive || busy || dirty || checkCurrent} onClick={send}>Approva e invia</button>
          <p className="text-sm">Verrà eseguito un solo tentativo. Una ricevuta del server non certifica consegna o lettura.</p>
        </div> : <p className="text-sm">Invio ordinario non disponibile per questa configurazione. Puoi rifiutare la versione se autorizzato.</p>}
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={confirmed} disabled={!shown.stepUpActive || busy}
          onChange={event => { setConfirmed(event.target.checked); setSendConfirmed(false); }} />Rifiuto personalmente questa versione esatta.</label>
        <button type="button" className={button} disabled={!confirmed || !shown.stepUpActive || busy || dirty || checkCurrent} onClick={refuse}>Rifiuta versione {preview.revision}</button>
      </section> : null}
      <p className="text-sm text-slate-600">L’anteprima e il rifiuto non inviano messaggi. L’invio richiede la tua decisione sulla versione esatta e un canale attualmente qualificato.</p>
    </section> : null}
  </div>;
}
