import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import type { RoleCode, User } from '@prisma/client';
import { prisma } from './prisma';
import { verifySessionCookie, type SessionCookie } from './session';

const cookieName = process.env.AUTH_COOKIE_NAME ?? 'fai_crm_session';

export type AuthSession = SessionCookie & Pick<User, 'role' | 'active'> & { permissionOverrides: PermissionOverride[] };

export const permissionCatalog = [
  { code: 'user.read', label: 'Leggere utenti', description: 'Visualizza utenti interni e impostazioni account.', group: 'Utenti e impostazioni' },
  { code: 'user.write', label: 'Modificare utenti', description: 'Crea e aggiorna account interni.', group: 'Utenti e impostazioni' },
  { code: 'settings.manage', label: 'Gestire impostazioni', description: 'Accede e modifica configurazioni di sistema, ruoli e utenti.', group: 'Utenti e impostazioni' },
  { code: 'lead.read', label: 'Leggere lead', description: 'Visualizza lead e offerte commerciali.', group: 'Commerciale e lead' },
  { code: 'lead.write', label: 'Modificare lead', description: 'Crea, aggiorna e converte lead.', group: 'Commerciale e lead' },
  { code: 'client.read', label: 'Leggere clienti', description: 'Visualizza anagrafiche cliente.', group: 'Clienti e aziende' },
  { code: 'client.write', label: 'Modificare clienti', description: 'Crea e aggiorna anagrafiche cliente.', group: 'Clienti e aziende' },
  { code: 'company.read', label: 'Leggere aziende', description: 'Visualizza aziende collegate ai clienti.', group: 'Clienti e aziende' },
  { code: 'company.write', label: 'Modificare aziende', description: 'Crea e aggiorna aziende.', group: 'Clienti e aziende' },
  { code: 'project.read', label: 'Leggere progetti', description: 'Visualizza progetti e investimenti.', group: 'Progetti' },
  { code: 'project.write', label: 'Modificare progetti', description: 'Crea e aggiorna progetti e spese.', group: 'Progetti' },
  { code: 'document.upload', label: 'Caricare documenti', description: 'Registra o carica documenti.', group: 'Documenti' },
  { code: 'document.download', label: 'Scaricare documenti', description: 'Visualizza e scarica documenti autorizzati.', group: 'Documenti' },
  { code: 'document.sensitive.read', label: 'Leggere documenti sensibili', description: 'Accede ai documenti marcati come sensibili.', group: 'Documenti' },
  { code: 'service.read', label: 'Leggere servizi', description: 'Visualizza servizi acquistati, task e checklist.', group: 'Servizi' },
  { code: 'service.write', label: 'Modificare servizi', description: 'Aggiorna servizi, task e checklist operative.', group: 'Servizi' },
  { code: 'service.assign', label: 'Assegnare servizi', description: 'Assegna servizi e attività agli operatori.', group: 'Servizi' },
  { code: 'service.close', label: 'Chiudere servizi', description: 'Chiude o archivia servizi operativi.', group: 'Servizi' },
  { code: 'ai.run', label: 'Eseguire agenti AI', description: 'Avvia agenti AI interni.', group: 'Agenti AI' },
  { code: 'ai.review', label: 'Revisionare output AI', description: 'Revisiona output AI prima dell’uso operativo.', group: 'Agenti AI' },
  { code: 'ai.approve', label: 'Approvare output AI', description: 'Approva output AI dopo revisione umana.', group: 'Agenti AI' },
  { code: 'ai_agents.read', label: 'Leggere agenti AI', description: 'Visualizza configurazioni degli agenti AI.', group: 'Agenti AI' },
  { code: 'ai_agents.write', label: 'Modificare agenti AI', description: 'Aggiorna prompt e stato degli agenti AI.', group: 'Agenti AI' },
  { code: 'dossier.read', label: 'Leggere dossier', description: 'Visualizza dossier e bozze operative.', group: 'Dossier' },
  { code: 'dossier.write', label: 'Modificare dossier', description: 'Crea e aggiorna dossier.', group: 'Dossier' },
  { code: 'dossier.approve', label: 'Approvare dossier', description: 'Approva dossier revisionati.', group: 'Dossier' },
  { code: 'contract.read', label: 'Leggere contratti', description: 'Visualizza contratti.', group: 'Contratti' },
  { code: 'contract.write', label: 'Modificare contratti', description: 'Crea e aggiorna contratti.', group: 'Contratti' },
  { code: 'payment.read', label: 'Leggere pagamenti', description: 'Visualizza pagamenti e scadenze.', group: 'Pagamenti' },
  { code: 'payment.write', label: 'Modificare pagamenti', description: 'Registra e aggiorna pagamenti.', group: 'Pagamenti' },
  { code: 'audit.read', label: 'Leggere audit log', description: 'Visualizza registri audit.', group: 'Audit' },
  { code: 'technical.read', label: 'Leggere pratiche tecniche', description: 'Visualizza pratiche dell’ufficio tecnico.', group: 'Pratiche tecniche' },
  { code: 'technical.write', label: 'Modificare pratiche tecniche', description: 'Crea e aggiorna pratiche tecniche.', group: 'Pratiche tecniche' },
  { code: 'technical.assign', label: 'Assegnare pratiche tecniche', description: 'Assegna pratiche tecniche agli operatori.', group: 'Pratiche tecniche' },
  { code: 'technical.status', label: 'Cambiare stato pratica', description: 'Aggiorna lo stato delle pratiche tecniche.', group: 'Pratiche tecniche' },
  { code: 'technical.admin', label: 'Amministrare ufficio tecnico', description: 'Gestisce configurazioni avanzate dell’ufficio tecnico.', group: 'Pratiche tecniche' },
  { code: 'practice_communications.read', label: 'Leggere comunicazioni pratica', description: 'Visualizza comunicazioni collegate alle pratiche.', group: 'Comunicazioni pratica' },
  { code: 'practice_communications.write', label: 'Scrivere comunicazioni pratica', description: 'Crea e aggiorna bozze di comunicazione.', group: 'Comunicazioni pratica' },
  { code: 'practice_communications.review', label: 'Revisionare comunicazioni', description: 'Revisiona e approva comunicazioni pratica.', group: 'Comunicazioni pratica' },
  { code: 'practice_communications.mark_used', label: 'Marcare comunicazioni usate', description: 'Segna comunicazioni come utilizzate/inviate.', group: 'Comunicazioni pratica' },
] as const;

