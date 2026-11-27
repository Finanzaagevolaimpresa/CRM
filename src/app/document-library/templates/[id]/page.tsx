import { randomUUID } from 'node:crypto';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireSession } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { listOperationalTemplates } from '@/lib/operational-documents';
import { OperationalTemplateForm } from '@/components/operational-document-forms';
import { Card, PageHeader, formatDateTime } from '@/components/ui';
import { withTechnicalPage } from '@/lib/technical-surface-guards';
export const dynamic = 'force-dynamic';
async function Page({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ duplicate?: string }> }) {
  const session = await requireSession(), { id } = await params, { duplicate } = await searchParams;
  const rows = await listOperationalTemplates(prisma, session, true), current = rows.find(row => row.id === (id === 'new' ? duplicate : id)) ?? null;
  if (id !== 'new' && !current || duplicate && !current) notFound();
  const templateId = id === 'new' ? randomUUID() : id;
  return <div className="crm-space-y-6"><PageHeader title={id === 'new' ? duplicate ? 'Duplica modello' : 'Nuovo modello' : current!.title} description="Salva una nuova versione e pubblicala dopo aver verificato il testo autorizzato."/>
    <Link className="font-bold underline" href="/document-library/templates">Libreria Modelli</Link>
    <Card title="Contenuto"><OperationalTemplateForm key={`${id}:${current?.revision ?? 0}:${duplicate ?? ''}`} templateId={templateId} commandId={randomUUID()} current={current} duplicateFrom={duplicate}/></Card>
    {current && <Card title="Cronologia">{current.history.map(row => <p key={row.revision}>Versione {row.revision} · {row.state === 'PUBLISHED' ? 'Pubblicata' : 'Bozza'} · {formatDateTime(row.createdAt)} · {row.authorName}</p>)}</Card>}
  </div>;
}
export default withTechnicalPage('/document-library/templates/[id]', Page);
