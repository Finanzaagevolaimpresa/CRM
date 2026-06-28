import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import type { RoleCode } from '@prisma/client';
import { verifySessionCookie, type Session } from './session';

const cookieName = process.env.AUTH_COOKIE_NAME ?? 'fai_crm_session';

export type Permission =
  | 'user.read' | 'user.write' | 'settings.manage'
  | 'lead.read' | 'lead.write'
  | 'client.read' | 'client.write'
  | 'company.read' | 'company.write'
  | 'project.read' | 'project.write'
  | 'document.upload' | 'document.download' | 'document.sensitive.read'
  | 'service.read' | 'service.write' | 'service.assign' | 'service.close'
  | 'ai.run' | 'ai.review' | 'ai.approve'
  | 'dossier.read' | 'dossier.write' | 'dossier.approve'
  | 'contract.read' | 'contract.write'
  | 'payment.read' | 'payment.write'
  | 'audit.read';

export async function getSession() {
  const token = (await cookies()).get(cookieName)?.value;
  return verifySessionCookie(token);
}

export async function requireSession(): Promise<Session> {
  const session = await getSession();
  if (!session) redirect('/login');
  return session;
}

export const rolePermissions: Record<RoleCode, readonly (Permission | '*')[]> = {
  admin: ['*'],
  direzione: ['user.read','settings.manage','lead.read','client.read','company.read','project.read','document.download','document.sensitive.read','ai.run','ai.review','ai.approve','dossier.read','dossier.approve','contract.read','payment.read','audit.read','service.read','service.write','service.assign','service.close'],
  commerciale: ['lead.read','lead.write','client.read','client.write','company.read','project.read','service.read','service.assign'],
  consulente: ['lead.read','client.read','company.read','company.write','project.read','project.write','service.read','service.write','service.assign','document.upload','document.download','ai.run','ai.review','dossier.read','dossier.write'],
  revisore: ['lead.read','client.read','company.read','project.read','document.download','document.sensitive.read','ai.review','ai.approve','dossier.read','dossier.approve','service.read'],
  backoffice: ['lead.read','client.read','company.read','project.read','document.upload','document.download','service.read','service.write'],
  amministrazione: ['client.read','company.read','project.read','document.download','document.sensitive.read','contract.read','contract.write','payment.read','payment.write','service.read'],
  collaboratore_limitato: ['client.read','project.read','service.read','document.download'],
};

export function hasPermission(session: Session, permission: Permission) {
  const granted = rolePermissions[session.role] ?? [];
  return granted.includes('*') || granted.includes(permission);
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
