import type { Permission } from './auth';

export function dashboardAreaVisible(permissions: readonly Permission[], area: Permission) {
  return permissions.includes(area);
}

export function clientSectionVisible(permissions: readonly Permission[], section: 'dossier' | 'contratti' | 'pagamenti' | 'ufficio-tecnico-pratiche') {
  const required: Record<typeof section, Permission> = {
    dossier: 'dossier.read',
    contratti: 'contract.read',
    pagamenti: 'payment.read',
    'ufficio-tecnico-pratiche': 'technical.read',
  };
  return permissions.includes(required[section]);
}

export function reportSectionVisible(permissions: readonly Permission[], section: 'services' | 'projects' | 'documents' | 'dossiers' | 'ai' | 'technical' | 'communications' | 'audit' | 'contracts' | 'payments') {
  const required: Record<typeof section, Permission> = {
    services: 'service.read',
    projects: 'project.read',
    documents: 'document.download',
    dossiers: 'dossier.read',
    ai: 'ai.review',
    technical: 'technical.read',
    communications: 'practice_communications.read',
    audit: 'audit.read',
    contracts: 'contract.read',
    payments: 'payment.read',
  };
  return permissions.includes(required[section]);
}
