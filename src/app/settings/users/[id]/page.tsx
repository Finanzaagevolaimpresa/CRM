export const dynamic = 'force-dynamic';
import { notFound } from 'next/navigation';
import { Badge, Card, PageHeader, Table, formatDateTime } from '@/components/ui';
import { inheritedPermission, permissionCatalog, requireAdmin, resolvePermission, type PermissionOverride } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { resetUserPermissionOverrides, updateUserPermissionOverrides } from '@/lib/user-actions';

export default async function Page({ params, searchParams }: { params: Promise<{ id: string }>; searchParams?: Promise<{ saved?: string }> }) {
  await requireAdmin();
  const [{ id }, query] = await Promise.all([params, searchParams ?? Promise.resolve({ saved: undefined as string | undefined })]);
  const user = await prisma.user.findUnique({ where: { id }, include: { permissionOverrides: true } });
  if (!user || user.deletedAt) notFound();
  const overrides = user.permissionOverrides.map(({ permission, allowed }) => ({ permission, allowed })) as PermissionOverride[];
  const overrideByPermission = new Map(overrides.map((override) => [override.permission, override.allowed]));
  const groups = [...new Set(permissionCatalog.map((permission) => permission.group))];
  const rows = permissionCatalog.map((permission) => {
    const inherited = inheritedPermission(user.role, permission.code);
    const explicit = overrideByPermission.get(permission.code);
    const effective = resolvePermission({ role: user.role, active: user.active, permissionOverrides: overrides }, permission.code);
    const result = user.role === 'admin' ? 'Consentito (accesso completo admin)' : explicit === true ? 'Consentito tramite eccezione' : explicit === false ? 'Negato tramite eccezione' : inherited ? 'Consentito dal ruolo' : 'Negato dal ruolo';
    return [
      <div key="p"><p className="font-black">{permission.label}</p><p className="text-xs text-slate-500">{permission.code} · {permission.description}</p></div>,
      permission.group,
      inherited ? <Badge key="i" tone="green">ereditato: sì</Badge> : <Badge key="i" tone="gray">ereditato: no</Badge>,
      user.role === 'admin' ? <span key="a" className="text-sm font-bold text-slate-500">Non applicabile agli admin</span> : <select key="s" name={`permission:${permission.code}`} defaultValue={explicit === true ? 'allow' : explicit === false ? 'deny' : 'inherit'} className="rounded-lg border px-2 py-1 text-sm"><option value="inherit">Eredita dal ruolo</option><option value="allow">Consenti</option><option value="deny">Nega</option></select>,
      <Badge key="e" tone={effective ? 'green' : 'orange'}>{result}</Badge>,
    ];
  });
  return <div className="space-y-6"><PageHeader title={`Gestisci accessi — ${user.name}`} description="Eccezioni granulari immediatamente operative: in assenza di override l’utente eredita dal ruolo." />
    {query.saved ? <div className="rounded-2xl bg-fai-lime/15 p-4 text-sm font-bold text-fai-green ring-1 ring-fai-lime/30">Accessi salvati correttamente.</div> : null}
    <Card title="Profilo utente"><dl className="grid gap-3 md:grid-cols-5"><div><dt className="text-xs font-black uppercase text-slate-500">Nome</dt><dd>{user.name}</dd></div><div><dt className="text-xs font-black uppercase text-slate-500">Email</dt><dd>{user.email}</dd></div><div><dt className="text-xs font-black uppercase text-slate-500">Ruolo</dt><dd><Badge>{user.role}</Badge></dd></div><div><dt className="text-xs font-black uppercase text-slate-500">Stato</dt><dd>{user.active ? <Badge tone="green">attivo</Badge> : <Badge tone="gray">non attivo</Badge>}</dd></div><div><dt className="text-xs font-black uppercase text-slate-500">Ultimo accesso</dt><dd>{formatDateTime(user.lastLoginAt)}</dd></div></dl></Card>
    <Card title="Riepilogo"><div className="grid gap-3 md:grid-cols-3"><div className="rounded-2xl bg-slate-50 p-4"><p className="text-xs font-black uppercase text-slate-500">Permessi effettivi</p><p className="text-2xl font-black text-fai-navy">{permissionCatalog.filter((p) => resolvePermission({ role: user.role, active: user.active, permissionOverrides: overrides }, p.code)).length}</p></div><div className="rounded-2xl bg-slate-50 p-4"><p className="text-xs font-black uppercase text-slate-500">Permessi ereditati dal ruolo</p><p className="text-2xl font-black text-fai-navy">{permissionCatalog.filter((p) => inheritedPermission(user.role, p.code)).length}</p></div><div className="rounded-2xl bg-slate-50 p-4"><p className="text-xs font-black uppercase text-slate-500">Eccezioni personalizzate</p><p className="text-2xl font-black text-fai-navy">{overrides.length}</p></div></div>{user.role === 'admin' ? <p className="mt-4 rounded-2xl bg-amber-50 p-3 text-sm font-bold text-amber-900">Gli admin mantengono sempre accesso completo e non possono essere limitati tramite eccezioni.</p> : null}</Card>
    <form action={updateUserPermissionOverrides} className="space-y-4"><input type="hidden" name="userId" value={user.id}/>{groups.map((group) => <Card key={group} title={group}><Table headers={['Permesso','Gruppo','Eredità ruolo','Eccezione','Risultato effettivo']} rows={rows.filter((row) => row[1] === group)} /></Card>)}{user.role !== 'admin' ? <div className="flex flex-wrap gap-3"><button className="rounded-xl bg-fai-green px-4 py-3 font-bold text-white">Salva accessi</button><button formAction={resetUserPermissionOverrides} className="rounded-xl bg-slate-700 px-4 py-3 font-bold text-white">Ripristina permessi del ruolo</button></div> : null}</form>
  </div>;
}
