import Link from 'next/link';
import { notFound } from 'next/navigation';
import { withTechnicalPage } from '@/lib/technical-surface-guards';
import { requireSession } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { historicalPaymentSetup } from '@/lib/payment-historical-attestation';
import { HistoricalPaymentError } from '@/lib/payment-historical-attestation-contract';
import { PaymentCollectionError } from '@/lib/payment-collection-contract';
import { RecordUpdateError } from '@/lib/record-update-contract';
import { ProjectUnavailableError } from '@/lib/project-lifecycle-lock';
import { SerializableConflictError } from '@/lib/serializable';
import { PaymentHistoricalAttestationForm } from '@/components/payment-historical-attestation-form';
import { Card, PageHeader } from '@/components/ui';
export const dynamic = 'force-dynamic';

async function Page({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession(), { id } = await params;
  let setup: Awaited<ReturnType<typeof historicalPaymentSetup>>;
  try { setup = await historicalPaymentSetup(prisma, session, id); }
  catch (error) {
    if (error instanceof HistoricalPaymentError || error instanceof PaymentCollectionError
      || error instanceof RecordUpdateError || error instanceof ProjectUnavailableError) notFound();
    if (error instanceof SerializableConflictError) return <Card title="Verifica della rata in corso"><Link className="underline" href={`/payments/${id}/historical-attestation`}>Riapri la rettifica</Link></Card>;
    throw error;
  }
  return <div className="grid min-w-0 gap-5">
    <PageHeader title="Rettifica storica su attestazione Admin" description={`${setup.client} · ${setup.contract} · € ${setup.amount}`} />
    <Link className="underline" href="/payments">Torna ai pagamenti</Link>
    <Card title="Fonte amministrativa dell’incasso">
      <p className="mb-4">Questo percorso registra una dichiarazione storica espressa del titolare. È distinto dalla conferma con prova documentale: non certifica un accredito bancario, una firma o l’attivazione di un servizio.</p>
      <PaymentHistoricalAttestationForm setup={setup} />
    </Card>
  </div>;
}
export default withTechnicalPage('/payments/[id]/historical-attestation', Page);
