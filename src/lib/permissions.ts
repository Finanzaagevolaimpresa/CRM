import type { RoleCode } from '@prisma/client';

export const permissionCatalog = [
  { code: 'user.read', label: 'Leggere utenti', description: 'Visualizza utenti interni e profili.', group: 'utenti e impostazioni' },
  { code: 'user.write', label: 'Modificare utenti', description: 'Crea e modifica utenti interni non privilegiati.', group: 'utenti e impostazioni' },
  { code: 'settings.manage', label: 'Gestire impostazioni', description: 'Accede alle impostazioni operative e diagnostiche.', group: 'utenti e impostazioni' },
  { code: 'lead.read', label: 'Leggere lead', description: 'Visualizza lead e offerte commerciali.', group: 'commerciale e lead' },
  { code: 'lead.write', label: 'Modificare lead', description: 'Crea e aggiorna lead e offerte.', group: 'commerciale e lead' },
  { code: 'client.read', label: 'Leggere clienti', description: 'Visualizza anagrafiche cliente consentite.', group: 'clienti e aziende' },
  { code: 'client.write', label: 'Modificare clienti', description: 'Crea e aggiorna clienti consentiti.', group: 'clienti e aziende' },
  { code: 'company.read', label: 'Leggere aziende', description: 'Visualizza società e assetti collegati.', group: 'clienti e aziende' },
  { code: 'company.write', label: 'Modificare aziende', description: 'Crea e aggiorna dati societari.', group: 'clienti e aziende' },
  { code: 'project.read', label: 'Leggere progetti', description: 'Visualizza progetti e pre-analisi.', group: 'progetti' },
  { code: 'project.write', label: 'Modificare progetti', description: 'Crea e aggiorna progetti e pre-analisi.', group: 'progetti' },
  { code: 'document.upload', label: 'Caricare documenti', description: 'Carica documenti nello storage privato.', group: 'documenti' },
  { code: 'document.download', label: 'Scaricare documenti', description: 'Visualizza e scarica documenti consentiti.', group: 'documenti' },
  { code: 'document.sensitive.read', label: 'Leggere documenti sensibili', description: 'Accede a documenti classificati sensibili se ABAC consente.', group: 'documenti' },
  { code: 'service.read', label: 'Leggere servizi', description: 'Visualizza servizi, task e checklist.', group: 'servizi' },
  { code: 'service.write', label: 'Modificare servizi', description: 'Aggiorna servizi, task e checklist.', group: 'servizi' },
  { code: 'service.assign', label: 'Assegnare servizi', description: 'Cambia assegnatari di servizi o task.', group: 'servizi' },
  { code: 'service.close', label: 'Chiudere servizi', description: 'Gestisce stati finali di servizi e task.', group: 'servizi' },
  { code: 'ai.run', label: 'Eseguire AI', description: 'Avvia workflow AI interni soggetti a controllo.', group: 'AI' },
  { code: 'ai.external.run', label: 'Eseguire provider AI esterni', description: 'Permesso applicativo per richiedere provider esterni; non abilita da solo i gate del control plane.', group: 'AI' },
  { code: 'ai.review', label: 'Revisionare AI', description: 'Revisiona output AI prodotti.', group: 'AI' },
  { code: 'ai.approve', label: 'Approvare AI', description: 'Approva output AI con separazione dal revisore.', group: 'AI' },
  { code: 'ai_agents.read', label: 'Leggere agenti AI', description: 'Visualizza configurazioni agenti AI.', group: 'AI' },
  { code: 'ai_agents.write', label: 'Modificare agenti AI', description: 'Modifica configurazioni agenti AI.', group: 'AI' },
  { code: 'ai.orchestrator.read', label: 'Leggere AI Orchestrator', description: 'Visualizza stato desiderato, stato effettivo e blocchi dell’AI Orchestrator.', group: 'AI Orchestrator' },
  { code: 'ai.orchestrator.configure', label: 'Configurare AI Orchestrator', description: 'Modifica la configurazione desiderata dell’AI Orchestrator entro i limiti Foundation.', group: 'AI Orchestrator' },
  { code: 'ai.orchestrator.enable', label: 'Abilitare funzioni Orchestrator', description: 'Autorizza richieste di abilitazione desiderata; non apre il dispatch fisico.', group: 'AI Orchestrator' },
  { code: 'ai.orchestrator.disable', label: 'Disabilitare funzioni Orchestrator', description: 'Disabilita o sospende funzioni dell’AI Orchestrator.', group: 'AI Orchestrator' },
  { code: 'ai.orchestrator.kill', label: 'Arrestare AI Orchestrator', description: 'Attiva i kill switch e l’arresto di emergenza dell’AI Orchestrator.', group: 'AI Orchestrator' },
  { code: 'ai.orchestrator.retry', label: 'Gestire retry Orchestrator', description: 'Permesso riservato alle future operazioni controllate di retry.', group: 'AI Orchestrator' },
  { code: 'ai.orchestrator.audit', label: 'Leggere audit Orchestrator', description: 'Consulta il ledger tecnico delle configurazioni dell’AI Orchestrator.', group: 'AI Orchestrator' },
  { code: 'ai.orchestrator.limits', label: 'Gestire limiti Orchestrator', description: 'Configura limiti conservativi di concorrenza, retry e durata.', group: 'AI Orchestrator' },
  { code: 'ai.orchestrator.agents', label: 'Gestire agenti Orchestrator', description: 'Configura lo stato desiderato degli agenti executor canonici.', group: 'AI Orchestrator' },
  { code: 'dossier.read', label: 'Leggere dossier', description: 'Visualizza dossier e bozze.', group: 'dossier' },
  { code: 'dossier.write', label: 'Modificare dossier', description: 'Crea e aggiorna dossier.', group: 'dossier' },
  { code: 'dossier.approve', label: 'Approvare dossier', description: 'Approva dossier separatamente dalla redazione.', group: 'dossier' },
  { code: 'contract.read', label: 'Leggere contratti', description: 'Visualizza contratti.', group: 'contratti' },
  { code: 'contract.write', label: 'Modificare contratti', description: 'Crea e aggiorna contratti.', group: 'contratti' },
  { code: 'payment.read', label: 'Leggere pagamenti', description: 'Visualizza pagamenti.', group: 'pagamenti' },
  { code: 'payment.write', label: 'Modificare pagamenti', description: 'Crea e aggiorna pagamenti.', group: 'pagamenti' },
  { code: 'audit.read', label: 'Leggere audit log', description: 'Visualizza tracciabilità audit.', group: 'audit' },
  { code: 'legal.read', label: 'Leggere legale e compliance', description: 'Accede alle viste interne legali e compliance.', group: 'legale e compliance' },
  { code: 'technical.read', label: 'Leggere ufficio tecnico', description: 'Visualizza pratiche tecniche.', group: 'ufficio tecnico' },
  { code: 'technical.write', label: 'Modificare ufficio tecnico', description: 'Aggiorna pratiche tecniche.', group: 'ufficio tecnico' },
  { code: 'technical.assign', label: 'Assegnare ufficio tecnico', description: 'Cambia responsabili tecnici.', group: 'ufficio tecnico' },
  { code: 'technical.status', label: 'Gestire stati tecnici', description: 'Modifica stati controllati delle pratiche tecniche.', group: 'ufficio tecnico' },
  { code: 'technical.admin', label: 'Amministrare ufficio tecnico', description: 'Gestione avanzata dell’ufficio tecnico.', group: 'ufficio tecnico' },
  { code: 'practice_communications.read', label: 'Leggere comunicazioni pratica', description: 'Visualizza comunicazioni di pratica.', group: 'comunicazioni pratica' },
  { code: 'practice_communications.write', label: 'Scrivere comunicazioni pratica', description: 'Crea comunicazioni di pratica.', group: 'comunicazioni pratica' },
  { code: 'practice_communications.review', label: 'Revisionare comunicazioni pratica', description: 'Revisiona comunicazioni di pratica.', group: 'comunicazioni pratica' },
  { code: 'practice_communications.mark_used', label: 'Marcare comunicazioni usate', description: 'Segna comunicazioni come utilizzate.', group: 'comunicazioni pratica' },
] as const;

