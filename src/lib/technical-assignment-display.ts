import { z } from 'zod';
import { practiceEditableTechnicalFields, practiceTechnicalFields, projectEditableTechnicalFields,
  projectTechnicalFields, type TechnicalAssignmentSelection } from './technical-assignment-contract';

export const technicalFieldLabels = {
  title: 'Titolo', description: 'Descrizione tecnica', status: 'Stato', practiceType: 'Tipo di pratica',
  priority: 'Priorità', dueDate: 'Scadenza', targetEntity: 'Ente destinatario', targetPortal: 'Portale',
  protocolNumber: 'Protocollo', submittedAt: 'Data di presentazione', nextClientUpdateAt: 'Prossimo aggiornamento',
  clientVisibleStatus: 'Avanzamento comunicabile al cliente', integrationRequestNote: 'Integrazione tecnica richiesta',
  technicalOwnerName: 'Responsabile tecnico · nome', commercialOwnerName: 'Referente commerciale · nome',
} as const;
export const technicalActionLabels = {
  update_fields: 'Modificare i campi scelti', update_status: 'Aggiornare lo stato', manage_checklist: 'Gestire la checklist',
  manage_deadlines: 'Gestire le attività e le scadenze', request_admin: 'Chiedere un intervento all’Admin',
  upload_document: 'Caricare documenti tecnici',
} as const;
export const technicalResponsibilityLabels = {
  responsabile: 'Responsabile', co_responsabile: 'Co-responsabile', supporto: 'Supporto tecnico',
} as const;
export const technicalTargetReference = z.object({ kind: z.enum(['Project', 'TechnicalPractice']),
  targetId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/) }).strict();
export type TechnicalTargetReference = z.infer<typeof technicalTargetReference>;

export function technicalFieldCatalogue(kind: TechnicalAssignmentSelection['kind']) {
  const readable = kind === 'Project' ? projectTechnicalFields : practiceTechnicalFields;
  const editable: readonly string[] = kind === 'Project' ? projectEditableTechnicalFields : practiceEditableTechnicalFields;
  return readable.map(key => ({ key, label: technicalFieldLabels[key], editable: editable.includes(key) }));
}
/** Explicit field projection for a management preview, never a spread of the
 * target record. A missing or malformed chosen value invalidates the preview. */
export function technicalFieldPreview(kind: TechnicalAssignmentSelection['kind'], fields: readonly string[],
  row: Readonly<Record<string, unknown>>) {
  const catalogue = technicalFieldCatalogue(kind);
  if (new Set(fields).size !== fields.length) throw new Error('TECHNICAL_ASSIGNMENT_INVALID_FIELDS');
  return fields.map(key => {
    const item = catalogue.find(field => field.key === key);
    if (!item || !Object.hasOwn(row, key)) throw new Error('TECHNICAL_ASSIGNMENT_INVALID_FIELDS');
    const value = row[key];
    if (value === null || typeof value === 'string') return { key: item.key, label: item.label, value };
    if (['dueDate', 'submittedAt', 'nextClientUpdateAt'].includes(key) && value instanceof Date && Number.isFinite(value.getTime())) {
      return { key: item.key, label: item.label, value: value.toISOString() };
    }
    throw new Error('TECHNICAL_ASSIGNMENT_INVALID_FIELDS');
  });
}
export function technicalManagementPath(target: TechnicalTargetReference) {
  const ref = technicalTargetReference.parse({ kind: target.kind, targetId: target.targetId });
  return ref.kind === 'Project' ? `/projects/${ref.targetId}/assignments`
    : `/technical-office/practices/${ref.targetId}/assignments`;
}
export function technicalWorkPath(target: TechnicalTargetReference) {
  const ref = technicalTargetReference.parse({ kind: target.kind, targetId: target.targetId });
  return `/technical-work/${ref.kind === 'Project' ? 'projects' : 'practices'}/${ref.targetId}`;
}
