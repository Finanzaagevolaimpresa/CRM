'use client';
import { useState } from 'react';
const labels = { inclusions: 'Attività incluse', exclusions: 'Attività escluse', phaseDocuments: 'Documenti e fasi',
  timing: 'Tempi di esecuzione', deliverables: 'Risultati da consegnare', subsequentEngagements: 'Incarichi successivi e condizioni separate',
  professionalAttribution: 'Attribuzione professionale facoltativa' };
type Content = Record<keyof typeof labels, string>;
export function AdminCatalogRevisionContent({ digitalProjectTypes, initial, onChange }: { digitalProjectTypes: unknown; initial: string; onChange: (values: Record<string,string>) => void }) {
  const [content, setContent] = useState<Content>(() => {
    let detail: Record<string,unknown> = {};
    try { detail = JSON.parse(initial)?.[4]?.detail ?? {}; } catch {}
    return Object.fromEntries(Object.keys(labels).map(key => [key, Array.isArray(detail[key]) ? (detail[key] as string[]).join('\n') : typeof detail[key] === 'string' ? detail[key] : ''])) as Content;
  });
  function change(name: keyof Content, value: string) {
    const next = { ...content, [name]: value }; setContent(next);
    const detail: Record<string, unknown> = Object.fromEntries(Object.entries(next).map(([key, value]) =>
      [key, ['timing', 'professionalAttribution'].includes(key) ? value.trim() : value.split('\n').map(line => line.trim()).filter(Boolean)]));
    if (!detail.professionalAttribution) delete detail.professionalAttribution;
    if (digitalProjectTypes) detail.digitalProjectTypes = digitalProjectTypes;
    onChange({
      operationalConditions: JSON.stringify(['HUMAN_REVIEW_REQUIRED', 'NO_SUCCESS_FEE', 'NO_AUTOMATIC_EXTERNAL_ACTION',
        'NO_AUTOMATIC_CLIENT_DELIVERY', { catalogVersion: 'FAI_ADMIN_INTERNAL_V1', detail }]),
      checklist: JSON.stringify(['REQUEST_COMPLETE', 'DOCUMENTS_AVAILABLE', 'HUMAN_REVIEW_COMPLETE', { phaseDocuments: detail.phaseDocuments }]),
    });
  }
  return <section className="space-y-3 rounded-xl border p-4" aria-label="Contenuti della revisione catalogo">
    <p>Indica un elemento per riga. I controlli umani e i limiti alle operazioni automatiche restano applicati.</p>
    {Object.entries(labels).map(([key, label]) => <label key={key} className="block font-semibold">{label}
      <textarea required={key !== 'professionalAttribution'} maxLength={20000} rows={3} className="block w-full rounded-xl border p-3"
        value={content[key as keyof Content]} onChange={event => change(key as keyof Content, event.target.value)} /></label>)}
    <button type="button" className="underline" onClick={() => change('timing', content.timing)}>Conferma questi contenuti per la nuova revisione</button>
  </section>;
}
