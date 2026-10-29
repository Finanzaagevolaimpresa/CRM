export const dynamic = 'force-dynamic';
import { randomUUID } from 'node:crypto';
import { notFound, redirect } from 'next/navigation';
import { z } from 'zod';
import { requireSession } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { loadAdminRecord, readAdminRecordReceipt, AdminRecordError } from '@/lib/admin-records';
import { adminRecordCatalogue } from '@/lib/admin-record-catalogue';
import { AdminRecordEditor } from '@/components/admin-record-editor';
import { PageHeader } from '@/components/ui';
export default async function Page({ params, searchParams }: { params: Promise<{ model: string; id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await requireSession(); if (session.role !== 'admin') notFound();
  const { model, id } = await params, query = await searchParams;
  if (!adminRecordCatalogue.some(row => row.model === model)) notFound();
  for (const key of ['draft', 'command', 'decision', 'restoreRevision']) if (query[key] !== undefined && !z.string().uuid().safeParse(query[key]).success) notFound();
  if (!query.command || (id === 'new' && !query.draft)) {
    const next = new URLSearchParams();
    if (id === 'new') next.set('draft', String(query.draft ?? randomUUID()));
    next.set('command', String(query.command ?? randomUUID()));
    if (query.decision) next.set('decision', String(query.decision));
    if (query.restoreRevision) next.set('restoreRevision', String(query.restoreRevision));
    redirect(`/admin/records/${model}/${id}?${next}`);
  }
  if (query.decision && query.decision !== query.command) notFound();
  const recordId = id === 'new' ? String(query.draft) : id;
  const receipt = query.decision ? await readAdminRecordReceipt(prisma, session, String(query.decision)) : null;
  if (receipt && (receipt.model !== model || receipt.id !== recordId)) notFound();
  const creating = id === 'new' && (!receipt || receipt.closed);
  let data;
  try { data = await loadAdminRecord(prisma, session, model, recordId, creating, query.restoreRevision ? String(query.restoreRevision) : undefined); }
  catch (error) { if (error instanceof AdminRecordError || error instanceof z.ZodError) notFound(); throw error; }
  return <div className="crm-space-y-6"><PageHeader title={data.label} description={data.deleted ? 'Scheda nel cestino: dati conservati per il ripristino.' : 'Editor amministrativo con controllo delle modifiche concorrenti e cronologia delle correzioni.'} />
    <AdminRecordEditor key={`${model}:${recordId}:${query.command}:${query.restoreRevision ?? ''}`} data={data} commandId={String(query.command)} recovering={Boolean(query.decision)} /></div>;
}
