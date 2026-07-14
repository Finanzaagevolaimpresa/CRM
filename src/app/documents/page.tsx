export const dynamic = 'force-dynamic';
import { DisabledAction, Hint, SecondaryLink } from '@/components/actions';
import { DocumentUploadForm } from '@/components/document-upload-form';
import { Card, EmptyState, MetaCell, PageHeader, StatusBadge, Table, formatDateTime } from '@/components/ui';
import { prisma } from '@/lib/prisma';
import { hasPermission, requirePermission } from '@/lib/auth';
import { canEditClient, canEditProject, canEditService, canViewChecklistItem, canViewClient, canViewDocument, hasGlobalAccess, isSensitiveDocument } from '@/lib/access-control';
import { privateDocumentExists } from '@/lib/storage';
import { isMissingChecklistDocument } from '@/lib/document-checklist';

const serviceAreas = ['anagrafica','bancabilita','finanziamento_aziendale','bandi_finanza_agevolata','progetto_investimento','contratti','pagamenti','dossier','output_ai','altro'];

export default async function Page({ searchParams }: { searchParams?: Promise<{ uploadError?: string }> }) {
  const params = await searchParams;
  const session = await requirePermission('document.download');
  const [documentItems, clientRows, companyRows, projectRows, serviceRows, catalogRows, userRows, checklistRows] = await Promise.all([
    prisma.document.findMany({ where: { deletedAt: null }, orderBy: { createdAt: 'desc' } }),
    prisma.client.findMany({ where: { deletedAt: null } }),
    prisma.company.findMany({ where: { deletedAt: null } }),
    prisma.project.findMany({ where: { deletedAt: null } }),
    prisma.clientService.findMany({ where: { deletedAt: null } }),
    prisma.serviceCatalog.findMany(),
    prisma.user.findMany({ where: { active: true } }),
    prisma.documentChecklistItem.findMany({ where: { deletedAt: null, active: true }, orderBy: { updatedAt: 'desc' } }),
  ]);
  const clientById = new Map(clientRows.map((c) => [c.id, c]));
  const projectById = new Map(projectRows.map((p) => [p.id, { ...p, client: clientById.get(p.clientId) }]));
  const serviceById = new Map(serviceRows.map((service) => [service.id, { ...service, client: clientById.get(service.clientId) ?? null, project: service.projectId ? projectById.get(service.projectId) ?? null : null }]));
  const canReadSensitive = hasPermission(session, 'document.sensitive.read');
  const visible = documentItems.filter((document) => canViewDocument(session, { ...document, client: document.clientId ? clientById.get(document.clientId) : null, project: document.projectId ? projectById.get(document.projectId) : null, clientService: document.clientServiceId ? serviceById.get(document.clientServiceId) : null }, canReadSensitive));
  const availability = new Map(await Promise.all(visible.map(async (d) => [d.id, await privateDocumentExists(d.storagePath)] as const)));
  const clients = new Map(clientRows.map((c) => [c.id, c.displayName]));
  const companies = new Map(companyRows.map((c) => [c.id, c.name]));
  const projects = new Map(projectRows.map((p) => [p.id, p.title]));
  const users = new Map(userRows.map((u) => [u.id, u.name]));
  const visibleClientIds = new Set(visible.map((document) => document.clientId).filter(Boolean));
  const accessibleClientIds = new Set(clientRows.filter((client) => canViewClient(session, client)).map((client) => client.id));
  const visibleDocumentIds = new Set(visible.map((document) => document.id));
  const relevantChecklist = checklistRows.filter((item) => accessibleClientIds.has(item.clientId)
    && (!isSensitiveDocument({ containsSensitiveData: false, documentCategory: item.title, type: item.title }) || canReadSensitive)
    && (!item.documentId || visibleDocumentIds.has(item.documentId))
    && (visibleClientIds.has(item.clientId) || !item.documentId)
    && canViewChecklistItem(session, {
      ...item,
      client: clientById.get(item.clientId) ?? null,
      project: item.projectId ? projectById.get(item.projectId) ?? null : null,
      clientService: item.clientServiceId ? serviceById.get(item.clientServiceId) ?? null : null,
    }));
  const missingChecklist = relevantChecklist.filter(isMissingChecklistDocument);
  const missingChecklistByClient = Array.from(new Set(missingChecklist.map((item) => item.clientId))).map((clientId) => {
    const items = missingChecklist.filter((item) => item.clientId === clientId);
    return {
      clientId,
      clientName: clients.get(clientId) ?? 'Cliente',
      text: `Gentile cliente, per proseguire con la lavorazione della pratica abbiamo necessità di ricevere i seguenti documenti: ${items.map((item) => item.title).join('; ')}. Restiamo a disposizione per eventuali chiarimenti.`,
    };
  });
  const rowOf = (x: (typeof visible)[number]) => ({ id: x.id, title: x.title, clientName: x.clientId ? clients.get(x.clientId) ?? '—' : '—', practice: x.projectId ? projects.get(x.projectId) ?? 'Pratica collegata' : x.clientServiceId ? catalogRows.find((catalog) => catalog.id === serviceRows.find((service) => service.id === x.clientServiceId)?.serviceCatalogId)?.name ?? 'Servizio collegato' : 'Fascicolo generale', category: x.documentCategory || x.type || 'Altro', status: x.status, date: x.updatedAt, note: x.fileName, href: availability.get(x.id) ? `/documents/${x.id}/download` : null });
  const documentCenterGroups = [
    { title: 'Documenti mancanti', tone: 'border-amber-200 bg-amber-50/70', rows: missingChecklist.map((item) => ({ id: item.id, title: item.title, clientName: clients.get(item.clientId) ?? 'Cliente', practice: item.projectId ? projects.get(item.projectId) ?? 'Pratica collegata' : item.clientServiceId ? catalogRows.find((catalog) => catalog.id === serviceRows.find((service) => service.id === item.clientServiceId)?.serviceCatalogId)?.name ?? 'Servizio collegato' : 'Fascicolo generale', category: 'Checklist', status: item.status, date: item.updatedAt, note: item.notes ?? 'Documento richiesto non ancora collegato.', href: null })) },
    { title: 'Documenti ricevuti', tone: 'border-blue-200 bg-blue-50/60', rows: visible.filter((x) => ['caricato','classificato','estratto'].includes(x.status)).map(rowOf) },
    { title: 'Da verificare', tone: 'border-orange-200 bg-orange-50/60', rows: visible.filter((x) => x.status === 'da_verificare').map(rowOf) },
    { title: 'Approvati', tone: 'border-green-200 bg-green-50/60', rows: visible.filter((x) => x.status === 'verificato').map(rowOf) },
    { title: 'Scartati / da sostituire', tone: 'border-red-200 bg-red-50/60', rows: visible.filter((x) => ['respinto','scaduto'].includes(x.status)).map(rowOf) },
    { title: 'Altro / non classificato', tone: 'border-slate-200 bg-slate-50/70', rows: visible.filter((x) => x.status === 'archiviato' || !x.documentCategory || x.documentCategory === 'altro').map(rowOf) },
  ];
  const canUpload = hasPermission(session, 'document.upload');
  const canWriteAnyClient = (client: (typeof clientRows)[number]) => hasGlobalAccess(session) || session.role === 'backoffice' || canEditClient(session, client);
  const writableClients = canUpload ? clientRows.filter(canWriteAnyClient) : [];
  const writableClientIds = new Set(writableClients.map((client) => client.id));
  const writableProjects = canUpload ? projectRows.filter((project) => {
    const client = clientById.get(project.clientId);
    return !!client && writableClientIds.has(project.clientId) && (session.role === 'backoffice' || canEditProject(session, { ...project, client }));
  }) : [];
  const writableServices = canUpload ? serviceRows.filter((service) => {
    const hydrated = serviceById.get(service.id);
    return !!hydrated && writableClientIds.has(service.clientId) && (session.role === 'backoffice' || canEditService(session, hydrated));
  }) : [];
  const writableCompanies = canUpload ? companyRows.filter((company) => writableClientIds.has(company.clientId)) : [];

  return <div className="space-y-6"><PageHeader title="Documenti" description="Upload reale in storage locale privato: nessun file è pubblico, ogni download passa da permessi e audit log."/>
    {canUpload ? <Card title="Carica documento reale">{params?.uploadError ? <div className="mb-4 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm font-semibold text-red-700">{params.uploadError}</div> : null}<DocumentUploadForm clients={writableClients.map((c) => ({ id: c.id, clientId: c.id, label: c.displayName }))} companies={writableCompanies.map((c) => ({ id: c.id, clientId: c.clientId, label: c.name }))} projects={writableProjects.map((p) => ({ id: p.id, clientId: p.clientId, label: p.title }))} services={writableServices.map((service) => ({ id: service.id, clientId: service.clientId, label: catalogRows.find((catalog) => catalog.id === service.serviceCatalogId)?.name ?? `Servizio ${service.id}` }))} serviceAreas={serviceAreas} /><Hint>I file vengono salvati in <code>storage/private/documents</code> solo lato server; lo storagePath non è esposto all’utente.</Hint></Card> : null}
    <Card title="Centro documentale"><div className="mb-5 grid gap-3 lg:grid-cols-2">{missingChecklistByClient.length === 0 ? <div className="rounded-2xl bg-fai-blue/5 p-4 ring-1 ring-fai-blue/10"><h3 className="text-sm font-black uppercase tracking-wide text-fai-navy">Richieste documenti</h3><p className="mt-3 text-sm leading-6 text-slate-700">Nessun documento mancante risulta richiesto nelle checklist visibili.</p></div> : missingChecklistByClient.map((request) => <section key={request.clientId} className="rounded-2xl bg-fai-blue/5 p-4 ring-1 ring-fai-blue/10"><h3 className="text-sm font-black uppercase tracking-wide text-fai-navy">Richiesta documenti per {request.clientName}</h3><p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-slate-700">{request.text}</p></section>)}</div><div className="grid gap-4 xl:grid-cols-2">{documentCenterGroups.map((group) => <section key={group.title} className={`rounded-2xl border p-4 ${group.tone}`}><div className="mb-3 flex items-center justify-between gap-2"><h3 className="font-black text-fai-navy">{group.title}</h3><span className="rounded-full bg-white px-2.5 py-1 text-xs font-black text-slate-600 ring-1 ring-slate-200">{group.rows.length}</span></div>{group.rows.length === 0 ? <EmptyState title="Nessun documento in questo gruppo" /> : <div className="space-y-3">{group.rows.map((row) => <article key={row.id} className="rounded-2xl bg-white/90 p-3 text-sm shadow-sm ring-1 ring-slate-200"><div className="flex flex-wrap items-start justify-between gap-2"><div><p className="font-black text-fai-navy">{row.title}</p><p className="text-xs leading-5 text-slate-500">{row.clientName} · {row.practice}</p></div><StatusBadge status={row.status} /></div><p className="mt-2 text-xs leading-5 text-slate-600">Categoria/tipo: {row.category} · Aggiornato: {formatDateTime(row.date)}</p><p className="mt-1 text-xs leading-5 text-slate-500">{row.note}</p>{row.href ? <div className="mt-3"><SecondaryLink href={row.href}>Apri/Scarica</SecondaryLink></div> : null}</article>)}</div>}</section>)}</div></Card>
    <Card title="Elenco operativo">{visible.length === 0 ? <EmptyState title="Nessun elemento presente" /> : <Table headers={['Documento', 'Cliente/Azienda/Progetto', 'Sezione', 'Categoria', 'Stato file', 'Tracciabilità', 'Scadenza', 'Download']} rows={visible.map((x) => { const ok = availability.get(x.id); return [<span className='font-semibold text-fai-navy' key='n'>{x.title}<br/><span className="text-xs font-normal text-slate-500">{x.fileName}{!ok ? ' · metadata demo / file non caricato' : ''}</span></span>, <span key="cp">{x.clientId ? clients.get(x.clientId) ?? '—' : '—'}<br/>{x.companyId ? companies.get(x.companyId) : ''}{x.companyId && x.projectId ? ' · ' : ''}{x.projectId ? projects.get(x.projectId) : ''}</span>, x.serviceArea, <span key='c'>{x.documentCategory} {isSensitiveDocument(x) ? <span className='ml-2 rounded-full bg-fai-orange/10 px-2 py-0.5 text-xs font-bold text-fai-orange'>sensibile</span> : null}<br/><StatusBadge status={x.status} /></span>, ok ? 'disponibile' : 'metadata demo / non caricato', <MetaCell key='m' createdAt={x.createdAt} updatedAt={x.updatedAt} owner={users.get(x.uploadedById)} />, formatDateTime(x.validUntil), ok ? <SecondaryLink key="d" href={`/documents/${x.id}/download`}>Scarica</SecondaryLink> : <DisabledAction key='d' reason='File fisico assente nello storage privato'>File non caricato</DisabledAction>]; })} />}</Card>
  </div>;
}
