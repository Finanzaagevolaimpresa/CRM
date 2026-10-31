import Link from 'next/link';
import type { RoleCode } from '@prisma/client';
import { requirePermission, hasPermission } from '@/lib/auth';
import { loadAdminRoleProfile } from '@/lib/admin-role-profile-store';
import { permissionCatalog } from '@/lib/permissions';
import { AdminCreationRoleSelector } from '@/components/admin-role-profile-account';
import { prisma } from '@/lib/prisma';
import { Badge, Card, Table } from '@/components/ui';
import { randomUUID } from 'node:crypto';
import { AdminUserForm, AdminUserRecoveryGuard } from '@/components/admin-user-form';
import { AdminUserRecoveryPage } from '@/components/admin-user-recovery-page';
import { adminUserVersion, type AdminUserOperation, type AdminUserVersionInput } from '@/lib/admin-user-command-contract';
const command = (operation: AdminUserOperation, user: AdminUserVersionInput | null = null) => ({ operation, commandId: randomUUID(), userId: user?.id ?? randomUUID(), expectedVersion: adminUserVersion(user) });
const roles = ['admin','direzione','commerciale','consulente','revisore','backoffice','amministrazione','collaboratore_limitato'];
const fmt=(d:Date|null)=>d?new Intl.DateTimeFormat('it-IT',{dateStyle:'short',timeStyle:'short'}).format(d):'—';
export default async function UsersPage({ searchParams }: { searchParams: Promise<{ removed?: string; accountCommand?: string; role?: string; q?: string }> }){
 const session = await requirePermission('user.read');
 const isAdmin = session.role === 'admin';
 const creationProfiles = isAdmin ? await prisma.$transaction(async tx => {
  const profiles = [];
  for (const role of roles) { const value = await loadAdminRoleProfile(tx, role as RoleCode); profiles.push({ role, version: value.version, revision: value.current?.revision ?? 0,
   labels: permissionCatalog.filter(item => hasPermission({ role: role as RoleCode, active: true, permissionOverrides: value.current?.overrides ?? [] }, item.code)).map(item => item.label) }); }
  return profiles;
 }) : [];
 const query = await searchParams;
 if (isAdmin && query.accountCommand) return <AdminUserRecoveryPage encoded={query.accountCommand} />;
 const showRemoved = isAdmin && query.removed === '1';
 const selectedRole = roles.includes(query.role ?? '') ? query.role as RoleCode : undefined;
 const search = (query.q ?? '').trim().slice(0, 200);
 const accountSearch = <form action="/settings/users" method="get" aria-label="Cerca account" className="flex flex-wrap gap-3">{showRemoved && <input type="hidden" name="removed" value="1"/>}<label>Nome o email<input className="block rounded-xl border p-3" name="q" defaultValue={search} maxLength={200}/></label><label>Ruolo<select className="block rounded-xl border p-3" name="role" defaultValue={selectedRole ?? ''}><option value="">Tutti i ruoli</option>{roles.map(role => <option key={role} value={role}>{role}</option>)}</select></label><button type="submit" className="rounded-xl border p-3">Cerca account</button><Link className="underline" href="/settings/roles">Profili di base dei ruoli</Link></form>;
 const users = await prisma.user.findMany({ where: { deletedAt: showRemoved ? { not: null } : null, ...(selectedRole ? { role: selectedRole } : {}), ...(search ? { OR: [{ name: { contains: search, mode: 'insensitive' as const } }, { email: { contains: search, mode: 'insensitive' as const } }] } : {}) }, orderBy:{createdAt:'desc'}, include:{ permissionOverrides: true, _count:{select:{permissionOverrides:true}} }});
 if (showRemoved) return <div className="crm-space-y-6">{accountSearch}<Card title="Account rimossi"><Table headers={['Nome','Email','Ruolo','Rimozione','Storico']} rows={users.map(user => [user.name,user.email,user.role,fmt(user.deletedAt),<Link key={user.id} href={`/settings/users/${user.id}`}>Apri archivio account</Link>])}/></Card><Link href="/settings/assignment-exceptions">Coda eccezioni delle assegnazioni</Link><br/><Link href="/settings/users">Torna agli utenti</Link></div>;
 return <AdminUserRecoveryGuard><div className="crm-space-y-6">
 {accountSearch}
 {isAdmin ? <div className="flex gap-4"><Link href="/settings/assignment-exceptions">Coda eccezioni delle assegnazioni</Link><Link href="/settings/users?removed=1">Account rimossi</Link></div> : null}
 {isAdmin ? <Card title="Crea utente interno"><AdminUserForm identity={command('CREATE')} label="Crea utente interno" className="grid gap-3 md:grid-cols-5"><input className="rounded-xl border p-3" name="name" placeholder="Nome" required/><input className="rounded-xl border p-3" name="email" type="email" placeholder="email@azienda.it" required/><AdminCreationRoleSelector profiles={creationProfiles}/><input className="rounded-xl border p-3" name="password" type="password" placeholder="Password temporanea" required minLength={12} maxLength={72}/><label className="flex items-center gap-2 text-sm"><input name="active" type="checkbox" defaultChecked/> Attivo</label><button className="rounded-xl bg-fai-green px-4 py-3 font-bold text-white md:col-span-5">Crea utente</button></AdminUserForm></Card> : null}
 <Card title="Lista utenti"><Table headers={['Nome','Email','Ruolo','Stato','Eccezioni','Ultimo accesso','Azioni']} rows={users.map(u=>[u.name,u.email,<Badge key="r">{u.role}</Badge>,u.active?<Badge tone="green" key="a">attivo</Badge>:<Badge tone="gray" key="i">non attivo</Badge>,u._count.permissionOverrides,fmt(u.lastLoginAt),isAdmin?<div className="flex flex-wrap gap-2" key="x"><Link className="rounded-lg bg-fai-green px-3 py-1 text-xs font-bold text-white" href={`/settings/users/${u.id}`}>Gestisci permessi</Link><AdminUserForm identity={command('ROLE', u)} label={`Modifica ruolo di ${u.name}`} className="flex gap-2"><input type="hidden" name="userId" value={u.id}/><select className="rounded-lg border px-2 py-1" name="role" defaultValue={u.role}>{roles.map(r=><option key={r} value={r}>{r}</option>)}</select><button className="rounded-lg bg-fai-blue px-3 py-1 text-xs font-bold text-white">Modifica ruolo</button></AdminUserForm>{u.active?<AdminUserForm identity={command('DEACTIVATE', u)} label={`Disattiva ${u.name}`} disabled={u.id === session.userId}><input type="hidden" name="userId" value={u.id}/><button className="rounded-lg bg-fai-orange px-3 py-1 text-xs font-bold text-white" disabled={u.id===session.userId}>Disattiva</button></AdminUserForm>:<AdminUserForm identity={command('ACTIVATE', u)} label={`Riattiva ${u.name}`}><input type="hidden" name="userId" value={u.id}/><button className="rounded-lg bg-fai-blue px-3 py-1 text-xs font-bold text-white">Riattiva</button></AdminUserForm>}</div>:<span key="ro" className="text-xs text-slate-500">Sola lettura</span>])}/></Card></div></AdminUserRecoveryGuard>;
}
