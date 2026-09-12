import { canViewClient, canViewProject, type Actor } from './access-control';

type ActiveClientContext = {
  id: string;
  salesOwnerId: string | null;
  consultantId: string | null;
  deletedAt?: Date | null;
};

type ActiveProjectContext = {
  id: string;
  clientId: string;
  consultantId: string | null;
  deletedAt?: Date | null;
};

type PaymentListContext = {
  payment: { clientId: string; contractId: string };
  contract: { id: string; clientId: string; projectId: string | null } | null;
  client: ActiveClientContext | null;
  project: ActiveProjectContext | null;
};

type PreAnalysisListContext = {
  preAnalysis: { clientId: string; projectId: string | null; companyId: string | null };
  client: ActiveClientContext | null;
  project: ActiveProjectContext | null;
  company: { id: string; clientId: string; deletedAt?: Date | null } | null;
};

// List rows and complete dashboard totals use the same visibility predicate.
// Missing deletedAt means the caller loaded an already-filtered active parent.
export function canViewPaymentListRecord(session: Actor, {
  payment, contract, client, project,
}: PaymentListContext): boolean {
  if (!client || client.deletedAt || client.id !== payment.clientId || !canViewClient(session, client)) return false;
  if (!contract || contract.id !== payment.contractId || contract.clientId !== payment.clientId) return false;
  if (!contract.projectId) return true;
  if (!project || project.deletedAt || project.id !== contract.projectId || project.clientId !== payment.clientId) return false;
  return canViewProject(session, { ...project, client });
}

export function canViewPreAnalysisListRecord(session: Actor, {
  preAnalysis, client, project, company,
}: PreAnalysisListContext): boolean {
  if (!client || client.deletedAt || client.id !== preAnalysis.clientId || !canViewClient(session, client)) return false;
  if (!preAnalysis.projectId || !project || project.deletedAt
    || project.id !== preAnalysis.projectId || project.clientId !== preAnalysis.clientId) return false;
  if (!canViewProject(session, { ...project, client })) return false;
  if (preAnalysis.companyId && (!company || company.deletedAt
    || company.id !== preAnalysis.companyId || company.clientId !== preAnalysis.clientId)) return false;
  return true;
}
