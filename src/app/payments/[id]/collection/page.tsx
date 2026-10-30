import { AdminRecordShortcut } from '@/components/admin-record-shortcut';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Card, PageHeader } from '@/components/ui';
import { PaymentCollectionForm } from '@/components/payment-collection-form';
import { requireSession } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { paymentCollectionSetup } from '@/lib/payment-collection';
import { PaymentCollectionError } from '@/lib/payment-collection-contract';
import { RecordUpdateError } from '@/lib/record-update-contract';
import { ProjectUnavailableError } from '@/lib/project-lifecycle-lock';
import { SerializableConflictError } from '@/lib/serializable';

export default async function CollectionPage({ params, searchParams }: {
  params: Promise<{ id: string }>; searchParams: Promise<{ q?: string }>;
}) {
  const session = await requireSession(), { id } = await params, { q = '' } = await searchParams;
  let setup: Awaited<ReturnType<typeof paymentCollectionSetup>>;
  try {
    try { setup = await paymentCollectionSetup(prisma, session, id, q); }
    catch (error) {
      if (!(error instanceof SerializableConflictError)) throw error;
      setup = await paymentCollectionSetup(prisma, session, id, q);
    }
  } catch (error) {
    if (error instanceof SerializableConflictError) return <Card title="Verifica del pagamento in corso"><p>Un’altra operazione sta aggiornando il fascicolo.</p><Link className="underline" href={`/payments/${id}/collection`}>Riapri il modulo</Link></Card>;
    if (error instanceof PaymentCollectionError || error instanceof RecordUpdateError || error instanceof ProjectUnavailableError) notFound();
    throw error;
  }
  return <div className="crm-space-y-6 min-w-0">
    <PageHeader title="Conferma incasso" description={`${setup.client} · ${setup.contract} · € ${setup.amount}`} />
    <AdminRecordShortcut session={session} model="Payment" id={id} />
    <Link className="font-semibold text-fai-blue underline" href="/payments">Torna ai pagamenti</Link>
    <Card title="Rata e prova del pagamento">
      {!setup.reconciliationOnly && <><p className="mb-4">Registra l’incasso effettivo della rata già presente. L’importo non viene modificato. Scegli la prova verificata nel fascicolo, distinta dall’incarico firmato; dimensione massima 50 MB.</p>
        <form method="get" className="mb-5 flex flex-wrap items-end gap-3"><label className="min-w-0">Cerca prova per titolo<input name="q" maxLength={80} defaultValue={q} className="block w-full rounded-xl border p-3" /></label><button className="rounded-xl border p-3 font-semibold">Cerca</button></form>
        {setup.moreDocuments && <p>Restringi la ricerca per vedere gli altri documenti.</p>}
        {!setup.documents.length && <p className="mb-4 rounded-xl bg-amber-50 p-4">Nessuna prova idonea disponibile. Apri il <Link className="underline" href={`/clients/${setup.clientId}#documenti`}>fascicolo del cliente</Link> per caricare e verificare il documento effettivo.</p>}</>}
      <PaymentCollectionForm key={q} setup={setup} />
    </Card>
  </div>;
}
