import type { Client, ClientService, PracticeCommunication, Project, TechnicalPractice } from '@prisma/client';
import { canViewTechnicalPractice, type Actor } from './access-control';

type ClientContext = Pick<Client, 'id' | 'salesOwnerId' | 'consultantId' | 'deletedAt'>;
type ProjectContext = Pick<Project, 'id' | 'clientId' | 'deletedAt'>;
type ServiceContext = Pick<ClientService, 'id' | 'clientId' | 'projectId' | 'deletedAt'>;
type PracticeContext = Pick<TechnicalPractice,
  'id' | 'clientId' | 'projectId' | 'clientServiceId' | 'commercialOwnerId' | 'technicalOwnerId' | 'deletedAt'>;
type CommunicationContext = Pick<PracticeCommunication,
  'id' | 'technicalPracticeId' | 'clientId' | 'projectId' | 'clientServiceId' | 'status' | 'usedAt' | 'deletedAt'>;

type TechnicalCounterContextInput<TPractice extends PracticeContext> = {
  session: Actor;
  practices: readonly TPractice[];
  clients: readonly ClientContext[];
  projects: readonly ProjectContext[];
  services: readonly ServiceContext[];
  communications: readonly CommunicationContext[];
};

// Display permissions are applied by the caller. Parent records are access
// context even when their own list pages are unavailable to the same user.
export function buildDashboardTechnicalCounterContext<TPractice extends PracticeContext>({
  session, practices, clients, projects, services, communications,
}: TechnicalCounterContextInput<TPractice>) {
  const clientById = new Map(clients.filter((client) => !client.deletedAt).map((client) => [client.id, client]));
  const projectById = new Map(projects.filter((project) => !project.deletedAt).map((project) => [project.id, project]));
  const serviceById = new Map(services.filter((service) => !service.deletedAt).map((service) => [service.id, service]));

  // Match the parent checks on the technical-practice list/detail and the
  // canonical practice access used when reviewing communications.
  const visiblePractices = practices.filter((practice) => {
    if (practice.deletedAt) return false;
    const client = clientById.get(practice.clientId);
    const project = practice.projectId ? projectById.get(practice.projectId) : null;
    const service = practice.clientServiceId ? serviceById.get(practice.clientServiceId) : null;
    if (!client) return false;
    if (practice.projectId && (!project || project.clientId !== practice.clientId)) return false;
    if (practice.clientServiceId && (!service || service.clientId !== practice.clientId)) return false;
    const serviceProject = service?.projectId ? projectById.get(service.projectId) : null;
    if (service?.projectId && (!serviceProject || serviceProject.clientId !== practice.clientId)) return false;
    if (project && service?.projectId && service.projectId !== project.id) return false;
    return canViewTechnicalPractice(session, { ...practice, client });
  });
  const practiceById = new Map(visiblePractices.map((practice) => [practice.id, practice]));
  const visibleCommunications: CommunicationContext[] = [];
  let commsToReview = 0;
  let approvedUnusedComms = 0;
  for (const communication of communications) {
    if (communication.deletedAt) continue;
    const practice = practiceById.get(communication.technicalPracticeId);
    // Match the communication-to-practice binding in the client dossier.
    if (!practice || communication.clientId !== practice.clientId
      || (communication.projectId ?? null) !== (practice.projectId ?? null)
      || (communication.clientServiceId ?? null) !== (practice.clientServiceId ?? null)) continue;
    visibleCommunications.push(communication);
    if (communication.status === 'da_revisionare') commsToReview += 1;
    if (communication.status === 'approvata' && communication.usedAt === null) approvedUnusedComms += 1;
  }
  return { visiblePractices, visibleCommunications, commsToReview, approvedUnusedComms };
}
