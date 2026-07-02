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
import { canViewClient } from '@/lib/access-control';

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
  ['checklist-documentale', 'Checklist documentale'],
  ['pre-analisi', 'Pre-analisi'],
  ['dossier', 'Dossier'],
  ['contratti', 'Contratti'],
  ['pagamenti', 'Pagamenti'],
  ['task-scadenze', 'Attività e scadenze'],
  ['output-ai', 'Agenti AI / Output interni'],
  ['audit-log', 'Audit log'],
] as const;
const checklistStatuses = ['da_richiedere','richiesto','ricevuto','validato','non_necessario'];
const operationalStatuses = ['nuova','pre_analisi','documenti_richiesti','documenti_ricevuti','in_valutazione','proposta_inviata','domanda_in_preparazione','domanda_presentata','in_istruttoria','approvata_deliberata','respinta_non_procedibile','rendicontazione','chiusa','archiviata'];
const operationalStatusLabel = (status: string) => status.replaceAll('_', ' ');
const moneyLabel = (value?: unknown) => value ? `€ ${Number(value).toLocaleString('it-IT')}` : '—';

export default async function Page({ params, searchParams }: { params: Promise<{ id: string }>; searchParams?: Promise<{ uploadError?: string }> }) {
  const { id } = await params;
  const query = await searchParams;
  const session = await requirePermission('client.read');
  const [client, companies, projects, clientServices, documents, contracts, payments, tasks, preAnalyses, dossiers, clientDossiers, bankability, financing, checklistItems, activeAgents] = await Promise.all([
    prisma.client.findUnique({ where: { id } }),
    prisma.company.findMany({ where: { clientId: id, deletedAt: null } }),
    prisma.project.findMany({ where: { clientId: id, deletedAt: null }, orderBy: { updatedAt: 'desc' } }),
    prisma.clientService.findMany({ where: { clientId: id, deletedAt: null }, orderBy: { updatedAt: 'desc' } }),
    prisma.document.findMany({ where: { clientId: id, deletedAt: null }, orderBy: { createdAt: 'desc' } }),
    prisma.contract.findMany({ where: { clientId: id }, orderBy: { updatedAt: 'desc' } }),
    prisma.payment.findMany({ where: { clientId: id }, orderBy: { updatedAt: 'desc' } }),
    prisma.task.findMany({ where: { clientId: id }, orderBy: { updatedAt: 'desc' } }),
    prisma.preAnalysis.findMany({ where: { clientId: id }, orderBy: { updatedAt: 'desc' } }),
    prisma.dossier.findMany({ where: { clientId: id }, orderBy: { updatedAt: 'desc' } }),
    prisma.clientDossier.findMany({ where: { clientId: id }, orderBy: { updatedAt: 'desc' } }),
    prisma.bankabilityAssessment.findMany({ where: { clientId: id }, orderBy: { updatedAt: 'desc' } }),
    prisma.corporateFinancingAssessment.findMany({ where: { clientId: id }, orderBy: { updatedAt: 'desc' } }),
    prisma.documentChecklistItem.findMany({ where: { clientId: id, deletedAt: null, active: true }, orderBy: [{ clientServiceId: 'asc' }, { createdAt: 'asc' }] }),
    prisma.aiAgent.findMany({ where: { active: true }, orderBy: { name: 'asc' } }),
  ]);
  if (!client || !canViewClient(session, client)) return <h1 className="text-3xl font-bold text-fai-navy">Cliente non trovato o non accessibile</h1>;

  const serviceIds = clientServices.map((service) => service.id);
  const [aiOutputs, auditLogs, catalog, users] = await Promise.all([
    prisma.aiOutput.findMany({ where: { OR: [{ clientId: id }, ...(serviceIds.length > 0 ? [{ clientServiceId: { in: serviceIds } }] : [])] }, orderBy: { createdAt: 'desc' }, take: 15 }),
    prisma.auditLog.findMany({ where: { OR: [{ entityId: id }, { entityId: { in: serviceIds } }] }, orderBy: { createdAt: 'desc' }, take: 50 }),
    prisma.serviceCatalog.findMany({ where: { id: { in: clientServices.map((s) => s.serviceCatalogId) } } }),
    prisma.user.findMany({ where: { active: true } }),
  ]);
  const canManageChecklist = hasPermission(session, 'service.write');
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
  const documentById = new Map(documents.map((document) => [document.id, document]));
  const serviceById = new Map(clientServices.map((service) => [service.id, service]));
  const projectById = new Map(projects.map((project) => [project.id, project]));
  const nameOf = (serviceId: string) => catalog.find((s) => s.id === serviceId)?.name ?? 'Servizio FAI';
  const labelOf = (service: { serviceCatalogId: string; practiceType?: string | null; operationalStatus?: string | null; requestedAmount?: unknown; plannedInvestment?: unknown } | null | undefined) => service ? buildClientServiceLabel(service, catalog.find((item) => item.id === service.serviceCatalogId) ?? null) : 'Fascicolo cliente';
  const userOf = (userId?: string | null) => users.find((u) => u.id === userId)?.name ?? (userId ? 'Utente non attivo' : 'Sistema');
  const documentAvailability = new Map(await Promise.all(documents.map(async (d) => [d.id, await privateDocumentExists(d.storagePath)] as const)));
  const serviceAreas = ['anagrafica','bancabilita','finanziamento_aziendale','bandi_finanza_agevolata','progetto_investimento','contratti','pagamenti','dossier','output_ai','altro'];
  const timeline = [
    { id: `client-created-${client.id}`, date: client.createdAt, user: userOf(client.salesOwnerId), type: 'creazione', entity: 'Cliente', description: `Creato fascicolo cliente ${client.displayName}` },
    { id: `client-updated-${client.id}`, date: client.updatedAt, user: userOf(client.consultantId), type: 'aggiornamento', entity: 'Cliente', description: `Aggiornato fascicolo cliente ${client.displayName}` },
    ...projects.map((p) => ({ id: `project-${p.id}`, date: p.updatedAt, user: userOf(p.consultantId), type: 'progetto', entity: 'Project', description: `${p.title} · stato ${p.status}` })),
    ...clientServices.map((svc) => ({ id: `service-status-${svc.id}`, date: svc.statusUpdatedAt, user: userOf(svc.assignedToId), type: 'stato pratica', entity: 'ClientService', description: `${nameOf(svc.serviceCatalogId)} · ${operationalStatusLabel(svc.operationalStatus)}` })),
    ...auditLogs.map((a) => ({ id: a.id, date: a.createdAt, user: userOf(a.actorId), type: a.event, entity: a.entityType, description: a.event === 'client_service_operational_status_change' ? `Cambio stato pratica/servizio ${a.entityId ?? ''}` : `Evento audit su ${a.entityId ?? 'entità non specificata'}`, beforeAfter: a.before || a.after ? `Before/after registrati nell'audit log` : null })),
  ].sort((a, b) => +new Date(b.date) - +new Date(a.date)).slice(0, 30);

  return <div className="space-y-8">
    <PageHeader title={`Fascicolo Cliente Interno — ${client.displayName}`} description="Scheda operativa interna FAI: servizi acquistati, documenti per sezione, output AI in bozza con revisione umana obbligatoria e audit."/><div className="flex flex-wrap items-center justify-between gap-3"><SecondaryLink href="/clients">← Torna alla lista</SecondaryLink><div className="flex flex-wrap gap-2"><StatusBadge status={client.status} /><span className="rounded-full bg-white px-3 py-1 text-xs font-black uppercase tracking-wide text-fai-navy ring-1 ring-slate-200">Owner: {userOf(client.consultantId)}</span></div></div>
    <nav className="sticky top-20 z-10 flex flex-wrap gap-2 rounded-[1.5rem] border border-white/75 bg-white/88 p-3 shadow-xl shadow-slate-200/60 ring-1 ring-slate-900/5 backdrop-blur-xl">{serviceSections.map(([id, label]) => <a className="rounded-full bg-fai-blue/8 px-3 py-2 text-xs font-black text-fai-blue ring-1 ring-fai-blue/10 transition hover:-translate-y-0.5 hover:bg-fai-blue hover:text-white hover:shadow-lg hover:shadow-fai-blue/15 focus:outline-none focus:ring-2 focus:ring-fai-lime" href={`#${id}`} key={id}>{label}</a>)}</nav>

    <Card id="overview" title="Overview"><div className="grid gap-4 md:grid-cols-4"><div className="rounded-2xl bg-gradient-to-br from-fai-navy to-fai-blue p-5 text-white shadow-lg shadow-fai-blue/20"><p className="text-lg font-black">{client.displayName}</p><p className="mt-2 text-sm text-white/75">Tipo: {client.type}</p><div className="mt-3"><StatusBadge status={client.status} /></div></div>{[[companies.length,'Aziende','from-fai-lime to-fai-green'],[projects.length,'Progetti','from-fai-blue to-fai-purple'],[clientServices.length,'Servizi','from-fai-orange to-fai-lime']].map(([value,label,gradient])=><div key={String(label)} className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200"><p className={`bg-gradient-to-br ${gradient} bg-clip-text text-4xl font-black text-transparent`}>{value}</p><span className="mt-1 block text-xs font-black uppercase tracking-wide text-slate-500">{label}</span></div>)}</div><TimestampMeta createdAt={client.createdAt} updatedAt={client.updatedAt} createdBy={userOf(client.salesOwnerId)} updatedBy={userOf(client.consultantId)} /></Card>
    <Card id="anagrafica-completa" title="Anagrafica completa"><p>Nome visualizzato: {client.displayName}</p><p>Tipo cliente: {client.type}</p><p>Note: {client.notes ?? '—'}</p><TimestampMeta createdAt={client.createdAt} updatedAt={client.updatedAt} /></Card>
    <Card id="azienda-visura-ateco" title="Azienda / Visura / ATECO">{companies.length === 0 ? <EmptyState title="Nessuna azienda collegata" /> : <Table headers={['Azienda','P.IVA','ATECO','Stato','Creato il','Aggiornato il']} rows={companies.map((c) => [c.name, c.vatNumber ?? '—', [c.atecoCode, c.atecoDescription].filter(Boolean).join(' · ') || '—', c.activityStatus ?? '—', formatDateTime(c.createdAt), formatDateTime(c.updatedAt)])} />}</Card>
    <Card id="titolari-soci-amministratori" title="Titolari, soci e amministratori"><EmptyState title="Assetto societario da completare">Collegare soci, titolari effettivi e amministratori dalla visura verificata.</EmptyState></Card>
    <Card id="progetti" title="Progetti">{projects.length === 0 ? <EmptyState title="Nessun progetto" /> : <Table headers={['Titolo','Stato','Creato il','Aggiornato il']} rows={projects.map((p) => [p.title, <StatusBadge status={p.status} key="s" />, formatDateTime(p.createdAt), formatDateTime(p.updatedAt)])} />}</Card>
    <Card id="servizi-acquistati" title="Servizi acquistati"><div className="grid gap-4 md:grid-cols-2">{clientServices.map((s) => <article id={`service-${s.id}`} key={s.id} className="scroll-mt-36 rounded-2xl border border-slate-200/80 bg-gradient-to-br from-white to-slate-50/80 p-5 shadow-sm ring-1 ring-white transition hover:-translate-y-0.5 hover:shadow-lg"><div className="flex items-start justify-between gap-3"><div><h3 className="font-semibold text-fai-navy">{nameOf(s.serviceCatalogId)}</h3><p className="text-sm text-fai-gray">Responsabile: {userOf(s.assignedToId)}</p></div><div className="flex gap-2"><StatusBadge status={s.paymentStatus} /><StatusBadge status={s.status} /></div></div><TimestampMeta createdAt={s.openedAt ?? s.createdAt} updatedAt={s.statusUpdatedAt ?? s.updatedAt} updatedBy={userOf(s.assignedToId)} /><div className="mt-4 grid gap-3 rounded-2xl bg-white/80 p-3 text-sm ring-1 ring-slate-200/70"><div className="flex flex-wrap gap-2"><StatusBadge status={s.operationalStatus} /><span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-bold text-slate-600">Agg. stato: {formatDateTime(s.statusUpdatedAt)}</span></div><p className="text-slate-600">Tipologia: {s.practiceType ?? nameOf(s.serviceCatalogId)} · Importo richiesto: {moneyLabel(s.requestedAmount)} · Investimento previsto: {moneyLabel(s.plannedInvestment)}</p><p className="text-slate-600">Note operative: {s.operationalNotes ?? s.internalNotes ?? '—'}</p></div>{canManageChecklist ? <form action={updateServicePipelineAndRefresh} className="mt-3 grid gap-2 rounded-2xl bg-fai-blue/5 p-3 ring-1 ring-fai-blue/10 md:grid-cols-2"><input type="hidden" name="id" value={s.id}/><select name="operationalStatus" defaultValue={s.operationalStatus} className="rounded-xl border px-3 py-2 text-sm">{operationalStatuses.map(st=><option key={st} value={st}>{operationalStatusLabel(st)}</option>)}</select>{canAssignServices ? <select name="assignedToId" defaultValue={s.assignedToId??''} className="rounded-xl border px-3 py-2 text-sm"><option value="">Da assegnare</option>{users.map(u=><option key={u.id} value={u.id}>{u.name}</option>)}</select> : <p className="rounded-xl border bg-slate-50 px-3 py-2 text-sm text-slate-500">Responsabile: {userOf(s.assignedToId)}</p>}<input className="rounded-xl border p-2 text-sm" name="practiceType" defaultValue={s.practiceType ?? ''} placeholder="Tipologia pratica"/><input className="rounded-xl border p-2 text-sm" name="requestedAmount" defaultValue={s.requestedAmount ? String(s.requestedAmount) : ''} placeholder="Importo richiesto"/><input className="rounded-xl border p-2 text-sm" name="plannedInvestment" defaultValue={s.plannedInvestment ? String(s.plannedInvestment) : ''} placeholder="Investimento previsto"/><textarea className="rounded-xl border p-2 text-sm" name="operationalNotes" defaultValue={s.operationalNotes ?? ''} placeholder="Note operative brevi" rows={2}/><div className="md:col-span-2"><PrimaryButton type="submit">Aggiorna pipeline</PrimaryButton></div></form> : null}<p className="mt-4 rounded-2xl bg-white/80 p-3 text-sm leading-6 text-slate-600 ring-1 ring-slate-200/70">Note interne: {s.internalNotes ?? '—'}</p><div className="mt-3 grid gap-2 md:grid-cols-2"><form action={updateServiceStatusAndRefresh} className="flex gap-2"><input type="hidden" name="id" value={s.id}/><select name="status" defaultValue={s.status} className="min-w-0 flex-1 rounded-xl border px-3 py-2 text-sm">{['richiesto','pagato','raccolta_documenti','in_lavorazione','bozza_ai','revisione_umana','consegnabile','consegnato','sospeso','chiuso','archiviato'].map(st=><option key={st} value={st}>{st}</option>)}</select><PrimaryButton type="submit">Salva</PrimaryButton></form>{canAssignServices ? <form action={assignServiceAndRefresh} className="flex gap-2"><input type="hidden" name="id" value={s.id}/><select name="assignedToId" defaultValue={s.assignedToId??''} className="min-w-0 flex-1 rounded-xl border px-3 py-2 text-sm"><option value="">Da assegnare</option>{users.map(u=><option key={u.id} value={u.id}>{u.name}</option>)}</select><PrimaryButton type="submit">Assegna</PrimaryButton></form> : <p className="rounded-xl bg-slate-50 px-3 py-2 text-sm text-slate-500 ring-1 ring-slate-200">Assegnazione non disponibile per il tuo ruolo.</p>}</div><form action={uploadDocumentAndRefresh} className="mt-4 grid gap-2 rounded-2xl bg-white/80 p-3 ring-1 ring-slate-200 md:grid-cols-2"><input type="hidden" name="clientId" value={client.id}/><input type="hidden" name="companyId" value={s.companyId ?? ''}/><input type="hidden" name="projectId" value={s.projectId ?? ''}/><input type="hidden" name="clientServiceId" value={s.id}/><input className="rounded-xl border p-2 text-sm" type="file" name="file" required/><input className="rounded-xl border p-2 text-sm" name="title" placeholder="Titolo documento" required/><select className="rounded-xl border p-2 text-sm" name="serviceArea" defaultValue="altro">{serviceAreas.map(a=><option key={a} value={a}>{a}</option>)}</select><input className="rounded-xl border p-2 text-sm" name="documentCategory" placeholder="Categoria" defaultValue="altro"/><label className="flex items-center gap-2 text-xs font-bold"><input type="checkbox" name="containsSensitiveData" value="true"/> Sensibile</label><PrimaryButton type="submit">Carica documento</PrimaryButton></form><p className="mt-3 text-xs leading-5 text-slate-500">Checklist documentale gestita nella sezione dedicata del fascicolo.</p></article>)}</div>{clientServices.length === 0 && <EmptyState title="Nessun servizio acquistato" />}</Card>
    <Card id="finanziamento-aziendale" title="Finanziamento aziendale">{financing.length === 0 ? <EmptyState title="Nessuna valutazione finanziamento"/> : <Table headers={['Importo richiesto','Finalità','Prossima azione','Creato il','Aggiornato il']} rows={financing.map((f) => [f.requestedAmount ? `€ ${Number(f.requestedAmount).toLocaleString('it-IT')}` : '—', f.purpose ?? '—', f.nextAction ?? '—', formatDateTime(f.createdAt), formatDateTime(f.updatedAt)])} />}</Card>
    <Card id="bandi-finanza-agevolata" title="Bandi / Finanza agevolata"><EmptyState title="Misure da verificare">Stato misura, apertura, chiusura, fonti ufficiali, condizioni e prossime azioni saranno tracciati qui.</EmptyState></Card>
    <Card id="bancabilita" title="Bancabilità">{bankability.length === 0 ? <EmptyState title="Nessun assessment" /> : <Table headers={['Rischio','Completezza','Revisione','Aggiornato il']} rows={bankability.map((b) => [<StatusBadge status={b.riskLevel} key="r" />, `${b.dataCompleteness}%`, b.humanReviewStatus, formatDateTime(b.updatedAt)])} />}</Card>
    <Card id="documenti" title="Documenti">{query?.uploadError ? <div className="mb-4 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm font-semibold text-red-700">{query.uploadError}</div> : null}<DocumentUploadForm fixedClientId={client.id} clients={[{ id: client.id, clientId: client.id, label: client.displayName }]} companies={companies.map((c) => ({ id: c.id, clientId: c.clientId, label: c.name }))} projects={projects.map((project) => ({ id: project.id, clientId: project.clientId, label: project.title }))} services={clientServices.map((service) => ({ id: service.id, clientId: service.clientId, label: nameOf(service.serviceCatalogId) }))} serviceAreas={serviceAreas} submitLabel="Carica" className="mb-5 grid gap-3 md:grid-cols-4" buttonClassName="" />{documents.length === 0 ? <EmptyState title="Nessun documento" /> : <Table headers={['Documento','Sezione','Categoria','Servizio','Sensibile','Stato file','Tracciabilità','Scadenza','Download']} rows={documents.map((d) => { const ok = documentAvailability.get(d.id); return [<span key="n">{d.title}<br/><span className="text-xs text-slate-500">{d.fileName}{!ok ? ' · metadata demo / file non caricato' : ''}</span></span>, d.serviceArea, d.documentCategory, d.clientServiceId ? nameOf(clientServices.find(s => s.id === d.clientServiceId)?.serviceCatalogId ?? '') : 'Fascicolo generale', d.containsSensitiveData ? 'Sì' : 'No', ok ? 'disponibile' : 'metadata demo / non caricato', <span key="t">Caricato il {formatDateTime(d.createdAt)} da {userOf(d.uploadedById)}<br/>Aggiornato il {formatDateTime(d.updatedAt)}</span>, formatDateTime(d.validUntil), ok ? <SecondaryLink key="d" href={`/documents/${d.id}/download`}>Scarica</SecondaryLink> : <DisabledAction key="d" reason="File fisico assente nello storage privato">File non disponibile</DisabledAction>]; })} />}</Card>

    <Card id="checklist-documentale" title="Checklist documentale">
      <div className="mb-5 grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
        {canManageChecklist ? <form action={createChecklistItemAndRefresh} className="grid gap-3 rounded-2xl bg-slate-50/80 p-4 ring-1 ring-slate-200 md:grid-cols-2">
          <input type="hidden" name="clientId" value={client.id}/>
          <input className="rounded-xl border p-2 text-sm md:col-span-2" name="title" placeholder="Titolo documento richiesto" required />
          <textarea className="rounded-xl border p-2 text-sm md:col-span-2" name="notes" placeholder="Descrizione / note opzionali" rows={2} />
          <select className="rounded-xl border p-2 text-sm" name="clientServiceId" defaultValue=""><option value="">Fascicolo generale cliente</option>{clientServices.map((service) => <option key={service.id} value={service.id}>{nameOf(service.serviceCatalogId)}</option>)}</select>
          <select className="rounded-xl border p-2 text-sm" name="projectId" defaultValue=""><option value="">Nessun progetto</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.title}</option>)}</select>
          <select className="rounded-xl border p-2 text-sm" name="status" defaultValue="da_richiedere">{checklistStatuses.map((status) => <option key={status} value={status}>{status.replaceAll('_', ' ')}</option>)}</select>
          <select className="rounded-xl border p-2 text-sm" name="documentId" defaultValue=""><option value="">Nessun documento collegato</option>{documents.map((document) => <option key={document.id} value={document.id}>{document.title}</option>)}</select>
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
          canManageChecklist ? <div key="actions" className="space-y-2"><form action={linkChecklistItemDocumentAndRefresh} className="flex gap-2"><input type="hidden" name="id" value={item.id}/><select name="documentId" defaultValue={item.documentId ?? ''} className="min-w-0 flex-1 rounded-xl border p-2 text-xs"><option value="" disabled>Seleziona documento</option>{documents.map((document) => <option key={document.id} value={document.id}>{document.title}</option>)}</select><PrimaryButton type="submit">Collega</PrimaryButton></form>{item.documentId ? <form action={unlinkChecklistItemDocumentAndRefresh}><input type="hidden" name="id" value={item.id}/><button className="rounded-xl border border-slate-200 px-3 py-2 text-xs font-bold text-slate-600 hover:bg-slate-50" type="submit">Scollega</button></form> : null}<form action={deactivateChecklistItemAndRefresh}><input type="hidden" name="id" value={item.id}/><button className="rounded-xl border border-red-200 px-3 py-2 text-xs font-bold text-red-600 hover:bg-red-50" type="submit">Disattiva</button></form></div> : '—'
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
    <Card id="audit-log" title="Audit log / Timeline fascicolo"><ActivityTimeline events={timeline} /></Card>
  </div>;
}
