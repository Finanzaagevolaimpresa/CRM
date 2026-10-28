'use client';
import Link from 'next/link';
import { useState, useSyncExternalStore } from 'react';
import type { readProjectHandoff, previewProjectHandoff } from '@/lib/project-handoff';
import type { ProjectHandoffInput } from '@/lib/project-handoff-contract';
import { previewProjectHandoffAction, confirmProjectHandoffAction, verifyProjectHandoffAction } from '@/lib/project-handoff-actions';
type Setup = Awaited<ReturnType<typeof readProjectHandoff>>;
type Preview = Awaited<ReturnType<typeof previewProjectHandoff>>;
const subscribe = () => () => {};
const field = 'w-full min-w-0 rounded-xl border border-slate-300 bg-white px-3 py-2';
const button = 'rounded-xl bg-fai-blue px-4 py-2 font-bold text-white disabled:opacity-50';
export function ProjectHandoffForm({ setup, resumeCommandId }: { setup: Setup; resumeCommandId?: string }) {
  const ready = useSyncExternalStore(subscribe, () => true, () => false);
  const [title, setTitle] = useState(setup.projectTitle);
  const [practiceType, setPracticeType] = useState('');
  const [entity, setEntity] = useState('');
  const [commercial, setCommercial] = useState(setup.commercialOwnerId ?? '');
  const [technical, setTechnical] = useState(setup.technicalOwnerId ?? '');
  const [command, setCommand] = useState<ProjectHandoffInput | null>(null);
  const [commandId, setCommandId] = useState(resumeCommandId ?? '');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false), [consent, setConsent] = useState(false);
  const [uncertain, setUncertain] = useState(Boolean(resumeCommandId));
  const [practiceId, setPracticeId] = useState(''), [message, setMessage] = useState('');
  const locked = busy || Boolean(preview) || uncertain || Boolean(practiceId);
  function remember(id: string) {
    const url = new URL(location.href); if (id) url.searchParams.set('command', id); else url.searchParams.delete('command');
    history.replaceState(null, '', url.pathname + url.search);
  }
  async function prepare() {
    setBusy(true); setMessage(''); setConsent(false);
    const input: ProjectHandoffInput = { commandId: crypto.randomUUID(), projectId: setup.projectId, expectedHash: setup.expectedHash,
      title, practiceType, targetEntity: entity, commercialOwnerId: commercial || null, technicalOwnerId: technical || null };
    try {
      const result = await previewProjectHandoffAction(input);
      if (result.ok) { setCommand(input); setCommandId(input.commandId); setPreview(result.preview); }
      else setMessage(result.message);
    } catch { setMessage('Riepilogo non disponibile. Nessun salvataggio richiesto.'); }
    finally { setBusy(false); }
  }
  async function confirm() {
    if (!command || !preview || !consent || busy) return;
    setBusy(true); remember(command.commandId);
    try {
      const { digest, expiresAt, proof } = preview;
      const result = await confirmProjectHandoffAction(command, { digest, expiresAt, proof });
      if (result.ok) { setPracticeId(result.result.practiceId); setMessage('Pratica preparata. La presa in carico e l’avvio del servizio restano da verificare.'); }
      else {
        setMessage(result.message); setUncertain(!result.definite);
        if (result.definite) { setPreview(null); setCommand(null); remember(''); }
      }
    } catch { setUncertain(true); setMessage('Risposta non ricevuta. Verifica l’esito prima di qualsiasi altra creazione.'); }
    finally { setBusy(false); }
  }
  async function verify() {
    if (!commandId || busy) return;
    setBusy(true);
    try {
      const result = await verifyProjectHandoffAction(setup.projectId, commandId);
      if (result.ok && result.result.confirmed) { setPracticeId(result.result.practiceId); setUncertain(false); setMessage('Preparazione già registrata. Apri la pratica esistente.'); }
      else setMessage(result.ok ? 'Decisione non osservata. Non ripetere la creazione finché l’esito non è riconciliato.' : result.message);
    } catch { setMessage('Verifica non disponibile. Non ripetere la creazione.'); }
    finally { setBusy(false); }
  }
  return <div data-testid="project-handoff-form" data-interactive-ready={ready} className="crm-space-y-4">
    <p>Cliente: <strong>{setup.clientName}</strong>. Progetto: <strong>{setup.projectTitle}</strong>.</p>
    <p>Verrà preparata una pratica «Da progettare». Questa operazione non avvia il servizio, non presenta domande e non invia comunicazioni. I documenti e gli incarichi personali vanno scelti separatamente.</p>
    <fieldset disabled={locked || !ready} className="grid min-w-0 gap-4 md:grid-cols-2">
      <label>Titolo pratica<input aria-label="Titolo pratica" className={field} maxLength={240} value={title} onChange={e => setTitle(e.target.value)}/></label>
      <label>Tipologia pratica<input aria-label="Tipologia pratica" className={field} maxLength={120} value={practiceType} onChange={e => setPracticeType(e.target.value)}/></label>
      <label className="md:col-span-2">Ente destinatario o da definire<input aria-label="Ente destinatario o da definire" className={field} maxLength={240} value={entity} onChange={e => setEntity(e.target.value)}/></label>
      <label>Referente commerciale<select aria-label="Referente commerciale" className={field} value={commercial} onChange={e => setCommercial(e.target.value)}><option value="">Da individuare</option>{setup.commercialPeople.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
      <label>Responsabile tecnico iniziale<select aria-label="Responsabile tecnico iniziale" className={field} value={technical} onChange={e => setTechnical(e.target.value)}><option value="">Da individuare</option>{setup.technicalPeople.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
      <p className="md:col-span-2 text-sm">I suggerimenti provengono dal referente attuale del cliente e dal responsabile del progetto. Confermali qui per la nuova pratica: il referente del cliente e gli incarichi personali esistenti non cambiano.</p>
      <button className={button} type="button" onClick={prepare}>Controlla il passaggio</button>
    </fieldset>
    {preview && !practiceId && <section aria-label="Riepilogo passaggio" className="crm-space-y-3 rounded-xl border p-4">
      <h2 className="font-bold">Riepilogo passaggio</h2><p>{command?.title} · {command?.practiceType} · {command?.targetEntity}</p>
      <p>Commerciale: {preview.commercialName ?? 'Da individuare'}. Tecnico: {preview.technicalName ?? 'Da individuare'}.</p>
      <p>Stato iniziale: da progettare. Presa in carico: non registrata. Nessun documento o accesso copiato.</p>
      <label className="flex items-start gap-2"><input type="checkbox" disabled={busy || uncertain} checked={consent} onChange={e => setConsent(e.target.checked)}/>Confermo i dati e le responsabilità iniziali di questa pratica</label>
      <div className="flex flex-wrap gap-3"><button type="button" className={button} disabled={!consent || busy || uncertain} onClick={confirm}>Prepara pratica</button>
        <button type="button" className="rounded-xl border px-4 py-2" disabled={busy || uncertain} onClick={() => { setPreview(null); setConsent(false); }}>Modifica riepilogo</button></div>
    </section>}
    {message && <p role="status" className="rounded-xl bg-slate-100 p-3">{message}</p>}
    {uncertain && <button type="button" className={button} disabled={busy} onClick={verify}>Verifica esito</button>}
    {practiceId && <Link className="inline-block font-bold underline" href={`/technical-office/practices/${practiceId}`}>Apri pratica preparata</Link>}
  </div>;
}
