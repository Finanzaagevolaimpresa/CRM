import { notFound } from 'next/navigation';
import { Badge, Card } from '@/components/ui';
import { requirePermission, roleHasPermission, hasPermission } from '@/lib/auth';
import { permissionCatalog, type Permission } from '@/lib/permissions';
import { prisma } from '@/lib/prisma';
import { resetUserPermissionOverrides, updateUserPermissionOverrides } from '@/lib/user-actions';
export default async function UserPermissionsPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requirePermission('user.read');
  const { id } = await params;
  const user = await prisma.user.findFirst({ where: { id, deletedAt: null }, include: { permissionOverrides: true } });
  if (!user) notFound();
  const isAdminTarget = user.role === 'admin';
  const canEdit = session.role === 'admin' && !isAdminTarget && session.userId !== user.id;
  const overrideMap = new Map(user.permissionOverrides.map((o) => [o.permission, o.allowed]));
  const groups = permissionCatalog.reduce((acc, permission) => {
    const items = acc.get(permission.group) ?? [];
    items.push(permission);
    acc.set(permission.group, items);
    return acc;
  }, new Map<string, (typeof permissionCatalog)[number][]>())
  return <div className="space-y-6"><Card title="Profilo utente"><div className="grid gap-2 text-sm md:grid-cols-4"><div><b>Nome</b><br/>{user.name}</div><div><b>Email</b><br/>{user.email}</div><div><b>Ruolo</b><br/><Badge>{user.role}</Badge></div><div><b>Stato</b><br/>{user.active?<Badge tone="green">attivo</Badge>:<Badge tone="gray">non attivo</Badge>}</div></div>{isAdminTarget?<p className="mt-4 rounded-xl bg-fai-lime/10 p-3 text-sm font-bold text-fai-green">Gli amministratori sono immuni dagli override: accesso completo dal ruolo admin e nessuna eccezione salvabile.</p>:null}</Card>
  <form action={updateUserPermissionOverrides} className="space-y-6"><input type="hidden" name="userId" value={user.id}/>{Array.from(groups).map(([group, perms])=><Card key={group} title={group}><div className="space-y-3">{perms.map((perm)=>{ const inherited=roleHasPermission(user.role, perm.code); const ov=overrideMap.get(perm.code); const value=ov===undefined?'inherit':ov?'allow':'deny'; const effective=hasPermission({ role:user.role, active:user.active, permissionOverrides:user.permissionOverrides }, perm.code as Permission); return <div key={perm.code} className="grid gap-2 rounded-2xl border p-3 md:grid-cols-[1fr_auto_auto_auto]"><div><p className="font-black">{perm.label} <code className="text-xs text-slate-500">{perm.code}</code></p><p className="text-sm text-slate-600">{perm.description}</p></div><Badge tone={inherited?'green':'gray'}>{inherited?'Ereditato: sì':'Ereditato: no'}</Badge><select name={`permission:${perm.code}`} defaultValue={value} disabled={!canEdit} className="rounded-lg border px-3 py-2"><option value="inherit">Eredita</option><option value="allow">Consenti</option><option value="deny">Nega</option></select><Badge tone={effective?'green':'gray'}>{effective?'Effettivo: consentito':'Effettivo: negato'}</Badge></div>})}</div></Card>)}{canEdit?<div className="flex gap-3"><button className="rounded-xl bg-fai-green px-4 py-3 font-black text-white">Salva</button></div>:null}</form>{canEdit?<form action={resetUserPermissionOverrides}><input type="hidden" name="userId" value={user.id}/><button className="rounded-xl bg-fai-orange px-4 py-3 font-black text-white">Ripristina ereditarietà</button></form>:null}</div>;
}
