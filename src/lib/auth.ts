import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import type { RoleCode } from '@prisma/client';
import { verifySessionCookie, type Session } from './session';

const cookieName = process.env.AUTH_COOKIE_NAME ?? 'fai_crm_session';

export type Permission =
  | 'lead.read' | 'lead.write'
  | 'client.read' | 'client.write'
  | 'company.read' | 'company.write'
  | 'project.read' | 'project.write'
  | 'document.upload' | 'document.download'
  | 'ai.run' | 'ai.review' | 'ai.approve'
  | 'contract.write' | 'payment.write'
  | 'audit.read' | 'settings.manage';

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
  direzione: ['lead.read', 'client.read', 'company.read', 'project.read', 'document.download', 'ai.run', 'ai.review', 'ai.approve', 'audit.read'],
  commerciale: ['lead.read', 'lead.write', 'client.read', 'client.write', 'company.read', 'project.read'],
  consulente: ['lead.read', 'client.read', 'company.read', 'company.write', 'project.read', 'project.write', 'document.upload', 'document.download', 'ai.run', 'ai.review'],
  revisore: ['lead.read', 'client.read', 'company.read', 'project.read', 'document.download', 'ai.review', 'ai.approve'],
  backoffice: ['lead.read', 'client.read', 'company.read', 'project.read', 'document.upload', 'document.download'],
  amministrazione: ['client.read', 'company.read', 'project.read', 'document.download', 'contract.write', 'payment.write'],
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
