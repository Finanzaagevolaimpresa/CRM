export const dynamic = 'force-dynamic';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireSession } from '@/lib/auth';
import { recordUpdatePermission } from '@/lib/record-update-context';
import { adminRecordCatalogue } from '@/lib/admin-record-catalogue';
import { Card, PageHeader } from '@/components/ui';
export default async function Page() {
  const session = await requireSession(); if (session.role !== 'admin') notFound();
  const policies = adminRecordCatalogue.filter(policy => recordUpdatePermission(session, policy.permission));
  return <div className="crm-space-y-6"><PageHeader title="Controllo Admin" description="Correggi i dati operativi, gestisci i collegamenti e ritrova le rettifiche conservate per ogni scheda." />
    <nav className="flex flex-wrap gap-4"><Link className="underline" href="/settings/users">Account e permessi</Link>
      <Link className="underline" href="/admin-requests">Richieste all’Admin</Link><Link className="underline" href="/settings/security">Conferma Admin</Link>
      <Link className="underline" href="/projects">Progetti e condivisioni</Link><Link className="underline" href="/technical-office/practices">Pratiche e incarichi</Link></nav>
    {[...new Set(policies.map(policy => policy.group))].map(group => <Card key={group} title={group}>
      <div className="grid gap-3 md:grid-cols-2">{policies.filter(policy => policy.group === group).map(policy =>
        <Link key={policy.model} className="rounded-xl border p-4 font-bold underline" href={`/admin/records/${policy.model}`}>{policy.label}</Link>)}</div>
    </Card>)}
  </div>;
}