export type Permission = (typeof permissionCatalog)[number]['code'];
export type PermissionGroup = (typeof permissionCatalog)[number]['group'];
export const permissionCodes = permissionCatalog.map((p) => p.code) as Permission[];
export const permissionCodeSet = new Set<string>(permissionCodes);
export function isPermission(value: unknown): value is Permission { return typeof value === 'string' && permissionCodeSet.has(value); }

export const rolePermissions: Record<RoleCode, readonly (Permission | '*')[]> = {
  admin: ['*'],
  direzione: ['technical.read','technical.write','technical.assign','technical.status','technical.admin','practice_communications.read','practice_communications.write','practice_communications.review','practice_communications.mark_used','user.read','settings.manage','lead.read','client.read','company.read','project.read','document.download','document.sensitive.read','ai.run','ai.external.run','ai.review','ai.approve','ai_agents.read','ai_agents.write','dossier.read','dossier.write','dossier.approve','legal.read','contract.read','payment.read','audit.read','service.read','service.write','service.assign','service.close'],
  commerciale: ['technical.read','practice_communications.read','lead.read','lead.write','client.read','client.write','company.read','project.read','service.read','service.assign'],
  consulente: ['technical.read','technical.write','technical.status','practice_communications.read','practice_communications.write','practice_communications.mark_used','lead.read','client.read','company.read','company.write','project.read','project.write','service.read','service.write','service.assign','document.upload','document.download','ai.run','ai.review','dossier.read','dossier.write'],
  revisore: ['technical.read','practice_communications.read','practice_communications.review','lead.read','client.read','company.read','project.read','document.download','document.sensitive.read','ai.review','ai.approve','dossier.read','dossier.approve','legal.read','service.read'],
  backoffice: ['technical.read','technical.write','technical.status','practice_communications.read','practice_communications.write','practice_communications.mark_used','lead.read','client.read','company.read','project.read','document.upload','document.download','service.read','service.write','dossier.read'],
  amministrazione: ['client.read','company.read','project.read','document.download','document.sensitive.read','legal.read','contract.read','contract.write','payment.read','payment.write','service.read'],
  collaboratore_limitato: ['client.read','project.read','service.read','document.download'],
};

export function roleHasPermission(role: RoleCode, permission: Permission) { const granted = rolePermissions[role] ?? []; return granted.includes('*') || granted.includes(permission); }
