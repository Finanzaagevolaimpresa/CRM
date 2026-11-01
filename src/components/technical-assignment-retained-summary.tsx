import type { readTechnicalAssignmentManagement } from '@/lib/technical-assignment-management';
import { technicalActionLabels, technicalFieldLabels, technicalResponsibilityLabels } from '@/lib/technical-assignment-display';
import { technicalItemFieldLabels } from '@/lib/technical-work-item-grant';
import { operationalRomeTime as when } from '@/lib/operational-time';

type Assignment = Pick<Awaited<ReturnType<typeof readTechnicalAssignmentManagement>>['assignments'][number], 'selection' | 'revision' | 'revokedAt'>;
export function TechnicalAssignmentRetainedSummary({ assignment, observedAt }: { assignment: Assignment; observedAt: string }) {
  const s = assignment.selection;
  const status = assignment.revokedAt ? 'Revocato'
    : Date.parse(s.expiresAt) <= Date.parse(observedAt) ? 'Scaduto' : 'Registrato; accesso soggetto alle verifiche correnti';
  return <div className="min-w-0 space-y-2" aria-label="Perimetro registrato">
    <p>{technicalResponsibilityLabels[s.responsibility]} · {status} · revisione {assignment.revision} · scadenza {when(s.expiresAt)}</p>
    {assignment.revokedAt && <p>Revocato il {when(assignment.revokedAt)}</p>}
    <p>Campi: {s.readableFields.map(field => technicalFieldLabels[field]).join(', ')}</p>
    <p>Campi modificabili: {s.editableFields.length ? s.editableFields.map(field => technicalFieldLabels[field]).join(', ') : 'Nessuno'}</p>
    <p>Operazioni: {s.actions.map(action => technicalActionLabels[action]).join(', ')}</p>
    <h4 className="font-bold">Versioni documentali registrate · {s.documents.length}</h4>
    {!s.documents.length ? <p>Nessuna versione documentale registrata in questo incarico.</p> : <ul className="space-y-2">{s.documents.map(doc =>
      <li key={doc.fileId} className="break-words">Documento {doc.documentId} · versione {doc.version} · file {doc.fileId} · Lettura registrata · {doc.allowDownload ? 'Download concesso' : 'Download non concesso'}</li>)}</ul>}
    <p>Il riepilogo descrive la decisione registrata. Revoca, scadenza, stato del documento e permessi correnti restano verificati a ogni accesso; le versioni future restano escluse.</p>
    <h4 className="font-bold">Attività e checklist registrate · {s.workItems?.length ?? 0}</h4>
    {!s.workItems?.length ? <p>Nessuna attività o checklist registrata in questo incarico.</p> : <ul className="space-y-2">{s.workItems.map(item =>
      <li key={item.kind + ':' + item.itemId} className="break-words">{item.kind === 'Task' ? 'Attività' : 'Checklist'} · {item.itemId} · Campi: {item.readableFields.map(field => technicalItemFieldLabels[field]).join(', ')} · Modificabili: {item.editableFields.length ? item.editableFields.map(field => technicalItemFieldLabels[field]).join(', ') : 'Nessuno'}</li>)}</ul>}
    {s.actions.includes('upload_document') && (s.uploadProfile ? <div className="space-y-1">
      <h4 className="font-bold">Deposito privato registrato</h4>
      <p className="break-words">Scopo: {s.uploadProfile.purpose}</p>
      <p>Formati: {s.uploadProfile.formats.join(', ')} · Massimo {s.uploadProfile.maxFilesPerRevision} file · {s.uploadProfile.maxFileBytes} byte per file · {s.uploadProfile.maxBytesPerRevision} byte totali</p>
      <p>Il deposito richiede revisione personale e non condivide automaticamente i documenti.</p>
    </div> : <p>Profilo di deposito assente nella decisione storica: nessun caricamento ammesso da questa selezione.</p>)}
  </div>;
}