export type Permission = typeof permissionCatalog[number]['code'];
export type PermissionOverride = { permission: Permission; allowed: boolean };
export const permissionCodes = permissionCatalog.map((permission) => permission.code) as Permission[];
export const permissionCodeSet = new Set<Permission>(permissionCodes);
export function isPermission(value: string): value is Permission { return permissionCodeSet.has(value as Permission); }

async function auditBlockedInactiveUserAccess(userId: string) {
  await prisma.auditLog.create({ data: { actorId: userId, event: 'blocked_inactive_user_access', entityType: 'User', entityId: userId } });
}

export async function getSession() {
  const token = (await cookies()).get(cookieName)?.value;
  const cookieSession = await verifySessionCookie(token);
  if (!cookieSession) return null;

  const user = await prisma.user.findUnique({
    where: { id: cookieSession.userId },
    select: { id: true, role: true, active: true, permissionOverrides: { select: { permission: true, allowed: true } } },
  });
  if (!user) return null;
  if (!user.active) {
    await auditBlockedInactiveUserAccess(user.id);
    return null;
  }

  return {
    ...cookieSession,
    role: user.role,
    active: user.active,
    permissionOverrides: user.permissionOverrides.filter((override): override is PermissionOverride => isPermission(override.permission)),
  } satisfies AuthSession;
}

export async function requireSession(): Promise<AuthSession> {
  const session = await getSession();
  if (!session) redirect('/login');
  return session;
}

export const rolePermissions: Record<RoleCode, readonly (Permission | '*')[]> = {
  admin: ['*','dossier.read','dossier.write'],
  direzione: ['technical.read','technical.write','technical.assign','technical.status','technical.admin','practice_communications.read','practice_communications.write','practice_communications.review','practice_communications.mark_used','user.read','settings.manage','lead.read','client.read','company.read','project.read','document.download','document.sensitive.read','ai.run','ai.review','ai.approve','ai_agents.read','ai_agents.write','dossier.read','dossier.write','dossier.approve','contract.read','payment.read','audit.read','service.read','service.write','service.assign','service.close'],
  commerciale: ['technical.read','practice_communications.read','lead.read','lead.write','client.read','client.write','company.read','project.read','service.read','service.assign'],
  consulente: ['technical.read','technical.write','technical.status','practice_communications.read','practice_communications.write','practice_communications.mark_used','lead.read','client.read','company.read','company.write','project.read','project.write','service.read','service.write','service.assign','document.upload','document.download','ai.run','ai.review','dossier.read','dossier.write'],
  revisore: ['technical.read','practice_communications.read','practice_communications.review','lead.read','client.read','company.read','project.read','document.download','document.sensitive.read','ai.review','ai.approve','dossier.read','dossier.approve','service.read'],
  backoffice: ['technical.read','technical.write','technical.status','practice_communications.read','practice_communications.write','practice_communications.mark_used','lead.read','client.read','company.read','project.read','document.upload','document.download','service.read','service.write','dossier.read'],
  amministrazione: ['client.read','company.read','project.read','document.download','document.sensitive.read','contract.read','contract.write','payment.read','payment.write','service.read'],
  collaboratore_limitato: ['client.read','project.read','service.read','document.download'],
};

export function resolvePermission(session: Pick<AuthSession, 'role' | 'active'> & { permissionOverrides?: readonly PermissionOverride[] }, permission: Permission) {
  if (!session.active) return false;
  if (session.role === 'admin') return true;
  const explicit = session.permissionOverrides?.find((override) => override.permission === permission);
  if (explicit) return explicit.allowed;
  const granted = rolePermissions[session.role] ?? [];
  return granted.includes('*') || granted.includes(permission);
}

export function hasPermission(session: Pick<AuthSession, 'role'> & Partial<Pick<AuthSession, 'active' | 'permissionOverrides'>>, permission: Permission) {
  return resolvePermission({ active: session.active ?? true, role: session.role, permissionOverrides: session.permissionOverrides ?? [] }, permission);
}

export function inheritedPermission(role: RoleCode, permission: Permission) {
  const granted = rolePermissions[role] ?? [];
  return role === 'admin' || granted.includes('*') || granted.includes(permission);
}

export async function requirePermission(permission: Permission) {
  const session = await requireSession();
  if (!hasPermission(session, permission)) redirect('/dashboard');
  return session;
}

export async function requireAuth(roles?: RoleCode[]) {
  const session = await requireSession();
  if (roles && !roles.includes(session.role)) redirect('/dashboard');
  return session;
}

export const permissions = rolePermissions;
