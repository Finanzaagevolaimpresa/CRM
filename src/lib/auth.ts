import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { RoleCode } from '@prisma/client';
const cookieName = process.env.AUTH_COOKIE_NAME ?? 'fai_crm_session';
export async function getSession() { const token = (await cookies()).get(cookieName)?.value; return token ? { userId: token.split(':')[0], role: (token.split(':')[1] ?? 'admin') as RoleCode } : null; }
export async function requireAuth(roles?: RoleCode[]) { const session = await getSession(); if (!session) redirect('/login'); if (roles && !roles.includes(session.role)) redirect('/dashboard'); return session; }
export const permissions: Record<RoleCode, string[]> = { admin: ['*'], direzione: ['read:*','approve:*'], commerciale: ['read:lead','write:lead','read:client'], consulente: ['read:*','write:project','write:preanalysis'], revisore: ['read:*','review:ai','approve:dossier'], backoffice: ['read:*','write:document','write:task'], amministrazione: ['read:contract','write:payment'] };
