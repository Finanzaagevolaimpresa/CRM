import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Card, PageHeader } from '@/components/ui';
import { requireSession } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { readRecordUpdateEmailQueue } from '@/lib/record-update-email-queue';
import { RecordUpdateError } from '@/lib/record-update-contract';

export const dynamic = 'force-dynamic';
export default async function Page() {
  const session = await requireSession();
  let rows;
  try { rows = await readRecordUpdateEmailQueue(prisma, session); }
  catch (error) { if (error instanceof RecordUpdateError) notFound(); throw error; }
  return <div className="min-w-0 crm-space-y-5 [overflow-wrap:anywhere]">
    <PageHeader title="Bozze da aggiornamenti" description="Gli eventi scelti in Chi aggiornare sono pronti per la preparazione di una bozza. Ogni destinatario ha un messaggio distinto da approvare personalmente." />
    <Link className="font-bold underline" href="/communications">Tutte le comunicazioni</Link>
    <p>Aprire questa pagina non salva bozze e non invia email. Le proposte revocate, scadute o senza accesso corrente sono escluse.</p>
    {!rows.length && <p>Nessun aggiornamento email disponibile.</p>}
    {rows.map(row => <Card key={row.deliveryId} title={row.label}>
      <p>{row.eventLabel} · {row.occurredAt.toLocaleString('it-IT')}</p>
      <p className="break-words">{row.recipientName} · {row.recipientAddress}</p>
      <Link className="font-bold underline" href={`/communications?kind=${row.context.kind}&practice=${encodeURIComponent(row.context.id)}&update=${row.deliveryId}`}>
        {row.saved ? 'Apri messaggio già salvato' : 'Prepara bozza da aggiornamento'}
      </Link>
    </Card>)}
    <p className="text-xs text-slate-600">Fino a 100 proposte correnti. Il salvataggio della bozza, l’approvazione personale e l’esito dell’invio restano passaggi distinti.</p>
  </div>;
}
