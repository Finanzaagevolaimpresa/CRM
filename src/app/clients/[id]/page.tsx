export const dynamic = 'force-dynamic';

import { ActivityTimeline, Card, EmptyState, PageHeader, StatusBadge, Table, TimestampMeta, formatDateTime } from '@/components/ui';
import { prisma } from '@/lib/prisma';
import { getAiAgentCategory, isPrimaryOperationalAiAgent, sortAiAgentsByCategory } from '@/lib/ai-agent-catalog';
import { buildClientServiceLabel } from '@/lib/client-service-label';
import { privateDocumentExists } from '@/lib/storage';
import { DisabledAction, PrimaryButton, SecondaryLink } from '@/components/actions';
import { DocumentUploadForm } from '@/components/document-upload-form';
import { assignServiceAndRefresh, createChecklistItemAndRefresh, createStandardChecklistAndRefresh, deactivateChecklistItemAndRefresh, linkChecklistItemDocumentAndRefresh, unlinkChecklistItemDocumentAndRefresh, updateChecklistItemStatusAndRefresh, updateServiceStatusAndRefresh, updateServicePipelineAndRefresh, uploadDocumentAndRefresh, createClientTaskAndRefresh, updateClientTaskAndRefresh, completeTask, generateClientDossierAndRedirect, runClientAiAgentAndRedirect } from '@/lib/form-actions';
import Link from 'next/link';
import { hasPermission, requirePermission } from '@/lib/auth';
import { canViewClient, canViewDocument } from '@/lib/access-control';
import { isMissingChecklistDocument } from '@/lib/document-checklist';

const serviceSections = [
  ['overview', 'Overview'],
  ['anagrafica-completa', 'Anagrafica completa'],
  ['azienda-visura-ateco', 'Azienda / Visura / ATECO'],
  ['titolari-soci-amministratori', 'Titolari, soci e amministratori'],
  ['progetti', 'Progetti'],
  ['servizi-acquistati', 'Servizi acquistati'],
  ['finanziamento-aziendale', 'Finanziamento aziendale'],
  ['bandi-finanza-agevolata', 'Bandi / Finanza agevolata'],
  ['bancabilita', 'Bancabilità'],
  ['documenti', 'Documenti'],
  ['centro-documentale', 'Centro documentale'],
  ['checklist-documentale', 'Checklist documentale'],
  ['pre-analisi', 'Pre-analisi'],
  ['dossier', 'Dossier'],
  ['contratti', 'Contratti'],
  ['pagamenti', 'Pagamenti'],
  ['task-scadenze', 'Attività e scadenze'],
  ['ufficio-tecnico-pratiche', 'Ufficio Tecnico / Pratiche'],
  ['comunicazioni-pratica', 'Comunicazioni pratica'],
  ['output-ai', 'Agenti AI / Output interni'],
  ['timeline-operativa', 'Timeline operativa'],
  ['audit-log', 'Audit log'],
] as const;
const checklistStatuses = ['da_richiedere','richiesto','ricevuto','validato','non_necessario'];
const operationalStatuses = ['nuova','pre_analisi','documenti_richiesti','documenti_ricevuti','in_valutazione','proposta_inviata','domanda_in_preparazione','domanda_presentata','in_istruttoria','approvata_deliberata','respinta_non_procedibile','rendicontazione','chiusa','archiviata'];
const operationalStatusLabel = (status: string) => status.replaceAll('_', ' ');
const moneyLabel = (value?: unknown) => value ? `€ ${Number(value).toLocaleString('it-IT')}` : '—';
const auditEventLabels: Record<string, string> = {
  technical_practice_update: 'Aggiornamento pratica tecnica',
  technical_practice_status_change: 'Cambio stato pratica tecnica',
  practice_communication_draft_create: 'Bozza comunicazione creata',
  practice_communication_approve: 'Comunicazione approvata',
  practice_communication_used: 'Comunicazione usata/inviata',
};
const auditLabel = (event: string) => auditEventLabels[event] ?? event.replaceAll('_', ' ');
const isRedundantOperationalAudit = (event: { category: string; type: string; entity?: string | null; dedupeKey?: string | null; date: Date | string }, events: Array<{ category: string; type: string; entity?: string | null; dedupeKey?: string | null; date: Date | string }>) => event.category === 'audit' && events.some((candidate) => candidate.category !== 'audit' && candidate.dedupeKey && candidate.dedupeKey === event.dedupeKey && Math.abs(+new Date(candidate.date) - +new Date(event.date)) <= 120000 && ((event.type === 'Cambio stato pratica tecnica' && candidate.type === 'stato pratica tecnica') || (event.type === 'Aggiornamento pratica tecnica' && ['stato pratica tecnica', 'aggiornamento pratica tecnica'].includes(candidate.type))));


