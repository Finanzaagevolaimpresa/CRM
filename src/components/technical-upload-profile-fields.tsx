'use client';

import { documentUploadExtensions } from '@/lib/document-upload-contract';
import type { TechnicalUploadProfile } from '@/lib/technical-upload-profile';
export type UploadProfileChoices = { purpose: string; formats: TechnicalUploadProfile['formats']; fileMiB: string; files: string; totalMiB: string };
export const emptyUploadProfile: UploadProfileChoices = { purpose: '', formats: [], fileMiB: '', files: '', totalMiB: '' };
export function uploadProfileFromChoices(value: UploadProfileChoices) {
  return { purpose: value.purpose, formats: value.formats, maxFileBytes: Number(value.fileMiB) * 1048576,
    maxFilesPerRevision: Number(value.files), maxBytesPerRevision: Number(value.totalMiB) * 1048576,
    visibility: 'PRIVATE_PENDING_ADMIN_REVIEW' as const };
}
const control = 'block w-full min-w-0 rounded-xl border border-slate-300 bg-white p-3';
export function TechnicalUploadProfileFields({ value, onChange }: { value: UploadProfileChoices; onChange: (value: UploadProfileChoices) => void }) {
  return <fieldset className="min-w-0 space-y-3 rounded-xl border border-blue-300 p-4"><legend className="font-bold">Deposito privato dei documenti tecnici</legend>
    <p>Il tecnico deposita nel proprio incarico. Tu revisioni ogni file; il deposito e la sua approvazione non pubblicano documenti nel fascicolo e non concedono accessi ad altre persone.</p>
    <label className="block font-semibold">Scopo del caricamento<input className={control} value={value.purpose} minLength={3} maxLength={160} required
      onChange={event => onChange({ ...value, purpose: event.target.value })} /></label>
    <fieldset><legend className="font-semibold">Formati ammessi</legend><div className="flex flex-wrap gap-3">{documentUploadExtensions.filter(f => f !== '.zip').map(format =>
      <label key={format} className="flex items-center gap-2"><input type="checkbox" checked={value.formats.includes(format)} onChange={event => onChange({ ...value,
        formats: event.target.checked ? [...value.formats, format] : value.formats.filter(f => f !== format) })} />{format}</label>)}</div></fieldset>
    <div className="grid gap-3 sm:grid-cols-3"><label className="block font-semibold">Dimensione massima per file (MiB)<input type="number" className={control} min={1} max={25} step={1} required value={value.fileMiB}
      onChange={event => onChange({ ...value, fileMiB: event.target.value })} /></label>
      <label className="block font-semibold">Numero massimo di file<input type="number" className={control} min={1} max={20} step={1} required value={value.files}
        onChange={event => onChange({ ...value, files: event.target.value })} /></label>
      <label className="block font-semibold">Spazio totale massimo (MiB)<input type="number" className={control} min={1} max={500} step={1} required value={value.totalMiB}
        onChange={event => onChange({ ...value, totalMiB: event.target.value })} /></label></div>
    <p className="text-sm">Le quote valgono per questa versione dell’incarico e comprendono i file rifiutati o trattenuti dopo un’interruzione. Nessuna cancellazione automatica.</p>
  </fieldset>;
}
