import { withTechnicalPage } from '@/lib/technical-surface-guards';
import { randomUUID } from 'node:crypto';
import { notFound } from 'next/navigation';
import { z } from 'zod';
import { requireAuth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { readAdminTechnicalDisclosure } from '@/lib/admin-technical-disclosure';
import { AdminTechnicalDisclosureEditor } from '@/components/admin-technical-disclosure-editor';
import { PageHeader } from '@/components/ui';
export const dynamic = 'force-dynamic';
async function Page({ params, searchParams }: { params: Promise<{ versionId: string }>; searchParams: Promise<{ decision?: string }> }) {
  const session = await requireAuth(['admin']), p = await params, query = await searchParams;
  const commandId = query.decision ?? randomUUID(); if (!z.string().uuid().safeParse(commandId).success) notFound();
  const data = await readAdminTechnicalDisclosure(prisma, session, p.versionId).catch(() => null); if (!data) notFound();
  return <div className="space-y-5"><PageHeader title="Riservatezza della versione documentale" description="Classificazione Admin tracciata; nessuna condivisione automatica." />
    <AdminTechnicalDisclosureEditor data={data} commandId={commandId} recovering={!!query.decision} /></div>;
}

export default withTechnicalPage("/admin/document-disclosure/[versionId]", Page);
