export const dynamic = 'force-dynamic';
import { randomUUID } from 'node:crypto';
import { notFound, redirect } from 'next/navigation';
import { z } from 'zod';
import { requireSession } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { readAdminPrivateVersions } from '@/lib/admin-private-document-versions';
import { AdminPrivateDocumentVersionEditor } from '@/components/admin-private-document-version-editor';
import { PageHeader } from '@/components/ui';
export default async function Page({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ command?: string; decision?: string }> }) {
  const session = await requireSession(); if (session.role !== 'admin') notFound();
  const { id } = await params, query = await searchParams;
  if (query.decision && !z.string().uuid().safeParse(query.decision).success) notFound();
  if (query.command && !z.string().uuid().safeParse(query.command).success || query.command && query.decision && query.command !== query.decision) notFound();
  if (!query.command) {
    const next = new URLSearchParams({ command: query.decision ?? randomUUID() });
    if (query.decision) next.set('decision', query.decision);
    redirect('/admin/private-documents/' + encodeURIComponent(id) + '/versions?' + next);
  }
  const data = await readAdminPrivateVersions(prisma, session, id);
  return <div className="space-y-6"><PageHeader title={'Versioni private · ' + data.title} description="Carica una nuova versione o riprendi i byte precedenti, conservando la provenienza."/>
    <AdminPrivateDocumentVersionEditor key={id + ':' + query.command} data={data} commandId={query.command} recovering={Boolean(query.decision)}/></div>;
}