export default async function Page({ params, searchParams }: { params: Promise<{ id: string }>; searchParams?: Promise<{ uploadError?: string; timelineFilter?: string }> }) {
  const { id } = await params;
  const query = await searchParams;
  const session = await requirePermission('client.read');
  const canReadCompanies = hasPermission(session, 'company.read');
  const canReadProjects = hasPermission(session, 'project.read');
  const canReadServices = hasPermission(session, 'service.read');
  const canReadDossiers = hasPermission(session, 'dossier.read');
  const canReadContracts = hasPermission(session, 'contract.read');
  const canReadPayments = hasPermission(session, 'payment.read');
  const canReadTechnical = hasPermission(session, 'technical.read');
  const canReadCommunications = hasPermission(session, 'practice_communications.read');
  const canReviewAi = hasPermission(session, 'ai.review');
  const canReadAudit = hasPermission(session, 'audit.read');
  const [client, companies, projects, clientServices, documents, contracts, payments, tasks, preAnalyses, dossiers, clientDossiers, bankability, financing, checklistItems, activeAgents, technicalPractices, practiceCommunications] = await Promise.all([
    prisma.client.findUnique({ where: { id } }),
    canReadCompanies ? prisma.company.findMany({ where: { clientId: id, deletedAt: null } }) : [],
    canReadProjects ? prisma.project.findMany({ where: { clientId: id, deletedAt: null }, orderBy: { updatedAt: 'desc' } }) : [],
    canReadServices ? prisma.clientService.findMany({ where: { clientId: id, deletedAt: null }, orderBy: { updatedAt: 'desc' } }) : [],
    hasPermission(session, 'document.download') ? prisma.document.findMany({ where: { clientId: id, deletedAt: null }, orderBy: { createdAt: 'desc' } }) : [],
    canReadContracts ? prisma.contract.findMany({ where: { clientId: id }, orderBy: { updatedAt: 'desc' } }) : [],
    canReadPayments ? prisma.payment.findMany({ where: { clientId: id }, orderBy: { updatedAt: 'desc' } }) : [],
    canReadServices ? prisma.task.findMany({ where: { clientId: id }, orderBy: { updatedAt: 'desc' } }) : [],
    canReadDossiers ? prisma.preAnalysis.findMany({ where: { clientId: id }, orderBy: { updatedAt: 'desc' } }) : [],
    canReadDossiers ? prisma.dossier.findMany({ where: { clientId: id }, orderBy: { updatedAt: 'desc' } }) : [],
    canReadDossiers ? prisma.clientDossier.findMany({ where: { clientId: id }, orderBy: { updatedAt: 'desc' } }) : [],
    prisma.bankabilityAssessment.findMany({ where: { clientId: id }, orderBy: { updatedAt: 'desc' } }),
    prisma.corporateFinancingAssessment.findMany({ where: { clientId: id }, orderBy: { updatedAt: 'desc' } }),
    canReadServices ? prisma.documentChecklistItem.findMany({ where: { clientId: id, deletedAt: null, active: true }, orderBy: [{ clientServiceId: 'asc' }, { createdAt: 'asc' }] }) : [],
    prisma.aiAgent.findMany({ where: { active: true }, orderBy: { name: 'asc' } }),
    canReadTechnical ? prisma.technicalPractice.findMany({ where: { clientId: id, deletedAt: null }, orderBy: { updatedAt: 'desc' } }) : [],
    canReadCommunications ? prisma.practiceCommunication.findMany({ where: { clientId: id, deletedAt: null, OR: [{ status: { in: ['approvata','usata_inviata'] } }, { type: { in: ['commerciale','interna'] } }] }, orderBy: { updatedAt: 'desc' } }) : [],
  ]);
  if (!client || !canViewClient(session, client)) return <h1 className="text-3xl font-bold text-fai-navy">Cliente non trovato o non accessibile</h1>;

  const serviceIds = clientServices.map((service) => service.id);
  const [aiOutputs, auditLogs, catalog, users] = await Promise.all([
    canReviewAi ? prisma.aiOutput.findMany({ where: { OR: [{ clientId: id }, ...(serviceIds.length > 0 ? [{ clientServiceId: { in: serviceIds } }] : [])] }, orderBy: { createdAt: 'desc' }, take: 15 }) : [],
    canReadAudit ? prisma.auditLog.findMany({ where: { OR: [{ entityId: id }, { entityId: { in: serviceIds } }, { entityId: { in: technicalPractices.map((practice) => practice.id) } }, { entityId: { in: practiceCommunications.map((communication) => communication.id) } }, { entityId: { in: documents.map((document) => document.id) } }, { entityId: { in: tasks.map((task) => task.id) } }] }, orderBy: { createdAt: 'desc' }, take: 80 }) : [],
    prisma.serviceCatalog.findMany({ where: { id: { in: clientServices.map((s) => s.serviceCatalogId) } } }),
    prisma.user.findMany({ where: { active: true } }),
  ]);
  const canManageChecklist = hasPermission(session, 'service.write');
  const canViewDocuments = hasPermission(session, 'document.download');
  const canReadSensitive = hasPermission(session, 'document.sensitive.read');
  const canAssignServices = hasPermission(session, 'service.assign');
  const canManageTasks = hasPermission(session, 'service.write');
  const canManageDossiers = hasPermission(session, 'dossier.write');
  const canRunAiAgents = hasPermission(session, 'ai.run');
  const aiDossierAudits = aiOutputs.length ? await prisma.auditLog.findMany({ where: { event: 'ai_output_to_client_dossier', entityType: 'AiOutput', entityId: { in: aiOutputs.map((output) => output.id) } }, orderBy: { createdAt: 'desc' } }) : [];
  const dossierByOutputId = new Map(aiDossierAudits.map((audit) => [audit.entityId, (audit.after as { dossierId?: string } | null)?.dossierId]).filter((entry): entry is [string, string] => Boolean(entry[0] && entry[1])));
  const outputRuns = aiOutputs.length ? await prisma.aiRun.findMany({ where: { id: { in: aiOutputs.map((output) => output.aiRunId) } } }) : [];
  const outputAgents = outputRuns.length ? await prisma.aiAgent.findMany({ where: { id: { in: outputRuns.map((run) => run.agentId) } } }) : [];
  const runById = new Map(outputRuns.map((run) => [run.id, run]));
  const agentById = new Map(outputAgents.map((agent) => [agent.id, agent]));
  const taskStatuses = ['aperta','in_lavorazione','completata','annullata'];
  const taskPriorities = ['bassa','media','alta','urgente'];
  const serviceById = new Map(clientServices.map((service) => [service.id, service]));
  const projectById = new Map(projects.map((project) => [project.id, project]));
  const visibleDocuments = canViewDocuments ? documents.filter((document) => canViewDocument(session, { ...document, client, project: document.projectId && projectById.get(document.projectId) ? { ...projectById.get(document.projectId)!, client } : null, clientService: document.clientServiceId ? serviceById.get(document.clientServiceId) : null }, canReadSensitive)) : [];
  const documentById = new Map(visibleDocuments.map((document) => [document.id, document]));
  const nameOf = (serviceId: string) => catalog.find((s) => s.id === serviceId)?.name ?? 'Servizio FAI';
  const labelOf = (service: { serviceCatalogId: string; practiceType?: string | null; operationalStatus?: string | null; requestedAmount?: unknown; plannedInvestment?: unknown } | null | undefined) => service ? buildClientServiceLabel(service, catalog.find((item) => item.id === service.serviceCatalogId) ?? null) : 'Fascicolo cliente';
  const userOf = (userId?: string | null) => users.find((u) => u.id === userId)?.name ?? (userId ? 'Utente non attivo' : 'Sistema');
  const documentAvailability = new Map(await Promise.all(visibleDocuments.map(async (d) => [d.id, await privateDocumentExists(d.storagePath)] as const)));
  const missingChecklistItems = checklistItems.filter(isMissingChecklistDocument);
  const receivedChecklistItems = checklistItems.filter((item) => item.documentId || ['ricevuto','validato'].includes(item.status));
  const requestText = missingChecklistItems.length ? `Gentile cliente, per proseguire con la lavorazione della pratica abbiamo necessità di ricevere i seguenti documenti: ${missingChecklistItems.map((item) => item.title).join('; ')}. Restiamo a disposizione per eventuali chiarimenti.` : 'Nessun documento mancante risulta richiesto in checklist.';
  const documentCenterGroups = [
    { title: 'Documenti mancanti', tone: 'border-amber-200 bg-amber-50/70', rows: missingChecklistItems.map((item) => ({ id: item.id, title: item.title, clientName: client.displayName, practice: item.clientServiceId ? labelOf(serviceById.get(item.clientServiceId)) : item.projectId ? projectById.get(item.projectId)?.title ?? 'Pratica collegata' : 'Fascicolo generale', category: 'Checklist', status: item.status, date: item.updatedAt, note: item.notes ?? 'Documento richiesto non ancora collegato.', action: null })) },
    { title: 'Documenti ricevuti', tone: 'border-blue-200 bg-blue-50/60', rows: visibleDocuments.filter((d) => ['caricato','classificato','estratto'].includes(d.status)).map((d) => ({ id: d.id, title: d.title, clientName: client.displayName, practice: d.clientServiceId ? labelOf(serviceById.get(d.clientServiceId)) : d.projectId ? projectById.get(d.projectId)?.title ?? 'Pratica collegata' : 'Fascicolo generale', category: d.documentCategory, status: d.status, date: d.updatedAt, note: d.fileName, action: documentAvailability.get(d.id) ? `/documents/${d.id}/download` : null })) },
    { title: 'Da verificare', tone: 'border-orange-200 bg-orange-50/60', rows: visibleDocuments.filter((d) => d.status === 'da_verificare').map((d) => ({ id: d.id, title: d.title, clientName: client.displayName, practice: d.clientServiceId ? labelOf(serviceById.get(d.clientServiceId)) : 'Fascicolo generale', category: d.documentCategory, status: d.status, date: d.updatedAt, note: d.fileName, action: documentAvailability.get(d.id) ? `/documents/${d.id}/download` : null })) },
    { title: 'Approvati', tone: 'border-green-200 bg-green-50/60', rows: visibleDocuments.filter((d) => d.status === 'verificato').map((d) => ({ id: d.id, title: d.title, clientName: client.displayName, practice: d.clientServiceId ? labelOf(serviceById.get(d.clientServiceId)) : 'Fascicolo generale', category: d.documentCategory, status: d.status, date: d.updatedAt, note: d.fileName, action: documentAvailability.get(d.id) ? `/documents/${d.id}/download` : null })) },
    { title: 'Scartati / da sostituire', tone: 'border-red-200 bg-red-50/60', rows: visibleDocuments.filter((d) => ['respinto','scaduto'].includes(d.status)).map((d) => ({ id: d.id, title: d.title, clientName: client.displayName, practice: d.clientServiceId ? labelOf(serviceById.get(d.clientServiceId)) : 'Fascicolo generale', category: d.documentCategory, status: d.status, date: d.updatedAt, note: d.fileName, action: documentAvailability.get(d.id) ? `/documents/${d.id}/download` : null })) },
    { title: 'Altro / non classificato', tone: 'border-slate-200 bg-slate-50/70', rows: visibleDocuments.filter((d) => ['archiviato'].includes(d.status) || !d.documentCategory || d.documentCategory === 'altro').map((d) => ({ id: d.id, title: d.title, clientName: client.displayName, practice: d.clientServiceId ? labelOf(serviceById.get(d.clientServiceId)) : 'Fascicolo generale', category: d.documentCategory || 'Altro', status: d.status, date: d.updatedAt, note: d.fileName, action: documentAvailability.get(d.id) ? `/documents/${d.id}/download` : null })) },
  ];
  const serviceAreas = ['anagrafica','bancabilita','finanziamento_aziendale','bandi_finanza_agevolata','progetto_investimento','contratti','pagamenti','dossier','output_ai','altro'];
  const timelineFilters = [['tutti', 'Tutti'], ['stato', 'Stato pratica'], ['comunicazioni', 'Comunicazioni'], ['documenti', 'Documenti'], ['task', 'Task'], ['audit', 'Audit']] as const;
  const activeTimelineFilter = timelineFilters.some(([value]) => value === query?.timelineFilter) ? query?.timelineFilter : 'tutti';
  const allTimelineEvents = [
    { id: `client-created-${client.id}`, date: client.createdAt, user: userOf(client.salesOwnerId), type: 'creazione fascicolo', entity: 'Cliente', category: 'stato', description: `Creato fascicolo cliente ${client.displayName}`, beforeAfter: null },
    ...clientServices.map((svc) => ({ id: `service-status-${svc.id}`, date: svc.statusUpdatedAt, user: userOf(svc.assignedToId), type: 'stato pratica', entity: 'Servizio cliente', category: 'stato', description: `${nameOf(svc.serviceCatalogId)} · stato operativo ${operationalStatusLabel(svc.operationalStatus)}`, beforeAfter: svc.operationalNotes ?? svc.internalNotes })),
    ...technicalPractices.map((practice) => ({ id: `technical-practice-${practice.id}`, date: practice.updatedAt, user: userOf(practice.technicalOwnerId ?? practice.commercialOwnerId), type: 'stato pratica tecnica', entity: 'Pratica tecnica', dedupeKey: practice.id, category: 'stato', description: `${practice.title} · ${practice.status.replaceAll('_', ' ')}`, beforeAfter: practice.clientVisibleStatus ?? practice.integrationRequestNote })),
    ...practiceCommunications.flatMap((c) => [
      { id: `communication-created-${c.id}`, date: c.createdAt, user: userOf(c.createdById), type: 'comunicazione creata', entity: 'Comunicazione pratica', dedupeKey: c.id, category: 'comunicazioni', description: `${c.title} · ${c.type}/${c.channel}`, beforeAfter: c.internalNote ?? c.content.slice(0, 180) },
      ...(c.reviewedAt ? [{ id: `communication-reviewed-${c.id}`, date: c.reviewedAt, user: userOf(c.reviewedById), type: 'comunicazione approvata', entity: 'Comunicazione pratica', dedupeKey: c.id, category: 'comunicazioni', description: `${c.title} approvata`, beforeAfter: c.internalNote ?? null }] : []),
      ...(c.usedAt ? [{ id: `communication-used-${c.id}`, date: c.usedAt, user: userOf(c.reviewedById), type: 'comunicazione usata/inviata', entity: 'Comunicazione pratica', dedupeKey: c.id, category: 'comunicazioni', description: `${c.title} segnata come usata/inviata`, beforeAfter: 'Invio manuale tracciato: nessun automatismo CRM.' }] : []),
    ]),
    ...documents.flatMap((d) => [
      { id: `document-created-${d.id}`, date: d.createdAt, user: userOf(d.uploadedById), type: 'documento caricato', entity: 'Documento', category: 'documenti', description: `${d.title} · ${d.documentCategory}`, beforeAfter: d.status.replaceAll('_', ' ') },
      ...(d.updatedAt.getTime() !== d.createdAt.getTime() ? [{ id: `document-updated-${d.id}`, date: d.updatedAt, user: userOf(d.uploadedById), type: 'documento aggiornato', entity: 'Documento', category: 'documenti', description: `${d.title} aggiornato`, beforeAfter: `Stato ${d.status.replaceAll('_', ' ')}` }] : []),
    ]),
    ...tasks.map((t) => ({ id: `task-${t.id}`, date: t.updatedAt ?? t.createdAt, user: userOf(t.assignedToId ?? t.createdById), type: 'task/scadenza', entity: 'Task', category: 'task', description: `${t.title} · ${t.status.replaceAll('_', ' ')}`, beforeAfter: [t.description, t.dueAt ? `Scadenza ${formatDateTime(t.dueAt)}` : null].filter(Boolean).join(' · ') || null })),
    ...auditLogs.map((a) => ({ id: `audit-${a.id}`, date: a.createdAt, user: userOf(a.actorId), type: auditLabel(a.event), entity: a.entityType ?? 'AuditLog', dedupeKey: a.entityId, category: 'audit', description: auditLabel(a.event), beforeAfter: a.before || a.after ? 'Dettaglio disponibile nel registro audit.' : null })),
  ].sort((a, b) => +new Date(b.date) - +new Date(a.date));
  const timeline = allTimelineEvents.filter((event) => activeTimelineFilter === 'tutti' ? !isRedundantOperationalAudit(event, allTimelineEvents) : event.category === activeTimelineFilter).slice(0, 60);
  const visibleServiceSections = serviceSections.filter(([sectionId]) => {
    if (['azienda-visura-ateco','titolari-soci-amministratori'].includes(sectionId)) return canReadCompanies;
    if (['progetti','finanziamento-aziendale','bandi-finanza-agevolata','bancabilita'].includes(sectionId)) return canReadProjects;
    if (['servizi-acquistati','checklist-documentale','task-scadenze'].includes(sectionId)) return canReadServices;
    if (['documenti','centro-documentale'].includes(sectionId)) return canViewDocuments;
    if (['pre-analisi','dossier'].includes(sectionId)) return canReadDossiers;
    if (sectionId === 'contratti') return canReadContracts;
    if (sectionId === 'pagamenti') return canReadPayments;
    if (sectionId === 'ufficio-tecnico-pratiche') return canReadTechnical;
    if (sectionId === 'comunicazioni-pratica') return canReadCommunications;
    if (sectionId === 'output-ai') return canReviewAi || canRunAiAgents;
    if (sectionId === 'audit-log') return canReadAudit;
    return true;
  });

  return <div className="space-y-8">
    <PageHeader title={`Fascicolo Cliente Interno — ${client.displayName}`} description="Scheda operativa interna FAI: servizi acquistati, documenti per sezione, output AI in bozza con revisione umana obbligatoria e audit."/><div className="flex flex-wrap items-center justify-between gap-3"><div className="flex flex-wrap gap-2"><SecondaryLink href="/clients">← Torna alla lista</SecondaryLink><SecondaryLink href={`/clients/${client.id}/operational-report`}>Esporta fascicolo completo</SecondaryLink><SecondaryLink href={`/clients/${client.id}/operational-report/docx`}>Report Word</SecondaryLink></div><div className="flex flex-wrap gap-2"><StatusBadge status={client.status} /><span className="rounded-full bg-white px-3 py-1 text-xs font-black uppercase tracking-wide text-fai-navy ring-1 ring-slate-200">Operatore: {userOf(client.consultantId)}</span></div></div>
    <nav className="sticky top-20 z-10 flex flex-wrap gap-2 rounded-[1.5rem] border border-white/75 bg-white/88 p-3 shadow-xl shadow-slate-200/60 ring-1 ring-slate-900/5 backdrop-blur-xl">{visibleServiceSections.map(([id, label]) => <a className="rounded-full bg-fai-blue/8 px-3 py-2 text-xs font-black text-fai-blue ring-1 ring-fai-blue/10 transition hover:-translate-y-0.5 hover:bg-fai-blue hover:text-white hover:shadow-lg hover:shadow-fai-blue/15 focus:outline-none focus:ring-2 focus:ring-fai-lime" href={`#${id}`} key={id}>{label}</a>)}</nav>

    <Card id="overview" title="Overview"><div className="grid gap-4 md:grid-cols-4"><div className="rounded-2xl bg-gradient-to-br from-fai-navy to-fai-blue p-5 text-white shadow-lg shadow-fai-blue/20"><p className="text-lg font-black">{client.displayName}</p><p className="mt-2 text-sm text-white/75">Tipo: {client.type}</p><div className="mt-3"><StatusBadge status={client.status} /></div></div>{[[companies.length,'Aziende','from-fai-lime to-fai-green'],[projects.length,'Progetti','from-fai-blue to-fai-purple'],[clientServices.length,'Servizi','from-fai-orange to-fai-lime']].map(([value,label,gradient])=><div key={String(label)} className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200"><p className={`bg-gradient-to-br ${gradient} bg-clip-text text-4xl font-black text-transparent`}>{value}</p><span className="mt-1 block text-xs font-black uppercase tracking-wide text-slate-500">{label}</span></div>)}</div><TimestampMeta createdAt={client.createdAt} updatedAt={client.updatedAt} createdBy={userOf(client.salesOwnerId)} updatedBy={userOf(client.consultantId)} /></Card>
    <Card id="anagrafica-completa" title="Anagrafica completa"><p>Nome visualizzato: {client.displayName}</p><p>Tipo cliente: {client.type}</p><p>Note: {client.notes ?? '—'}</p><TimestampMeta createdAt={client.createdAt} updatedAt={client.updatedAt} /></Card>
    <Card id="azienda-visura-ateco" title="Azienda / Visura / ATECO">{companies.length === 0 ? <EmptyState title="Nessuna azienda collegata" /> : <Table headers={['Azienda','P.IVA','ATECO','Stato','Creato il','Aggiornato il']} rows={companies.map((c) => [c.name, c.vatNumber ?? '—', [c.atecoCode, c.atecoDescription].filter(Boolean).join(' · ') || '—', c.activityStatus ?? '—', formatDateTime(c.createdAt), formatDateTime(c.updatedAt)])} />}</Card>
    <Card id="titolari-soci-amministratori" title="Titolari, soci e amministratori"><EmptyState title="Assetto societario da completare">Collegare soci, titolari effettivi e amministratori dalla visura verificata.</EmptyState></Card>
    <Card id="progetti" title="Progetti">{projects.length === 0 ? <EmptyState title="Nessun progetto" /> : <Table headers={['Titolo','Stato','Creato il','Aggiornato il']} rows={projects.map((p) => [p.title, <StatusBadge status={p.status} key="s" />, formatDateTime(p.createdAt), formatDateTime(p.updatedAt)])} />}</Card>
    <Card id="servizi-acquistati" title="Servizi acquistati"><div className="grid gap-4 md:grid-cols-2">{clientServices.map((s) => <article id={`service-${s.id}`} key={s.id} className="scroll-mt-36 rounded-2xl border border-slate-200/80 bg-gradient-to-br from-white to-slate-50/80 p-5 shadow-sm ring-1 ring-white transition hover:-translate-y-0.5 hover:shadow-lg"><div className="flex items-start justify-between gap-3"><div><h3 className="font-semibold text-fai-navy">{nameOf(s.serviceCatalogId)}</h3><p className="text-sm text-fai-gray">Responsabile: {userOf(s.assignedToId)}</p></div><div className="flex gap-2"><StatusBadge status={s.paymentStatus} /><StatusBadge status={s.status} /></div></div><TimestampMeta createdAt={s.openedAt ?? s.createdAt} updatedAt={s.statusUpdatedAt ?? s.updatedAt} updatedBy={userOf(s.assignedToId)} /><div className="mt-4 grid gap-3 rounded-2xl bg-white/80 p-3 text-sm ring-1 ring-slate-200/70"><div className="flex flex-wrap gap-2"><StatusBadge status={s.operationalStatus} /><span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-bold text-slate-600">Agg. stato: {formatDateTime(s.statusUpdatedAt)}</span></div><p className="text-slate-600">Tipologia: {s.practiceType ?? nameOf(s.serviceCatalogId)} · Importo richiesto: {moneyLabel(s.requestedAmount)} · Investimento previsto: {moneyLabel(s.plannedInvestment)}</p><p className="text-slate-600">Note operative: {s.operationalNotes ?? s.internalNotes ?? '—'}</p></div>{canManageChecklist ? <form action={updateServicePipelineAndRefresh} className="mt-3 grid gap-2 rounded-2xl bg-fai-blue/5 p-3 ring-1 ring-fai-blue/10 md:grid-cols-2"><input type="hidden" name="id" value={s.id}/><select name="operationalStatus" defaultValue={s.operationalStatus} className="rounded-xl border px-3 py-2 text-sm">{operationalStatuses.map(st=><option key={st} value={st}>{operationalStatusLabel(st)}</option>)}</select>{canAssignServices ? <select name="assignedToId" defaultValue={s.assignedToId??''} className="rounded-xl border px-3 py-2 text-sm"><option value="">Da assegnare</option>{users.map(u=><option key={u.id} value={u.id}>{u.name}</option>)}</select> : <p className="rounded-xl border bg-slate-50 px-3 py-2 text-sm text-slate-500">Responsabile: {userOf(s.assignedToId)}</p>}<input className="rounded-xl border p-2 text-sm" name="practiceType" defaultValue={s.practiceType ?? ''} placeholder="Tipologia pratica"/><input className="rounded-xl border p-2 text-sm" name="requestedAmount" defaultValue={s.requestedAmount ? String(s.requestedAmount) : ''} placeholder="Importo richiesto"/><input className="rounded-xl border p-2 text-sm" name="plannedInvestment" defaultValue={s.plannedInvestment ? String(s.plannedInvestment) : ''} placeholder="Investimento previsto"/><textarea className="rounded-xl border p-2 text-sm" name="operationalNotes" defaultValue={s.operationalNotes ?? ''} placeholder="Note operative brevi" rows={2}/><div className="md:col-span-2"><PrimaryButton type="submit">Aggiorna pipeline</PrimaryButton></div></form> : null}<p className="mt-4 rounded-2xl bg-white/80 p-3 text-sm leading-6 text-slate-600 ring-1 ring-slate-200/70">Note interne: {s.internalNotes ?? '—'}</p><div className="mt-3 grid gap-2 md:grid-cols-2"><form action={updateServiceStatusAndRefresh} className="flex gap-2"><input type="hidden" name="id" value={s.id}/><select name="status" defaultValue={s.status} className="min-w-0 flex-1 rounded-xl border px-3 py-2 text-sm">{['richiesto','pagato','raccolta_documenti','in_lavorazione','bozza_ai','revisione_umana','consegnabile','consegnato','sospeso','chiuso','archiviato'].map(st=><option key={st} value={st}>{st}</option>)}</select><PrimaryButton type="submit">Salva</PrimaryButton></form>{canAssignServices ? <form action={assignServiceAndRefresh} className="flex gap-2"><input type="hidden" name="id" value={s.id}/><select name="assignedToId" defaultValue={s.assignedToId??''} className="min-w-0 flex-1 rounded-xl border px-3 py-2 text-sm"><option value="">Da assegnare</option>{users.map(u=><option key={u.id} value={u.id}>{u.name}</option>)}</select><PrimaryButton type="submit">Assegna</PrimaryButton></form> : <p className="rounded-xl bg-slate-50 px-3 py-2 text-sm text-slate-500 ring-1 ring-slate-200">Assegnazione non disponibile per il tuo ruolo.</p>}</div><form action={uploadDocumentAndRefresh} className="mt-4 grid gap-2 rounded-2xl bg-white/80 p-3 ring-1 ring-slate-200 md:grid-cols-2"><input type="hidden" name="clientId" value={client.id}/><input type="hidden" name="companyId" value={s.companyId ?? ''}/><input type="hidden" name="projectId" value={s.projectId ?? ''}/><input type="hidden" name="clientServiceId" value={s.id}/><input className="rounded-xl border p-2 text-sm" type="file" name="file" required/><input className="rounded-xl border p-2 text-sm" name="title" placeholder="Titolo documento" required/><select className="rounded-xl border p-2 text-sm" name="serviceArea" defaultValue="altro">{serviceAreas.map(a=><option key={a} value={a}>{a}</option>)}</select><input className="rounded-xl border p-2 text-sm" name="documentCategory" placeholder="Categoria" defaultValue="altro"/><label className="flex items-center gap-2 text-xs font-bold"><input type="checkbox" name="containsSensitiveData" value="true"/> Sensibile</label><PrimaryButton type="submit">Carica documento</PrimaryButton></form><p className="mt-3 text-xs leading-5 text-slate-500">Checklist documentale gestita nella sezione dedicata del fascicolo.</p></article>)}</div>{clientServices.length === 0 && <EmptyState title="Nessun servizio acquistato" />}</Card>
    <Card id="finanziamento-aziendale" title="Finanziamento aziendale">{financing.length === 0 ? <EmptyState title="Nessuna valutazione finanziamento"/> : <Table headers={['Importo richiesto','Finalità','Prossima azione','Creato il','Aggiornato il']} rows={financing.map((f) => [f.requestedAmount ? `€ ${Number(f.requestedAmount).toLocaleString('it-IT')}` : '—', f.purpose ?? '—', f.nextAction ?? '—', formatDateTime(f.createdAt), formatDateTime(f.updatedAt)])} />}</Card>
    <Card id="bandi-finanza-agevolata" title="Bandi / Finanza agevolata"><EmptyState title="Misure da verificare">Stato misura, apertura, chiusura, fonti ufficiali, condizioni e prossime azioni saranno tracciati qui.</EmptyState></Card>
    <Card id="bancabilita" title="Bancabilità">{bankability.length === 0 ? <EmptyState title="Nessun assessment" /> : <Table headers={['Rischio','Completezza','Revisione','Aggiornato il']} rows={bankability.map((b) => [<StatusBadge status={b.riskLevel} key="r" />, `${b.dataCompleteness}%`, b.humanReviewStatus, formatDateTime(b.updatedAt)])} />}</Card>
    <Card id="documenti" title="Documenti">{query?.uploadError ? <div className="mb-4 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm font-semibold text-red-700">{query.uploadError}</div> : null}{hasPermission(session, 'document.upload') ? <DocumentUploadForm fixedClientId={client.id} clients={[{ id: client.id, clientId: client.id, label: client.displayName }]} companies={companies.map((c) => ({ id: c.id, clientId: c.clientId, label: c.name }))} projects={projects.map((project) => ({ id: project.id, clientId: project.clientId, label: project.title }))} services={clientServices.map((service) => ({ id: service.id, clientId: service.clientId, label: nameOf(service.serviceCatalogId) }))} serviceAreas={serviceAreas} submitLabel="Carica" className="mb-5 grid gap-3 md:grid-cols-4" buttonClassName="" /> : null}{!canViewDocuments ? <EmptyState title="Documenti non disponibili per il tuo ruolo" /> : visibleDocuments.length === 0 ? <EmptyState title="Nessun documento" /> : <Table headers={['Documento','Sezione','Categoria','Servizio','Sensibile','Stato file','Tracciabilità','Scadenza','Download']} rows={visibleDocuments.map((d) => { const ok = documentAvailability.get(d.id); return [<span key="n">{d.title}<br/><span className="text-xs text-slate-500">{d.fileName}{!ok ? ' · metadata demo / file non caricato' : ''}</span></span>, d.serviceArea, d.documentCategory, d.clientServiceId ? nameOf(clientServices.find(s => s.id === d.clientServiceId)?.serviceCatalogId ?? '') : 'Fascicolo generale', d.containsSensitiveData ? 'Sì' : 'No', ok ? 'disponibile' : 'metadata demo / non caricato', <span key="t">Caricato il {formatDateTime(d.createdAt)} da {userOf(d.uploadedById)}<br/>Aggiornato il {formatDateTime(d.updatedAt)}</span>, formatDateTime(d.validUntil), ok ? <SecondaryLink key="d" href={`/documents/${d.id}/download`}>Scarica</SecondaryLink> : <DisabledAction key="d" reason="File fisico assente nello storage privato">File non disponibile</DisabledAction>]; })} />}</Card>

    {canViewDocuments ? <Card id="centro-documentale" title="Centro documentale"><div className="mb-5 grid gap-4 lg:grid-cols-[1fr_0.9fr]"><div className="rounded-2xl bg-fai-blue/5 p-4 ring-1 ring-fai-blue/10"><h3 className="text-sm font-black uppercase tracking-wide text-fai-navy">Richiesta documenti pronta</h3><p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-slate-700">{requestText}</p></div>{canManageTasks && missingChecklistItems.length > 0 ? <form action={createClientTaskAndRefresh} className="grid gap-3 rounded-2xl bg-slate-50 p-4 ring-1 ring-slate-200"><input type="hidden" name="clientId" value={client.id}/><input type="hidden" name="title" value="Sollecito documenti mancanti"/><input type="hidden" name="description" value={requestText}/><input type="hidden" name="priority" value="media"/><p className="text-sm text-slate-600"><b>Azione operativa:</b> crea un task interno per sollecitare i documenti mancanti rilevati dalla checklist.</p><PrimaryButton type="submit">Crea task sollecito documenti</PrimaryButton></form> : <EmptyState title="Nessun sollecito necessario">La checklist non contiene documenti mancanti da sollecitare.</EmptyState>}</div><div className="grid gap-4 xl:grid-cols-2">{documentCenterGroups.map((group) => <section key={group.title} className={`rounded-2xl border p-4 ${group.tone}`}><div className="mb-3 flex items-center justify-between gap-2"><h3 className="font-black text-fai-navy">{group.title}</h3><span className="rounded-full bg-white px-2.5 py-1 text-xs font-black text-slate-600 ring-1 ring-slate-200">{group.rows.length}</span></div>{group.rows.length === 0 ? <EmptyState title="Nessun documento in questo gruppo" /> : <div className="space-y-3">{group.rows.map((row) => <article key={row.id} className="rounded-2xl bg-white/90 p-3 text-sm shadow-sm ring-1 ring-slate-200"><div className="flex flex-wrap items-start justify-between gap-2"><div><p className="font-black text-fai-navy">{row.title}</p><p className="text-xs leading-5 text-slate-500">{row.clientName} · {row.practice}</p></div><StatusBadge status={row.status} /></div><p className="mt-2 text-xs leading-5 text-slate-600">Categoria/tipo: {row.category} · Aggiornato: {formatDateTime(row.date)}</p><p className="mt-1 text-xs leading-5 text-slate-500">{row.note}</p>{row.action ? <div className="mt-3"><SecondaryLink href={row.action}>Apri/Scarica</SecondaryLink></div> : null}</article>)}</div>}</section>)}</div><p className="mt-4 text-xs leading-5 text-slate-500">Checklist collegata: {receivedChecklistItems.length} voci presenti o ricevute, {missingChecklistItems.length} ancora mancanti. Le pratiche tecniche collegate al cliente restano consultabili nella sezione Ufficio Tecnico / Pratiche.</p></Card> : null}

    <Card id="checklist-documentale" title="Checklist documentale">
      <div className="mb-5 grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
        {canManageChecklist ? <form action={createChecklistItemAndRefresh} className="grid gap-3 rounded-2xl bg-slate-50/80 p-4 ring-1 ring-slate-200 md:grid-cols-2">
          <input type="hidden" name="clientId" value={client.id}/>
          <input className="rounded-xl border p-2 text-sm md:col-span-2" name="title" placeholder="Titolo documento richiesto" required />
          <textarea className="rounded-xl border p-2 text-sm md:col-span-2" name="notes" placeholder="Descrizione / note opzionali" rows={2} />
          <select className="rounded-xl border p-2 text-sm" name="clientServiceId" defaultValue=""><option value="">Fascicolo generale cliente</option>{clientServices.map((service) => <option key={service.id} value={service.id}>{nameOf(service.serviceCatalogId)}</option>)}</select>
          <select className="rounded-xl border p-2 text-sm" name="projectId" defaultValue=""><option value="">Nessun progetto</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.title}</option>)}</select>
          <select className="rounded-xl border p-2 text-sm" name="status" defaultValue="da_richiedere">{checklistStatuses.map((status) => <option key={status} value={status}>{status.replaceAll('_', ' ')}</option>)}</select>
          <select className="rounded-xl border p-2 text-sm" name="documentId" defaultValue=""><option value="">Nessun documento collegato</option>{visibleDocuments.map((document) => <option key={document.id} value={document.id}>{document.title}</option>)}</select>
          <PrimaryButton type="submit">Crea voce</PrimaryButton>
        </form> : <EmptyState title="Checklist in sola lettura">Il tuo ruolo può consultare la checklist documentale ma non modificarla.</EmptyState>}
        {canManageChecklist ? <form action={createStandardChecklistAndRefresh} className="rounded-2xl bg-fai-blue/5 p-4 ring-1 ring-fai-blue/10">
          <input type="hidden" name="clientId" value={client.id}/>
          <label className="text-xs font-black uppercase tracking-wide text-fai-navy">Set base suggerito</label>
          <p className="mt-2 text-sm leading-6 text-slate-600">Inserisce le voci standard per pratiche di finanza agevolata e ordinaria, evitando duplicati con lo stesso titolo.</p>
          <select className="mt-3 w-full rounded-xl border p-2 text-sm" name="clientServiceId" defaultValue=""><option value="">Checklist generale cliente</option>{clientServices.map((service) => <option key={service.id} value={service.id}>{nameOf(service.serviceCatalogId)}</option>)}</select>
          <select className="mt-3 w-full rounded-xl border p-2 text-sm" name="projectId" defaultValue=""><option value="">Nessun progetto</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.title}</option>)}</select>
          <div className="mt-4"><PrimaryButton type="submit">Inserisci set base</PrimaryButton></div>
        </form> : null}
      </div>
      {checklistItems.length === 0 ? <EmptyState title="Nessuna voce checklist" /> : <Table headers={['Documento richiesto','Contesto','Stato','Documento collegato','Aggiornato','Azioni']} rows={checklistItems.map((item) => {
        const linkedDocument = item.documentId ? documentById.get(item.documentId) : null;
        const service = item.clientServiceId ? serviceById.get(item.clientServiceId) : null;
        const project = item.projectId ? projectById.get(item.projectId) : null;
        return [
          <span key="title" className="font-semibold text-fai-navy">{item.title}<br/><span className="text-xs font-normal leading-5 text-slate-500">{item.notes ?? '—'}</span></span>,
          <span key="ctx">{service ? nameOf(service.serviceCatalogId) : 'Fascicolo generale'}<br/><span className="text-xs text-slate-500">{project?.title ?? 'Nessun progetto'}</span></span>,
          canManageChecklist ? <form key="status" action={updateChecklistItemStatusAndRefresh} className="flex gap-2"><input type="hidden" name="id" value={item.id}/><select name="status" defaultValue={item.status} className="rounded-xl border p-2 text-xs">{checklistStatuses.map((status) => <option key={status} value={status}>{status.replaceAll('_', ' ')}</option>)}</select><PrimaryButton type="submit">Salva</PrimaryButton></form> : <StatusBadge key="status" status={item.status} />,
          <span key="doc">{linkedDocument ? <><span className="font-semibold text-fai-navy">{linkedDocument.title}</span><br/><span className="text-xs text-slate-500">{linkedDocument.fileName}</span></> : '—'}</span>,
          formatDateTime(item.updatedAt),
          canManageChecklist ? <div key="actions" className="space-y-2"><form action={linkChecklistItemDocumentAndRefresh} className="flex gap-2"><input type="hidden" name="id" value={item.id}/><select name="documentId" defaultValue={item.documentId ?? ''} className="min-w-0 flex-1 rounded-xl border p-2 text-xs"><option value="" disabled>Seleziona documento</option>{visibleDocuments.map((document) => <option key={document.id} value={document.id}>{document.title}</option>)}</select><PrimaryButton type="submit">Collega</PrimaryButton></form>{item.documentId ? <form action={unlinkChecklistItemDocumentAndRefresh}><input type="hidden" name="id" value={item.id}/><button className="rounded-xl border border-slate-200 px-3 py-2 text-xs font-bold text-slate-600 hover:bg-slate-50" type="submit">Scollega</button></form> : null}<form action={deactivateChecklistItemAndRefresh}><input type="hidden" name="id" value={item.id}/><button className="rounded-xl border border-red-200 px-3 py-2 text-xs font-bold text-red-600 hover:bg-red-50" type="submit">Disattiva</button></form></div> : '—'
        ];
      })} />}
    </Card>
    <Card id="pre-analisi" title="Pre-analisi">{preAnalyses.length === 0 ? <EmptyState title="Nessuna pre-analisi" /> : <Table headers={['Stato','Sintesi','Creato il','Aggiornato il']} rows={preAnalyses.map((p) => [<StatusBadge status={p.status} key='s' />, p.internalSummary ?? '—', formatDateTime(p.createdAt), formatDateTime(p.updatedAt)])} />}</Card>
    <Card id="dossier" title="Dossier / Pre-analisi">
      {canManageDossiers ? <form action={generateClientDossierAndRedirect} className="mb-5 grid gap-3 rounded-2xl bg-fai-blue/5 p-4 ring-1 ring-fai-blue/10 md:grid-cols-4">
        <input type="hidden" name="clientId" value={client.id}/>
        <input className="rounded-xl border p-2 text-sm md:col-span-2" name="title" placeholder="Titolo bozza (opzionale)" />
        <select className="rounded-xl border p-2 text-sm" name="type" defaultValue="pre_analisi"><option value="pre_analisi">Pre-analisi</option><option value="dossier_cliente">Dossier cliente</option><option value="nota_interna">Nota interna</option></select>
        <select className="rounded-xl border p-2 text-sm" name="clientServiceId" defaultValue=""><option value="">Tutto il fascicolo</option>{clientServices.map((service) => <option key={service.id} value={service.id}>{nameOf(service.serviceCatalogId)}</option>)}</select>
        <select className="rounded-xl border p-2 text-sm" name="projectId" defaultValue=""><option value="">Tutti i progetti</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.title}</option>)}</select>
        <div className="md:col-span-2"><PrimaryButton type="submit">Genera bozza dossier</PrimaryButton></div>
      </form> : <EmptyState title="Dossier in sola lettura">Il tuo ruolo può consultare le bozze dossier ma non generarne di nuove.</EmptyState>}
      {clientDossiers.length === 0 ? <EmptyState title="Nessuna bozza dossier/pre-analisi" /> : <Table headers={['Titolo','Tipo','Stato','Contesto','Creato il','Aggiornato il','Azione']} rows={clientDossiers.map((d) => [<span className="font-semibold text-fai-navy" key="t">{d.title}</span>, d.type.replaceAll('_', ' '), <StatusBadge status={d.status} key='s' />, d.clientServiceId ? labelOf(serviceById.get(d.clientServiceId)) : 'Fascicolo cliente', formatDateTime(d.createdAt), formatDateTime(d.updatedAt), <Link className="font-bold text-fai-blue underline" href={`/client-dossiers/${d.id}`} key="open">Apri</Link>])} />}
      {dossiers.length > 0 ? <div className="mt-6"><h3 className="mb-3 text-sm font-black uppercase tracking-wide text-slate-500">Dossier legacy progetto</h3><Table headers={['Titolo','Tipo','Stato','Creato il','Aggiornato il']} rows={dossiers.map((d) => [d.title, d.type, <StatusBadge status={d.status} key='s' />, formatDateTime(d.createdAt), formatDateTime(d.updatedAt)])} /></div> : null}
    </Card>
    <Card id="contratti" title="Contratti">{contracts.length === 0 ? <EmptyState title="Nessun contratto" /> : <Table headers={['Numero','Servizio','Totale','Stato','Creato il','Aggiornato il']} rows={contracts.map((c) => [c.contractNumber, c.serviceName, `€ ${Number(c.totalAmount).toLocaleString('it-IT')}`, <StatusBadge status={c.status} key='s' />, formatDateTime(c.createdAt), formatDateTime(c.updatedAt)])} />}</Card>
    <Card id="pagamenti" title="Pagamenti">{payments.length === 0 ? <EmptyState title="Nessun pagamento" /> : <Table headers={['Totale','Metodo','Scadenza','Stato','Creato il','Aggiornato il']} rows={payments.map((p) => [`€ ${Number(p.totalAmount).toLocaleString('it-IT')}`, p.method ?? '—', formatDateTime(p.dueDate), <StatusBadge status={p.status} key='s' />, formatDateTime(p.createdAt), formatDateTime(p.updatedAt)])} />}</Card>
    <Card id="task-scadenze" title="Attività e scadenze">
      {canManageTasks ? <form action={createClientTaskAndRefresh} className="mb-5 grid gap-3 rounded-2xl bg-slate-50/80 p-4 ring-1 ring-slate-200 md:grid-cols-2">
        <input type="hidden" name="clientId" value={client.id}/>
        <input className="rounded-xl border p-2 text-sm md:col-span-2" name="title" placeholder="Titolo attività" required />
        <textarea className="rounded-xl border p-2 text-sm md:col-span-2" name="description" placeholder="Descrizione / note opzionali" rows={2} />
        <select className="rounded-xl border p-2 text-sm" name="clientServiceId" defaultValue=""><option value="">Fascicolo generale cliente</option>{clientServices.map((service) => <option key={service.id} value={service.id}>{nameOf(service.serviceCatalogId)}</option>)}</select>
        <select className="rounded-xl border p-2 text-sm" name="projectId" defaultValue=""><option value="">Nessun progetto/pratica</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.title}</option>)}</select>
        <select className="rounded-xl border p-2 text-sm" name="priority" defaultValue="media">{taskPriorities.map((priority) => <option key={priority} value={priority}>{priority}</option>)}</select>
        <input className="rounded-xl border p-2 text-sm" type="date" name="dueAt" />
        <select className="rounded-xl border p-2 text-sm" name="assignedToId" defaultValue=""><option value="">Nessun assegnatario</option>{users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select>
        <PrimaryButton type="submit">Crea attività</PrimaryButton>
      </form> : <EmptyState title="Attività in sola lettura">Il tuo ruolo può consultare le attività ma non modificarle.</EmptyState>}
      {tasks.length === 0 ? <EmptyState title="Nessuna attività" /> : <Table headers={['Attività','Contesto','Priorità','Scadenza','Stato','Assegnatario','Aggiornato','Azioni']} rows={tasks.map((t) => {
        const service = t.clientServiceId ? serviceById.get(t.clientServiceId) : null;
        const project = t.projectId ? projectById.get(t.projectId) : null;
        return [
          <span key="title" className="font-semibold text-fai-navy">{t.title}<br/><span className="text-xs font-normal leading-5 text-slate-500">{t.description ?? '—'}</span></span>,
          <span key="ctx">{service ? nameOf(service.serviceCatalogId) : 'Fascicolo generale'}<br/><span className="text-xs text-slate-500">{project?.title ?? 'Nessun progetto/pratica'}</span></span>,
          <StatusBadge key="priority" status={t.priority} />,
          formatDateTime(t.dueAt),
          <StatusBadge status={t.status} key='s' />,
          userOf(t.assignedToId),
          formatDateTime(t.updatedAt),
          canManageTasks ? <div key="actions" className="space-y-2"><form action={updateClientTaskAndRefresh} className="grid gap-2"><input type="hidden" name="id" value={t.id}/><select name="status" defaultValue={t.status} className="rounded-xl border p-2 text-xs">{taskStatuses.map((status) => <option key={status} value={status}>{status.replaceAll('_', ' ')}</option>)}</select><select name="priority" defaultValue={t.priority} className="rounded-xl border p-2 text-xs">{taskPriorities.map((priority) => <option key={priority} value={priority}>{priority}</option>)}</select><input type="date" name="dueAt" defaultValue={t.dueAt ? t.dueAt.toISOString().slice(0,10) : ''} className="rounded-xl border p-2 text-xs"/><select name="assignedToId" defaultValue={t.assignedToId ?? ''} className="rounded-xl border p-2 text-xs"><option value="">Nessun assegnatario</option>{users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select><PrimaryButton type="submit">Salva</PrimaryButton></form>{t.status !== 'completata' ? <form action={completeTask}><input type="hidden" name="id" value={t.id}/><PrimaryButton type="submit">Completa</PrimaryButton></form> : null}</div> : '—'
        ];
      })} />}
    </Card>
    <Card id="ufficio-tecnico-pratiche" title="Ufficio Tecnico / Pratiche">
      <p className="mb-4 rounded-2xl bg-fai-orange/10 p-3 text-xs font-bold text-fai-orange">Gli aggiornamenti al cliente vanno verificati prima dell’invio. Nessuna comunicazione automatica viene inviata dal CRM.</p>
      {technicalPractices.length === 0 ? <EmptyState title="Nessuna pratica tecnica collegata" /> : <Table headers={['Pratica','Stato interno','Prossimo aggiornamento cliente','Commerciale referente','Stato cliente','Azione']} rows={technicalPractices.map((practice) => [
        <span key="title" className="font-semibold text-fai-navy">{practice.title}<br/><span className="text-xs font-normal text-slate-500">{practice.practiceType} · {practice.targetEntity}</span></span>,
        <StatusBadge key="status" status={practice.status} />,
        formatDateTime(practice.nextClientUpdateAt),
        userOf(practice.commercialOwnerId),
        practice.clientVisibleStatus ?? 'Da verificare',
        <Link key="open" className="font-bold text-fai-blue underline" href={`/technical-office/practices/${practice.id}`}>Apri</Link>
      ])} />}
    </Card>


    <Card id="comunicazioni-pratica" title="Comunicazioni pratica">
      <p className="mb-4 rounded-2xl bg-fai-blue/5 p-3 text-xs font-bold text-fai-blue">Comunicazioni e note collegate alle pratiche tecniche del cliente. Nessun documento privato o percorso storage è esposto; l’invio resta manuale.</p>
      <div className="mb-4 grid gap-3 md:grid-cols-2">
        <div className="rounded-2xl bg-slate-50 p-4 text-sm"><b>Ultimo aggiornamento cliente:</b> {formatDateTime(technicalPractices.map((p) => p.lastClientUpdateAt).filter(Boolean).sort((a, b) => Number(b) - Number(a))[0])}</div>
        <div className="rounded-2xl bg-slate-50 p-4 text-sm"><b>Prossima comunicazione prevista:</b> {formatDateTime(technicalPractices.map((p) => p.nextClientUpdateAt).filter(Boolean).sort((a, b) => Number(a) - Number(b))[0])}</div>
      </div>
      {practiceCommunications.length === 0 ? <EmptyState title="Nessuna comunicazione pratica collegata" /> : <Table headers={['Pratica','Tipo','Stato','Titolo / contenuto','Date']} rows={practiceCommunications.map((c) => { const practice = technicalPractices.find((p) => p.id === c.technicalPracticeId); return [
        practice ? <Link key="p" className="font-bold text-fai-blue underline" href={`/technical-office/practices/${practice.id}`}>{practice.title}</Link> : 'Pratica tecnica',
        `${c.type} · ${c.channel}`, <StatusBadge key="s" status={c.status}/>, <span key="content" className="line-clamp-3 text-sm"><b>{c.title}</b><br/>{c.content}</span>,
        <span key="dates">Rev: {formatDateTime(c.reviewedAt)}<br/>Uso: {formatDateTime(c.usedAt)}</span>
      ]; })} />}
    </Card>
    <Card id="output-ai" title="Agenti AI / Output interni">
      {canRunAiAgents ? <form action={runClientAiAgentAndRedirect} className="mb-5 grid gap-3 rounded-2xl bg-fai-blue/5 p-4 ring-1 ring-fai-blue/10 md:grid-cols-2">
        <input type="hidden" name="clientId" value={client.id}/>
        <select className="rounded-xl border p-2 text-sm" name="agentId" required><option value="">Seleziona agente ufficiale/specialistico attivo</option>{sortAiAgentsByCategory(activeAgents.filter((agent) => isPrimaryOperationalAiAgent(agent.code))).map((agent) => <option key={agent.id} value={agent.id}>{agent.name} · {getAiAgentCategory(agent.code)}</option>)}</select>
        <select className="rounded-xl border p-2 text-sm" name="clientServiceId" defaultValue=""><option value="">Fascicolo cliente generale</option>{clientServices.map((service) => <option key={service.id} value={service.id}>{nameOf(service.serviceCatalogId)}</option>)}</select>
        <select className="rounded-xl border p-2 text-sm" name="projectId" defaultValue=""><option value="">Nessun progetto specifico</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.title}</option>)}</select>
        <textarea className="rounded-xl border p-2 text-sm md:col-span-2" name="operationalInstructions" rows={3} placeholder="Istruzioni operative opzionali per questa esecuzione" />
        <div className="md:col-span-2"><PrimaryButton type="submit" disabled={activeAgents.length === 0}>Esegui agente mock</PrimaryButton></div>
      </form> : <EmptyState title="Esecuzione agenti non autorizzata">Serve il permesso ai.run per lanciare agenti dal fascicolo.</EmptyState>}
      {aiOutputs.length === 0 ? <EmptyState title="Nessun output AI" /> : <Table headers={['Agente / Titolo','Stato','Sintesi mock','Contesto','Generato il','Dettaglio']} rows={aiOutputs.map((o) => { const run = runById.get(o.aiRunId); const agent = run ? agentById.get(run.agentId) : null; const service = o.clientServiceId ? serviceById.get(o.clientServiceId) : null; const project = o.projectId ? projectById.get(o.projectId) : null; const linkedDossierId = dossierByOutputId.get(o.id); return [<span key="title" className="font-semibold text-fai-navy">{agent?.name ?? 'Agente AI'}<br/><span className="text-xs font-normal text-slate-500">{o.title}</span></span>, <StatusBadge status={o.status} key='s' />, <span key="content" className="line-clamp-3 text-sm">{o.content}</span>, <span key="ctx">{client.displayName}<br/><span className="text-xs text-slate-500">{labelOf(service)}{project ? ` · ${project.title}` : ''}</span></span>, formatDateTime(o.createdAt), <span className="grid gap-1" key="open"><Link className="font-bold text-fai-blue underline" href={`/ai/outputs/${o.id}`}>Apri</Link>{linkedDossierId ? <Link className="text-xs font-bold text-fai-green underline" href={`/client-dossiers/${linkedDossierId}`}>Bozza dossier creata</Link> : null}</span>]; })} />}
    </Card>
    <Card id="timeline-operativa" title="Timeline operativa" action={<div className="flex flex-wrap gap-2">{timelineFilters.map(([value, label]) => <Link key={value} className={`rounded-full px-3 py-1 text-xs font-black ring-1 ${activeTimelineFilter === value ? 'bg-fai-blue text-white ring-fai-blue' : 'bg-white text-fai-blue ring-fai-blue/15'}`} href={`/clients/${client.id}?timelineFilter=${value}#timeline-operativa`}>{label}</Link>)}</div>}>
      <p className="mb-4 rounded-2xl bg-fai-blue/5 p-3 text-xs font-bold text-fai-blue">Aggrega eventi già presenti nel CRM: stati pratica, comunicazioni, documenti, task/scadenze e audit log visibili al ruolo corrente.</p>
      <ActivityTimeline events={timeline} />
    </Card>
    <Card id="audit-log" title="Audit log / Timeline fascicolo"><ActivityTimeline events={auditLogs.map((a) => ({ id: `audit-only-${a.id}`, date: a.createdAt, user: userOf(a.actorId), type: auditLabel(a.event), entity: a.entityType, description: auditLabel(a.event), beforeAfter: a.before || a.after ? 'Dettaglio disponibile nel registro audit.' : null }))} /></Card>
  </div>;
}
