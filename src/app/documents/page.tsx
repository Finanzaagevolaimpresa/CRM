export const dynamic = 'force-dynamic';
import Link from 'next/link';
import { Card, EmptyState, PageHeader, StatusBadge, Table } from '@/components/ui';
import { prisma } from '@/lib/prisma';
import { hasPermission, requirePermission } from '@/lib/auth';
import { canViewDocument, isSensitiveDocument } from '@/lib/access-control';
export default async function Page() {
  const session = await requirePermission('document.download');
  const [documentItems, clientRows, projectRows, serviceRows] = await Promise.all([prisma.document.findMany({ where: { deletedAt: null }, orderBy: { createdAt: 'desc' } }), prisma.client.findMany({ where: { deletedAt: null } }), prisma.project.findMany({ where: { deletedAt: null } }), prisma.clientService.findMany({ where: { deletedAt: null } })]);
  const clientById = new Map(clientRows.map((c) => [c.id, c]));
  const projectById = new Map(projectRows.map((p) => [p.id, { ...p, client: clientById.get(p.clientId) }]));
  const serviceById = new Map(serviceRows.map((service) => [service.id, service]));
  const canReadSensitive = hasPermission(session, 'document.sensitive.read');
  const items = documentItems.filter((document) => canViewDocument(session, { ...document, client: document.clientId ? clientById.get(document.clientId) : null, project: document.projectId ? projectById.get(document.projectId) : null, clientService: document.clientServiceId ? serviceById.get(document.clientServiceId) : null }, canReadSensitive));
  const clients = new Map(clientRows.map((c) => [c.id, c.displayName]));
  const projects = new Map(projectRows.map((p) => [p.id, p.title]));
  return <div className="space-y-6"><PageHeader title="Documenti" description="Metadati documentali interni: i file restano in storage privato e non sono esposti pubblicamente."/><Card title="Elenco operativo">{items.length === 0 ? <EmptyState title="Nessun elemento presente">Non ci sono record da lavorare per questa sezione.</EmptyState> : <Table headers={['Documento', 'Cliente', 'Sezione', 'Categoria', 'Stato']} rows={items.map((x) => [<span className='font-semibold text-fai-navy' key='n'>{x.title}</span>, x.clientId ? clients.get(x.clientId) ?? '—' : '—', x.serviceArea, <span key='c'>{x.documentCategory} {isSensitiveDocument(x) ? <span className='ml-2 rounded-full bg-fai-orange/10 px-2 py-0.5 text-xs font-bold text-fai-orange'>sensibile</span> : null}</span>, <StatusBadge status={x.status} key='s' />])} />}</Card></div>;
}
