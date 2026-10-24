import { randomUUID } from 'node:crypto';
import { notFound } from 'next/navigation';
import { z } from 'zod';
import { Card, PageHeader } from '@/components/ui';
import { SecondaryLink } from '@/components/actions';
import { TechnicalWorkItemForm, TechnicalWorkItemRecovery } from '@/components/technical-work-item-form';
import { requireSession } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { technicalTargetReference, technicalWorkPath } from '@/lib/technical-assignment-display';
import { technicalItemFieldLabels } from '@/lib/technical-work-item-grant';
import { readTechnicalWorkItem } from '@/lib/technical-work-item-service';
import { prepareTechnicalWorkItem, saveTechnicalWorkItem, checkTechnicalWorkItem } from '@/lib/technical-work-item-actions';
export const dynamic = 'force-dynamic';
export default async function Page({ params, searchParams }: {
  params: Promise<{ kind: string; id: string; itemKind: string; itemId: string }>;
  searchParams: Promise<{ itemDecision?: string }> }) {
  const session = await requireSession(), p = await params;
  const target = technicalTargetReference.safeParse({ kind: p.kind === 'projects' ? 'Project' : p.kind === 'practices' ? 'TechnicalPractice' : null, targetId: p.id });
  const kind = z.enum(['Task', 'ChecklistItem']).safeParse(p.itemKind);
  if (!target.success || !kind.success || !/^[A-Za-z0-9_-]{1,128}$/.test(p.itemId)) notFound();
  const recovery = (await searchParams).itemDecision;
  if (recovery) {
    if (!z.string().uuid().safeParse(recovery).success) notFound();
    return <TechnicalWorkItemRecovery target={target.data} commandId={recovery} action={checkTechnicalWorkItem} />;
  }
  const data = await readTechnicalWorkItem(prisma, session, target.data, { kind: kind.data, itemId: p.itemId }).catch(() => null);
  if (!data) notFound();
  return <div className="min-w-0 space-y-6"><PageHeader title={data.fields.title ?? (kind.data === 'Task' ? 'Attività tecnica' : 'Elemento checklist')}
    description="Sono disponibili soltanto i campi scelti dall’Admin per il tuo incarico." />
    <SecondaryLink href={technicalWorkPath(target.data)}>Torna all’incarico</SecondaryLink>
    <Card title="Informazioni assegnate"><dl className="grid min-w-0 gap-4 sm:grid-cols-2">{Object.entries(data.fields).map(([key, value]) => <div key={key} className="min-w-0">
      <dt className="font-semibold">{technicalItemFieldLabels[key]}</dt><dd className="whitespace-pre-wrap break-words">{value ?? '—'}</dd></div>)}</dl></Card>
    {!!data.editableFields.length && <TechnicalWorkItemForm target={target.data} data={data} initialCommandId={randomUUID()}
      previewAction={prepareTechnicalWorkItem} confirmAction={saveTechnicalWorkItem} receiptAction={checkTechnicalWorkItem} />}
  </div>;
}
