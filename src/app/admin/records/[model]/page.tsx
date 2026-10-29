export const dynamic = 'force-dynamic';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireSession } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { adminRecordCatalogue } from '@/lib/admin-record-catalogue';
import { listAdminRecords } from '@/lib/admin-records';
import { Card, PageHeader } from '@/components/ui';
export default async function Page({ params, searchParams }: { params: Promise<{ model: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await requireSession(), { model } = await params, query = await searchParams;
  const policy = adminRecordCatalogue.find(item => item.model === model); if (!policy || session.role !== 'admin') notFound();
  const q = typeof query.q === 'string' ? query.q : '', page = Number(query.page ?? '1'), trash = query.trash === '1';
  const data = await listAdminRecords(prisma, session, model, q, page, trash);
  return <div className="crm-space-y-6"><PageHeader title={policy.label} description="Apri la scheda per correggere i dati e consultare le revisioni amministrative." />
    <nav className="flex gap-4"><Link className="underline" href="/admin/records">Controllo Admin</Link>
      {policy.create && <Link className="underline" href={`/admin/records/${model}/new`}>Crea scheda</Link>}
      {policy.trash && <Link className="underline" href={`?trash=${trash ? '0' : '1'}`}>{trash ? 'Schede operative' : 'Cestino e ripristino'}</Link>}</nav>
    <form className="flex gap-3"><input type="hidden" name="trash" value={trash ? '1' : '0'} /><label>Cerca<input name="q" className="ml-3 rounded-xl border p-3" defaultValue={q} /></label><button className="underline">Cerca</button></form>
    <Card title={trash ? 'Cestino recuperabile' : 'Schede'}>{!data.rows.length && <p>Nessun record in questa ricerca.</p>}{data.rows.map(row =>
      <p key={row.id} className="border-b py-3"><Link className="font-bold underline" href={`/admin/records/${model}/${row.id}`}>{row.label}</Link> · {row.deleted ? 'Nel cestino' : row.status.replaceAll('_', ' ')}</p>)}</Card>
    <nav className="flex gap-4">{page > 1 && <Link className="underline" href={`?trash=${trash ? 1 : 0}&q=${encodeURIComponent(q)}&page=${page - 1}`}>Precedenti</Link>}
      {data.hasNext && <Link className="underline" href={`?trash=${trash ? 1 : 0}&q=${encodeURIComponent(q)}&page=${page + 1}`}>Successivi</Link>}</nav>
  </div>;
}
