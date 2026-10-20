import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Card, PageHeader } from '@/components/ui';
import { ContractActivitiesForm } from '@/components/contract-activities-form';
import { requireSession } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { contractActivitiesSetup } from '@/lib/contract-activities';
import { ContractActivitiesError } from '@/lib/contract-activities-contract';
import { RecordUpdateError } from '@/lib/record-update-contract';
import { ProjectUnavailableError } from '@/lib/project-lifecycle-lock';
import { SerializableConflictError } from '@/lib/serializable';

export default async function ActivitiesPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession(), { id } = await params;
  let setup: Awaited<ReturnType<typeof contractActivitiesSetup>>;
  try { setup = await contractActivitiesSetup(prisma, session, id); }
  catch (error) {
    if (error instanceof SerializableConflictError) return <PageHeader title="Contratto in aggiornamento" description="Ricarica questa pagina per leggere la versione corrente." />;
    if (error instanceof ContractActivitiesError || error instanceof RecordUpdateError || error instanceof ProjectUnavailableError) notFound();
    throw error;
  }
  return <div className="crm-space-y-6">
    <PageHeader title="Attività previste dall’incarico" description="Completa le attività mancanti nel contratto esistente." />
    <Link className="inline-block font-semibold text-fai-blue underline" href={`/contracts/${id}`}>← Torna al contratto</Link>
    <Card title="Contratto da completare"><dl className="grid gap-2 break-words">
      <div><dt className="font-semibold">Cliente</dt><dd>{setup.client}</dd></div>
      <div><dt className="font-semibold">Contratto</dt><dd>{setup.contract}</dd></div>
      <div><dt className="font-semibold">Servizio</dt><dd>{setup.service}</dd></div>
    </dl></Card>
    <Card title="Compila e controlla"><ContractActivitiesForm setup={setup} /></Card>
  </div>;
}
