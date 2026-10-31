export const dynamic = 'force-dynamic';
import { randomUUID } from 'node:crypto';
import { notFound, redirect } from 'next/navigation';
import { z } from 'zod';
import { requireSession } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { readAdminOperationalLink } from '@/lib/admin-operational-links';
import { OperationalLinkError } from '@/lib/admin-operational-link-contract';
import { AdminRecordError } from '@/lib/admin-records';
import { AdminOperationalLinkEditor } from '@/components/admin-operational-link-editor';
import { PageHeader } from '@/components/ui';
export default async function Page({ params, searchParams }: { params: Promise<{ model: string; id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await requireSession(); if (session.role !== 'admin') notFound();
  const { model, id } = await params, query = await searchParams;
  if (query.decision && !z.string().uuid().safeParse(query.decision).success) notFound();
  const page = z.coerce.number().int().min(1).max(10000).safeParse(query.page ?? 1); if (!page.success) notFound();
  if (query.command && !z.string().uuid().safeParse(query.command).success || query.command && query.decision && query.command !== query.decision) notFound();
  if (!query.command) {
    const next = new URLSearchParams({ command: query.decision ? String(query.decision) : randomUUID(), page: String(page.data) });
    if (query.decision) next.set('decision', String(query.decision));
    redirect('/admin/links/' + encodeURIComponent(model) + '/' + encodeURIComponent(id) + '?' + next);
  }
  let data;
  try { data = await readAdminOperationalLink(prisma, session, model, id, page.data); }
  catch (error) { if (error instanceof OperationalLinkError || error instanceof AdminRecordError || error instanceof z.ZodError) notFound(); throw error; }
  return <div className="crm-space-y-6"><PageHeader title={'Collegamenti · ' + data.label} description="Correzione amministrativa con anteprima, conferma e storico conservato."/>
    <AdminOperationalLinkEditor key={model + ':' + id + ':' + query.command} data={data} commandId={String(query.command)} recovering={Boolean(query.decision)}/></div>;
}
