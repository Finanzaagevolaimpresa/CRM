import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Card, PageHeader, formatDateTime } from '@/components/ui';
import { requirePermission } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { listAdminComplaintMessages } from '@/lib/approved-communications';
import { approvedMessageLabels, type ApprovedMessageState } from '@/lib/approved-communication-contract';
export const dynamic = 'force-dynamic';
export default async function Page({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const session = await requirePermission('legal.read'); if (session.role !== 'admin') notFound();
  const query = await searchParams, data = await listAdminComplaintMessages(prisma, session, Number(query.page ?? 1));
  return <div className="crm-space-y-6"><PageHeader title="Reclami e contestazioni" description="Comunicazioni classificate Reclamo, riservate all’Admin e conservate nel contesto originario." />
    <Card title="Gestisci nel fascicolo corretto"><p>Apri un cliente o una pratica, entra in Comunicazioni e scegli «Reclamo · solo admin». Puoi allegare la versione esatta dei documenti, preparare la bozza e seguire revisione, approvazione e registrazione dell’esito manuale.</p>
      <div className="mt-3 flex flex-wrap gap-4"><Link className="underline" href="/clients">Apri clienti</Link><Link className="underline" href="/technical-office/practices">Apri pratiche tecniche</Link></div></Card>
    <Card title="Reclami disponibili">{data.messages.length ? <ul className="space-y-4">{data.messages.map(message => <li key={message.id}>
      <Link className="font-semibold underline" href={'/communications?kind=' + message.context.kind + '&practice=' + encodeURIComponent(message.context.id) + '&focus=' + message.id}>{message.subject}</Link>
      <p>{message.contextLabel} · {approvedMessageLabels[message.state as ApprovedMessageState] ?? message.state} · versione {message.revision} · {formatDateTime(message.updatedAt)}</p></li>)}</ul>
      : <p>Nessun reclamo accessibile in questa pagina.</p>}</Card>
    <nav className="flex gap-4">{data.page > 1 && <Link className="underline" href={'?page=' + (data.page - 1)}>Precedenti</Link>}{data.hasMore && <Link className="underline" href={'?page=' + (data.page + 1)}>Successivi</Link>}</nav>
  </div>;
}
