import Link from 'next/link';
import { PageHeader, EmptyState } from '@/components/ui';
import { requireSession } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { listVideos } from '@/lib/video-library';
import { recordUpdatePermission } from '@/lib/record-update-context';
export const dynamic = 'force-dynamic';
export default async function Page({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const session = await requireSession(), { q = '' } = await searchParams;
  const rows = await listVideos(prisma, session, q.slice(0, 160));
  return <div className="crm-space-y-6 min-w-0"><PageHeader title="Video" description="Formazione e istruzioni operative condivise con il tuo profilo."/>
    {session.role === 'admin' && recordUpdatePermission(session, 'video.manage') && <Link className="font-bold underline" href="/videos/manage">Gestisci video e destinatari</Link>}
    <form className="flex flex-wrap gap-3"><label className="min-w-0 flex-1 font-bold">Cerca nella libreria<input name="q" maxLength={160} defaultValue={q} className="mt-1 block w-full rounded-xl border p-3"/></label><button className="self-end rounded-xl border px-4 py-3 font-bold">Cerca</button></form>
    {rows.length ? <div className="grid min-w-0 gap-4 md:grid-cols-2">{rows.map(row => <article key={row.id} className="min-w-0 space-y-3 rounded-2xl border bg-white p-5">
      {row.category && <p className="break-words text-sm text-slate-600">{row.category}</p>}<h2 className="break-words text-xl font-bold">{row.title}</h2>
      <p className="whitespace-pre-wrap break-words">{row.description}</p><Link href={'/videos/' + row.id} className="inline-block font-bold underline">Guarda video</Link>
    </article>)}</div> : <EmptyState title="Nessun video disponibile">Qui compaiono soltanto i video pubblicati per te e ancora accessibili.</EmptyState>}
  </div>;
}
