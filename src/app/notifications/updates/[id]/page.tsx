import Link from 'next/link';
import { notFound } from 'next/navigation';
import { z } from 'zod';
import { PageHeader, Card, formatDateTime } from '@/components/ui';
import { PrimaryButton } from '@/components/actions';
import { requireSession } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { readRecordUpdate } from '@/lib/record-update-delivery';
import { markRecordUpdateReadAction } from '@/lib/record-update-actions';
import { recordUpdateChangedLabels } from '@/lib/record-update-labels';
export const dynamic = 'force-dynamic';
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession(), { id } = await params;
  if (!z.string().uuid().safeParse(id).success) notFound();
  const row = await readRecordUpdate(prisma, session, id);
  if (!row) notFound();
  return <div className="crm-space-y-6"><PageHeader title={row.title} description={row.related} />
    <Link className="font-bold underline" href="/notifications/updates">← Aggiornamenti selezionati</Link>
    <Card title="Aggiornamento disponibile"><p>{formatDateTime(row.date)}</p><p className="my-3">Campi interessati: {row.changed.map(field => recordUpdateChangedLabels[field]).join(', ')}.</p>
      <p className="text-sm">I dettagli sono consultabili nella scheda secondo i tuoi permessi attuali.</p>
      <Link className="my-3 inline-block font-bold underline" href={row.recordHref}>Apri scheda</Link>
      {row.readAt ? <p>Segnato come letto il {formatDateTime(row.readAt)}.</p> : <form action={markRecordUpdateReadAction}>
        <input type="hidden" name="id" value={row.id}/><PrimaryButton type="submit">Segna come letto</PrimaryButton>
      </form>}
    </Card></div>;
}
