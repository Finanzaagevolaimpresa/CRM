import { notFound } from 'next/navigation';
import { PageHeader, Card } from '@/components/ui';
import { SecondaryLink } from '@/components/actions';
import { RecordUpdateForm } from '@/components/record-update-form';
import { requireSession } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { readRecordUpdateSetup } from '@/lib/record-updates';
import { recordUpdateKinds, type RecordUpdateKind } from '@/lib/record-update-labels';
import { RecordUpdateError } from '@/lib/record-update-contract';
export const dynamic = 'force-dynamic';
export default async function Page({ params }: { params: Promise<{ kind: string; id: string }> }) {
  const session = await requireSession(), { kind, id } = await params;
  if (session.role !== 'admin' || !recordUpdateKinds.includes(kind as RecordUpdateKind)) notFound();
  let setup;
  try { setup = await readRecordUpdateSetup(prisma, session, kind as RecordUpdateKind, id); }
  catch (error) { if (error instanceof RecordUpdateError) notFound(); throw error; }
  return <div className="crm-space-y-6"><PageHeader title={kind === 'PROJECT' ? 'Modifica progetto e chi aggiornare' : 'Chi aggiornare'} description="Scegli chi avvisare per questa scheda, una volta o con una regola esplicita." />
    <SecondaryLink href={setup.href}>← Torna alla scheda</SecondaryLink><Card title={setup.label}><RecordUpdateForm setup={setup}/></Card></div>;
}
