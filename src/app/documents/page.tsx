export const dynamic = 'force-dynamic';
import { DisabledAction, Hint, SecondaryLink } from '@/components/actions';
import { DocumentUploadForm } from '@/components/document-upload-form';
import { Card, EmptyState, MetaCell, PageHeader, StatusBadge, Table, formatDateTime } from '@/components/ui';
import { prisma } from '@/lib/prisma';
import { hasPermission, requirePermission } from '@/lib/auth';
import { canViewDocument, isSensitiveDocument } from '@/lib/access-control';
import { privateDocumentExists } from '@/lib/storage';

const serviceAreas = ['anagrafica','bancabilita','finanziamento_aziendale','bandi_finanza_agevolata','progetto_investimento','contratti','pagamenti','dossier','output_ai','altro'];

export default async function Page({ searchParams }: { searchParams?: Promise<{ uploadError?: string }> }) {
  const params = await searchParams;
  const session = await requirePermission('document.download');
  const [documentItems, clientRows, companyRows, projectRows, serviceRows, catalogRows, userRows] = await Promise.all([
    prisma.document.findMany({ where: { deletedAt: null }, orderBy: { createdAt: 'desc' } }),
    prisma.client.findMany({ where: { deletedAt: null } }),
    prisma.company.findMany({ where: { deletedAt: null } }),
    prisma.project.findMany({ where: { deletedAt: null } }),
    prisma.clientService.findMany({ where: { deletedAt: null } }),
    prisma.serviceCatalog.findMany(),
    prisma.user.findMany({ where: { active: true } }),
  ]);
  const clientById = new Map(clientRows.map((c) => [c.id, c]));
  const projectById = new Map(projectRows.map((p) => [p.id, { ...p, client: clientById.get(p.clientId) }]));
  const serviceById = new Map(serviceRows.map((service) => [service.id, service]));
  const canReadSensitive = hasPermission(session, 'document.sensitive.read');
  const visible = documentItems.filter((document) => canViewDocument(session, { ...document, client: document.clientId ? clientById.get(document.clientId) : null, project: document.projectId ? projectById.get(document.projectId) : null, clientService: document.clientServiceId ? serviceById.get(document.clientServiceId) : null }, canReadSensitive));
  const availability = new Map(await Promise.all(visible.map(async (d) => [d.id, await privateDocumentExists(d.storagePath)] as const)));
  const clients = new Map(clientRows.map((c) => [c.id, c.displayName]));
  const companies = new Map(companyRows.map((c) => [c.id, c.name]));
  const projects = new Map(projectRows.map((p) => [p.id, p.title]));
  const users = new Map(userRows.map((u) => [u.id, u.name]));

  return <div className="space-y-6"><PageHeader title="Documenti" description="Upload reale in storage locale privato: nessun file è pubblico, ogni download passa da permessi e audit log."/>
    <Card title="Carica documento reale">{params?.uploadError ? <div className="mb-4 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm font-semibold text-red-700">{params.uploadError}</div> : null}<DocumentUploadForm clients={clientRows.map((c) => ({ id: c.id, clientId: c.id, label: c.displayName }))} companies={companyRows.map((c) => ({ id: c.id, clientId: c.clientId, label: c.name }))} projects={projectRows.map((p) => ({ id: p.id, clientId: p.clientId, label: p.title }))} services={serviceRows.map((service) => ({ id: service.id, clientId: service.clientId, label: catalogRows.find((catalog) => catalog.id === service.serviceCatalogId)?.name ?? `Servizio ${service.id}` }))} serviceAreas={serviceAreas} /><Hint>I file vengono salvati in <code>storage/private/documents</code> solo lato server; lo storagePath non è esposto all’utente.</Hint></Card>
    <Card title="Elenco operativo">{visible.length === 0 ? <EmptyState title="Nessun elemento presente" /> : <Table headers={['Documento', 'Cliente/Azienda/Progetto', 'Sezione', 'Categoria', 'Stato file', 'Tracciabilità', 'Scadenza', 'Download']} rows={visible.map((x) => { const ok = availability.get(x.id); return [<span className='font-semibold text-fai-navy' key='n'>{x.title}<br/><span className="text-xs font-normal text-slate-500">{x.fileName}{!ok ? ' · metadata demo / file non caricato' : ''}</span></span>, <span key="cp">{x.clientId ? clients.get(x.clientId) ?? '—' : '—'}<br/>{x.companyId ? companies.get(x.companyId) : ''}{x.companyId && x.projectId ? ' · ' : ''}{x.projectId ? projects.get(x.projectId) : ''}</span>, x.serviceArea, <span key='c'>{x.documentCategory} {isSensitiveDocument(x) ? <span className='ml-2 rounded-full bg-fai-orange/10 px-2 py-0.5 text-xs font-bold text-fai-orange'>sensibile</span> : null}<br/><StatusBadge status={x.status} /></span>, ok ? 'disponibile' : 'metadata demo / non caricato', <MetaCell key='m' createdAt={x.createdAt} updatedAt={x.updatedAt} owner={users.get(x.uploadedById)} />, formatDateTime(x.validUntil), ok ? <SecondaryLink key="d" href={`/documents/${x.id}/download`}>Scarica</SecondaryLink> : <DisabledAction key='d' reason='File fisico assente nello storage privato'>File non caricato</DisabledAction>]; })} />}</Card>
  </div>;
}
