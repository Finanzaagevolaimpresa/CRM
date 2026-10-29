import { hasFinancialRole, isFinancialPermission } from '@/lib/financial-privacy-policy';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { AdminAccountManagement, AdminAccountLifecycle } from '@/components/admin-account-management';
import { UserAccountForms } from '@/components/user-account-forms';
import { internalSessionMode } from '@/lib/session';
import { Badge, Card } from '@/components/ui';
import { requirePermission, roleHasPermission, hasPermission } from '@/lib/auth';
import { permissionCatalog, type Permission } from '@/lib/permissions';
import { prisma } from '@/lib/prisma';
import { randomUUID } from 'node:crypto';
import { AdminUserForm, AdminUserRecoveryGuard } from '@/components/admin-user-form';
import { AdminUserRecoveryPage } from '@/components/admin-user-recovery-page';
import { adminUserVersion } from '@/lib/admin-user-command-contract';
export default async function UserPermissionsPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ accountCommand?: string; sessionAfter?: string }> }) {
  const session = await requirePermission('user.read');
  const { id } = await params;
  const query = await searchParams;
  if (session.role === 'admin' && query.accountCommand) return <AdminUserRecoveryPage encoded={query.accountCommand} />;
  const user = await prisma.user.findFirst({ where: { id, ...(session.role === 'admin' ? {} : { deletedAt: null }) }, include: { permissionOverrides: true } });
  if (!user) notFound();
  if (user.deletedAt) return <AdminUserRecoveryGuard><Card title="Account rimosso"><p>{user.name}: identità, storico e riferimenti sono conservati. L’accesso è revocato.</p><AdminAccountLifecycle user={user} available={internalSessionMode() === 'registry'} /><div className="flex flex-wrap gap-4"><Link href="/settings/assignment-exceptions">Apri coda eccezioni</Link><Link href={`/settings/users/${user.id}/perimeter`}>Gestisci consultazioni aggiuntive e revoche</Link></div></Card></AdminUserRecoveryGuard>;
  const isAdminTarget = user.role === 'admin';
  const canEdit = session.role === 'admin' && !isAdminTarget && session.userId !== user.id;
  const overrideMap = new Map(user.permissionOverrides.map((o) => [o.permission, o.allowed]));
  const groups = permissionCatalog.reduce((acc, permission) => {
    const items = acc.get(permission.group) ?? [];
    items.push(permission);
    acc.set(permission.group, items);
    return acc;
  }, new Map<string, (typeof permissionCatalog)[number][]>())
  return <AdminUserRecoveryGuard><div className="crm-space-y-6"><Card title="Profilo utente"><div className="grid gap-2 text-sm md:grid-cols-4"><div><b>Nome</b><br/>{user.name}</div><div><b>Email</b><br/>{user.email}</div><div><b>Ruolo</b><br/><Badge>{user.role}</Badge></div><div><b>Stato</b><br/>{user.active?<Badge tone="green">attivo</Badge>:<Badge tone="gray">non attivo</Badge>}</div></div>{isAdminTarget?<p className="mt-4 rounded-xl bg-fai-lime/10 p-3 text-sm font-bold text-fai-green">Gli amministratori sono immuni dagli override: accesso completo dal ruolo admin e nessuna eccezione salvabile.</p>:null}</Card>
  {session.role === 'admin' ? <Card title="Gestione account">{session.userId === user.id
    ? <UserAccountForms user={{ id: user.id, name: user.name, email: user.email }} own admin available={internalSessionMode() === 'registry'} />
    : <AdminAccountManagement user={user} available={internalSessionMode() === 'registry'} sessionAfter={query.sessionAfter} />}</Card> : null}
  {session.role === 'admin' ? <Card title="Perimetro clienti"><Link href={`/settings/users/${user.id}/perimeter`}>Gestisci consultazioni aggiuntive e revoche</Link><p>Consenti la lettura di clienti specifici, mantenendo separate le responsabilità operative.</p></Card> : null}
  {session.role === 'admin' ? <Card title="Rimozione con conservazione dello storico"><AdminAccountLifecycle user={user} available={internalSessionMode() === 'registry' && session.userId !== user.id} />{session.userId === user.id && <p>Non puoi rimuovere il tuo account dalla sessione in uso.</p>}</Card> : null}
  <AdminUserForm identity={{ operation: 'OVERRIDES', commandId: randomUUID(), userId: user.id, expectedVersion: adminUserVersion(user) }} label="Permessi individuali" disabled={!canEdit} className="crm-space-y-6"><input type="hidden" name="userId" value={user.id}/>{Array.from(groups).map(([group, perms])=><Card key={group} title={group}><div className="crm-space-y-3">{perms.map((perm)=>{ const inherited=roleHasPermission(user.role, perm.code); const ov=overrideMap.get(perm.code); const restricted=isFinancialPermission(perm.code)&&!hasFinancialRole(user); const value=restricted?'inherit':ov===undefined?'inherit':ov?'allow':'deny'; const effective=hasPermission({ role:user.role, active:user.active, permissionOverrides:user.permissionOverrides }, perm.code as Permission); return <div key={perm.code} className="grid gap-2 rounded-2xl border p-3 md:grid-cols-[1fr_auto_auto_auto]"><div><p className="font-black">{perm.label} <code className="text-xs text-slate-500">{perm.code}</code></p><p className="text-sm text-slate-600">{perm.description}{restricted ? " Riservato ad Admin e Amministrazione; nessuna eccezione individuale." : ""}</p></div><Badge tone={inherited?'green':'gray'}>{inherited?'Ereditato: sì':'Ereditato: no'}</Badge><select name={`permission:${perm.code}`} defaultValue={value} disabled={!canEdit || restricted} className="rounded-lg border px-3 py-2"><option value="inherit">Eredita</option><option value="allow">Consenti</option><option value="deny">Nega</option></select><Badge tone={effective?'green':'gray'}>{effective?'Effettivo: consentito':'Effettivo: negato'}</Badge></div>})}</div></Card>)}{canEdit?<div className="flex gap-3"><button className="rounded-xl bg-fai-green px-4 py-3 font-black text-white">Salva</button></div>:null}</AdminUserForm>{canEdit?<AdminUserForm identity={{ operation: 'RESET_OVERRIDES', commandId: randomUUID(), userId: user.id, expectedVersion: adminUserVersion(user) }} label="Ripristina ereditarietà"><input type="hidden" name="userId" value={user.id}/><button className="rounded-xl bg-fai-orange px-4 py-3 font-black text-white">Ripristina ereditarietà</button></AdminUserForm>:null}</div></AdminUserRecoveryGuard>;
}
