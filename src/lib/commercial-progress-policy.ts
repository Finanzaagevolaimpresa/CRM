import type { RoleCode, TechnicalPracticeStatus } from '@prisma/client';
import { hasPermission, type PermissionSession } from './permission-evaluator';
import { hasSelectiveContext, type SelectiveProjectScope } from './selective-project-policy';
import { isSelectiveClient, type SelectiveClientScope } from './selective-client-policy';
import { isSelectivePractice, type SelectivePracticeScope } from './selective-practice-policy';

export type CommercialProgressActor = PermissionSession & SelectiveProjectScope & SelectiveClientScope & SelectivePracticeScope & {
  userId: string;
};
export type CommercialProgressContext = {
  client: { id: string; salesOwnerId: string | null; deletedAt: Date | null };
  practice: {
    id: string; clientId: string; projectId: string | null; clientServiceId: string | null;
    commercialOwnerId: string | null; technicalOwnerId: string | null;
    status: TechnicalPracticeStatus; deletedAt: Date | null;
    dueDate: Date | null; nextClientUpdateAt: Date | null; updatedAt: Date;
  };
  project: { id: string; clientId: string; status: string; deletedAt: Date | null } | null;
  service: { id: string; clientId: string; projectId: string | null; status: string; deletedAt: Date | null } | null;
};

const labels: Record<TechnicalPracticeStatus, string> = {
  da_progettare: 'Da avviare', in_progettazione: 'In lavorazione',
  documenti_richiesti: 'Documenti richiesti', documenti_completi: 'Documenti completi',
  pronta_presentazione: 'Pronta per la presentazione', presentata: 'Presentata',
  integrazione_richiesta: 'Integrazione richiesta', in_istruttoria: 'In istruttoria',
  approvata: 'Approvata', respinta: 'Respinta', archiviata: 'Archiviata',
};

/** A separate projection, never a grant to the technical record or client dossier.
 * Both current sales references must agree; inconsistent legacy links fail closed
 * until an explicit assignment operation reconciles them. Technical reassignment
 * has no bearing on this decision. Callers must reload session and context.
 */
export function commercialProgressProjection(actor: CommercialProgressActor, context: CommercialProgressContext) {
  const { client, practice, project, service } = context;
  if (actor.role !== ('commerciale' satisfies RoleCode) || !hasPermission(actor, 'client.read')) return null;
  if (client.deletedAt || practice.deletedAt || practice.status === 'archiviata'
    || client.salesOwnerId !== actor.userId || practice.commercialOwnerId !== actor.userId
    || practice.clientId !== client.id) return null;
  if (isSelectiveClient(actor, client.id) || isSelectivePractice(actor, practice.id)
    || hasSelectiveContext(actor, { ...practice, clientService: service })) return null;
  const projectId = practice.projectId ?? service?.projectId ?? null;
  if (projectId ? !project || project.id !== projectId : project !== null) return null;
  if (practice.clientServiceId ? !service || service.id !== practice.clientServiceId : service !== null) return null;
  if (project && (project.clientId !== client.id || project.deletedAt || project.status === 'archiviato')) return null;
  if (service && (service.clientId !== client.id || service.deletedAt || service.status === 'archiviato'
    || (service.projectId !== null && (!project || project.id !== service.projectId)))) return null;
  if (!Object.hasOwn(labels, practice.status)) return null;
  // No free text, notes, financial identifiers, people, document links or email
  // bodies are returned. Communications require their distinct current access.
  return {
    id: practice.id, clientId: client.id, status: practice.status, statusLabel: labels[practice.status],
    dueDate: practice.dueDate, nextClientUpdateAt: practice.nextClientUpdateAt, updatedAt: practice.updatedAt,
  };
}
