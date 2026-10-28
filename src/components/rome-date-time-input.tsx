'use client';

import { useId, useRef, useState } from 'react';
import { resolveRomeDateTime, romeDateTimeInput, romeOffsetLabel } from '@/lib/rome-date-time';

/** Native validation also blocks an ambiguous or nonexistent local time before submit. */
export function RomeDateTimeInput({ value, onChange, label, name, required = false, disabled = false, className }:
  { value?: string | null; onChange?: (instant: string) => void; label: string; name?: string;
    required?: boolean; disabled?: boolean; className?: string }) {
  const id = useId(), input = useRef<HTMLInputElement>(null);
  const [wall, setWall] = useState(() => romeDateTimeInput(value));
  const [instant, setInstant] = useState(value ?? '');
  const resolution = resolveRomeDateTime(wall);
  const selected = resolution.instants.find(candidate => Math.floor(Date.parse(candidate) / 1000) === Math.floor(Date.parse(instant) / 1000)) ?? '';
  function choose(nextWall: string, choice?: string) {
    const result = resolveRomeDateTime(nextWall);
    const next = result.kind === 'unique' ? result.instants[0]
      : result.kind === 'ambiguous' && choice && result.instants.includes(choice) ? choice : '';
    setWall(nextWall); setInstant(next); onChange?.(next);
    input.current?.setCustomValidity(result.kind === 'invalid' ? 'Questo orario non esiste in Europe/Rome o non è valido.'
      : result.kind === 'ambiguous' && !next ? 'Scegli quale delle due occorrenze dell’orario intendi.' : '');
  }
  return <div className="min-w-0 space-y-2">
    <label htmlFor={id} className="block font-semibold">{label} · Europe/Rome</label>
    <input ref={input} id={id} aria-describedby={`${id}-zone`} type="datetime-local" step="1" className={className}
      value={wall} required={required} disabled={disabled} onChange={event => choose(event.target.value)} />
    {name && <input type="hidden" name={name} value={instant} disabled={disabled} />}
    <p id={`${id}-zone`} className="text-sm">L’ora inserita è quella di Roma, anche se il dispositivo usa un altro fuso.</p>
    {resolution.kind === 'invalid' && <p role="alert">Orario non valido o inesistente per il cambio d’ora. Scegli un altro orario.</p>}
    {resolution.kind === 'ambiguous' && <label className="block text-sm">Occorrenza del cambio d’ora
      <select aria-label={`${label}: occorrenza`} className={className} value={selected} disabled={disabled} required
        onChange={event => choose(wall, event.target.value)}>
        <option value="">Scegli l’occorrenza</option>{resolution.instants.map((candidate, index) =>
          <option key={candidate} value={candidate}>{index === 0 ? 'Prima' : 'Seconda'} · {romeOffsetLabel(candidate)} · {candidate}</option>)}
      </select></label>}
    {instant && <p className="break-words text-xs text-slate-600">Ora confermata: {romeOffsetLabel(instant)} · Europe/Rome</p>}
  </div>;
}
