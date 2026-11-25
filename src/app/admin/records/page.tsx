import { withTechnicalPage } from '@/lib/technical-surface-guards';
export const dynamic = 'force-dynamic';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { requireSession } from '@/lib/auth';
import { recordUpdatePermission } from '@/lib/record-update-context';
import { adminRecordCatalogue } from '@/lib/admin-record-catalogue';
import { Card, PageHeader } from '@/components/ui';
  async function Page({ searchParams }: { searchParams: Promise<{ bin?: string; q?: string }> }) {
  const session = await requireSession(); if (session.role !== 'admin') notFound();
  const policies = adminRecordCatalogue.filter(policy => recordUpdatePermission(session, policy.permission));
  const bins = policies.filter(policy => policy.trash || ['Lead','Project'].includes(policy.model));
  const query = await searchParams;
  if (query.bin) {
    if (!bins.some(bin => bin.model === query.bin)) notFound();
    const term = encodeURIComponent((query.q ?? '').trim().slice(0,128));
    if (query.bin === 'Lead') redirect('/leads/trash?q=' + term);
    if (query.bin === 'Project') redirect('/projects?view=trash&q=' + term);
    redirect('/admin/records/' + query.bin + '?trash=1&q=' + term);
  }
  return <div className="crm-space-y-6"><PageHeader title="Controllo Admin" description="Correggi i dati operativi, gestisci i collegamenti e ritrova le rettifiche conservate per ogni scheda." />
    <nav className="flex flex-wrap gap-4"><Link className="underline" href="/admin/lifecycle">Blocco, archivio e ripristino delle fonti</Link><Link className="underline" href="/settings/users">Account e permessi</Link>
      <Link className="underline" href="/admin-requests">Richieste all’Admin</Link><Link className="underline" href="/settings/security">Conferma Admin</Link>
      <Link className="underline" href="/projects">Progetti e condivisioni</Link><Link className="underline" href="/technical-office/practices">Pratiche e incarichi</Link></nav>
    <Card title="Cestini e ripristino"><form className="flex flex-wrap gap-3">
      <label>Area<select className="block rounded-xl border p-2" name="bin" defaultValue="Lead">{bins.map(p => <option key={p.model} value={p.model}>{p.label}</option>)}</select></label>
      <label>Cerca nel cestino<input className="block rounded-xl border p-2" name="q" maxLength={128}/></label><button className="underline">Apri cestino</button>
    </form><p>Il ripristino del lead lo rimette nel suo perimetro. Un progetto ripristinato torna in archivio. Per un documento consulta le versioni prima del ripristino.</p>
    <Link className="underline" href="/admin/lifecycle">Fonti storiche e documenti privati</Link>{' · '}
    <Link className="underline" href="/drive-folders/manage">Gestione dei riferimenti Drive</Link></Card>
    {[...new Set(policies.map(policy => policy.group))].map(group => <Card key={group} title={group}>
      <div className="grid gap-3 md:grid-cols-2">{policies.filter(policy => policy.group === group).map(policy =>
        <Link key={policy.model} className="rounded-xl border p-4 font-bold underline" href={`/admin/records/${policy.model}`}>{policy.label}</Link>)}</div>
    </Card>)}
  </div>;
}

export default withTechnicalPage("/admin/records", Page);
