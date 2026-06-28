export const dynamic = 'force-dynamic';

import { ActivityTimeline, Card, EmptyState, PageHeader, StatusBadge, Table, TimestampMeta, formatDateTime } from '@/components/ui';
import { prisma } from '@/lib/prisma';
import { privateDocumentExists } from '@/lib/storage';
import { DisabledAction, PrimaryButton, SecondaryLink } from '@/components/actions';
import { assignServiceAndRefresh, updateServiceStatusAndRefresh, uploadDocumentAndRefresh } from '@/lib/form-actions';

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
  ['pre-analisi', 'Pre-analisi'],
  ['dossier', 'Dossier'],
  ['contratti', 'Contratti'],
  ['pagamenti', 'Pagamenti'],
  ['task-scadenze', 'Task / Scadenze'],
  ['output-ai', 'Output AI'],
  ['audit-log', 'Audit log'],
] as const;
const checklist = ['Documento identità e codice fiscale','Visura camerale / assetto societario','Bilanci o dichiarazioni fiscali','Estratti conto / Centrale Rischi se disponibili','Preventivi e piano investimenti','Contratto o incarico collegato'];

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [client, companies, projects, clientServices, documents, contracts, payments, tasks, preAnalyses, dossiers, bankability, financing] = await Promise.all([
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
    prisma.bankabilityAssessment.findMany({ where: { clientId: id }, orderBy: { updatedAt: 'desc' } }),
    prisma.corporateFinancingAssessment.findMany({ where: { clientId: id }, orderBy: { updatedAt: 'desc' } }),
  ]);
  if (!client) return <h1 className="text-3xl font-bold text-fai-navy">Cliente non trovato</h1>;

  const serviceIds = clientServices.map((service) => service.id);
  const [aiOutputs, auditLogs, catalog, users] = await Promise.all([
    serviceIds.length > 0 ? prisma.aiOutput.findMany({ where: { clientServiceId: { in: serviceIds } }, orderBy: { createdAt: 'desc' } }) : Promise.resolve([]),
    prisma.auditLog.findMany({ where: { OR: [{ entityId: id }, { entityId: { in: serviceIds } }] }, orderBy: { createdAt: 'desc' }, take: 50 }),
    prisma.serviceCatalog.findMany({ where: { id: { in: clientServices.map((s) => s.serviceCatalogId) } } }),
    prisma.user.findMany({ where: { active: true } }),
  ]);
  const nameOf = (serviceId: string) => catalog.find((s) => s.id === serviceId)?.name ?? 'Servizio FAI';
  const userOf = (userId?: string | null) => users.find((u) => u.id === userId)?.name ?? (userId ? 'Utente non attivo' : 'Sistema');
  const documentAvailability = new Map(await Promise.all(documents.map(async (d) => [d.id, await privateDocumentExists(d.storagePath)] as const)));
  const serviceAreas = ['anagrafica','bancabilita','finanziamento_aziendale','bandi_finanza_agevolata','progetto_investimento','contratti','pagamenti','dossier','output_ai','altro'];
  const timeline = [
    { id: `client-created-${client.id}`, date: client.createdAt, user: userOf(client.salesOwnerId), type: 'creazione', entity: 'Cliente', description: `Creato fascicolo cliente ${client.displayName}` },
    { id: `client-updated-${client.id}`, date: client.updatedAt, user: userOf(client.consultantId), type: 'aggiornamento', entity: 'Cliente', description: `Aggiornato fascicolo cliente ${client.displayName}` },
    ...projects.map((p) => ({ id: `project-${p.id}`, date: p.updatedAt, user: userOf(p.consultantId), type: 'progetto', entity: 'Project', description: `${p.title} · stato ${p.status}` })),
    ...auditLogs.map((a) => ({ id: a.id, date: a.createdAt, user: userOf(a.actorId), type: a.event, entity: a.entityType, description: `Evento audit su ${a.entityId ?? 'entità non specificata'}`, beforeAfter: a.before || a.after ? `Before/after registrati nell'audit log` : null })),
  ].sort((a, b) => +new Date(b.date) - +new Date(a.date)).slice(0, 30);

  return <div className="space-y-8">
    <PageHeader title={`Fascicolo Cliente Interno — ${client.displayName}`} description="Scheda operativa interna FAI: servizi acquistati, documenti per sezione, output AI in bozza con revisione umana obbligatoria e audit."/><div className="flex flex-wrap items-center justify-between gap-3"><SecondaryLink href="/clients">← Torna alla lista</SecondaryLink><div className="flex flex-wrap gap-2"><StatusBadge status={client.status} /><span className="rounded-full bg-white px-3 py-1 text-xs font-black uppercase tracking-wide text-fai-navy ring-1 ring-slate-200">Owner: {userOf(client.consultantId)}</span></div></div>
    <nav className="sticky top-20 z-10 flex flex-wrap gap-2 rounded-[1.5rem] border border-white/75 bg-white/88 p-3 shadow-xl shadow-slate-200/60 ring-1 ring-slate-900/5 backdrop-blur-xl">{serviceSections.map(([id, label]) => <a className="rounded-full bg-fai-blue/8 px-3 py-2 text-xs font-black text-fai-blue ring-1 ring-fai-blue/10 transition hover:-translate-y-0.5 hover:bg-fai-blue hover:text-white hover:shadow-lg hover:shadow-fai-blue/15 focus:outline-none focus:ring-2 focus:ring-fai-lime" href={`#${id}`} key={id}>{label}</a>)}</nav>

    <Card id="overview" title="Overview"><div className="grid gap-4 md:grid-cols-4"><div className="rounded-2xl bg-gradient-to-br from-fai-navy to-fai-blue p-5 text-white shadow-lg shadow-fai-blue/20"><p className="text-lg font-black">{client.displayName}</p><p className="mt-2 text-sm text-white/75">Tipo: {client.type}</p><div className="mt-3"><StatusBadge status={client.status} /></div></div>{[[companies.length,'Aziende','from-fai-lime to-fai-green'],[projects.length,'Progetti','from-fai-blue to-fai-purple'],[clientServices.length,'Servizi','from-fai-orange to-fai-lime']].map(([value,label,gradient])=><div key={String(label)} className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200"><p className={`bg-gradient-to-br ${gradient} bg-clip-text text-4xl font-black text-transparent`}>{value}</p><span className="mt-1 block text-xs font-black uppercase tracking-wide text-slate-500">{label}</span></div>)}</div><TimestampMeta createdAt={client.createdAt} updatedAt={client.updatedAt} createdBy={userOf(client.salesOwnerId)} updatedBy={userOf(client.consultantId)} /></Card>
    <Card id="anagrafica-completa" title="Anagrafica completa"><p>Nome visualizzato: {client.displayName}</p><p>Tipo cliente: {client.type}</p><p>Note: {client.notes ?? '—'}</p><TimestampMeta createdAt={client.createdAt} updatedAt={client.updatedAt} /></Card>
    <Card id="azienda-visura-ateco" title="Azienda / Visura / ATECO">{companies.length === 0 ? <EmptyState title="Nessuna azienda collegata" /> : <Table headers={['Azienda','P.IVA','ATECO','Stato','Creato il','Aggiornato il']} rows={companies.map((c) => [c.name, c.vatNumber ?? '—', [c.atecoCode, c.atecoDescription].filter(Boolean).join(' · ') || '—', c.activityStatus ?? '—', formatDateTime(c.createdAt), formatDateTime(c.updatedAt)])} />}</Card>
    <Card id="titolari-soci-amministratori" title="Titolari, soci e amministratori"><EmptyState title="Assetto societario da completare">Collegare soci, titolari effettivi e amministratori dalla visura verificata.</EmptyState></Card>
    <Card id="progetti" title="Progetti">{projects.length === 0 ? <EmptyState title="Nessun progetto" /> : <Table headers={['Titolo','Stato','Creato il','Aggiornato il']} rows={projects.map((p) => [p.title, <StatusBadge status={p.status} key="s" />, formatDateTime(p.createdAt), formatDateTime(p.updatedAt)])} />}</Card>
    <Card id="servizi-acquistati" title="Servizi acquistati"><div className="grid gap-4 md:grid-cols-2">{clientServices.map((s) => <article id={`service-${s.id}`} key={s.id} className="scroll-mt-36 rounded-2xl border border-slate-200/80 bg-gradient-to-br from-white to-slate-50/80 p-5 shadow-sm ring-1 ring-white transition hover:-translate-y-0.5 hover:shadow-lg"><div className="flex items-start justify-between gap-3"><div><h3 className="font-semibold text-fai-navy">{nameOf(s.serviceCatalogId)}</h3><p className="text-sm text-fai-gray">Responsabile: {userOf(s.assignedToId)}</p></div><div className="flex gap-2"><StatusBadge status={s.paymentStatus} /><StatusBadge status={s.status} /></div></div><TimestampMeta createdAt={s.createdAt} updatedAt={s.updatedAt} updatedBy={userOf(s.assignedToId)} /><p className="mt-4 rounded-2xl bg-white/80 p-3 text-sm leading-6 text-slate-600 ring-1 ring-slate-200/70">Note interne: {s.internalNotes ?? '—'}</p><div className="mt-3 grid gap-2 md:grid-cols-2"><form action={updateServiceStatusAndRefresh} className="flex gap-2"><input type="hidden" name="id" value={s.id}/><select name="status" defaultValue={s.status} className="min-w-0 flex-1 rounded-xl border px-3 py-2 text-sm">{['richiesto','pagato','raccolta_documenti','in_lavorazione','bozza_ai','revisione_umana','consegnabile','consegnato','sospeso','chiuso','archiviato'].map(st=><option key={st} value={st}>{st}</option>)}</select><PrimaryButton type="submit">Salva</PrimaryButton></form><form action={assignServiceAndRefresh} className="flex gap-2"><input type="hidden" name="id" value={s.id}/><select name="assignedToId" defaultValue={s.assignedToId??''} className="min-w-0 flex-1 rounded-xl border px-3 py-2 text-sm"><option value="">Da assegnare</option>{users.map(u=><option key={u.id} value={u.id}>{u.name}</option>)}</select><PrimaryButton type="submit">Assegna</PrimaryButton></form></div><form action={uploadDocumentAndRefresh} className="mt-4 grid gap-2 rounded-2xl bg-white/80 p-3 ring-1 ring-slate-200 md:grid-cols-2"><input type="hidden" name="clientId" value={client.id}/><input type="hidden" name="clientServiceId" value={s.id}/><input className="rounded-xl border p-2 text-sm" type="file" name="file" required/><input className="rounded-xl border p-2 text-sm" name="title" placeholder="Titolo documento" required/><select className="rounded-xl border p-2 text-sm" name="serviceArea" defaultValue="altro">{serviceAreas.map(a=><option key={a} value={a}>{a}</option>)}</select><input className="rounded-xl border p-2 text-sm" name="documentCategory" placeholder="Categoria" defaultValue="altro"/><label className="flex items-center gap-2 text-xs font-bold"><input type="checkbox" name="containsSensitiveData" value="true"/> Sensibile</label><PrimaryButton type="submit">Carica documento</PrimaryButton></form><p className="mt-3 text-xs leading-5 text-slate-500">Checklist documentale: {checklist.join(' · ')}</p></article>)}</div>{clientServices.length === 0 && <EmptyState title="Nessun servizio acquistato" />}</Card>
    <Card id="finanziamento-aziendale" title="Finanziamento aziendale">{financing.length === 0 ? <EmptyState title="Nessuna valutazione finanziamento"/> : <Table headers={['Importo richiesto','Finalità','Prossima azione','Creato il','Aggiornato il']} rows={financing.map((f) => [f.requestedAmount ? `€ ${Number(f.requestedAmount).toLocaleString('it-IT')}` : '—', f.purpose ?? '—', f.nextAction ?? '—', formatDateTime(f.createdAt), formatDateTime(f.updatedAt)])} />}</Card>
    <Card id="bandi-finanza-agevolata" title="Bandi / Finanza agevolata"><EmptyState title="Misure da verificare">Stato misura, apertura, chiusura, fonti ufficiali, condizioni e prossime azioni saranno tracciati qui.</EmptyState></Card>
    <Card id="bancabilita" title="Bancabilità">{bankability.length === 0 ? <EmptyState title="Nessun assessment" /> : <Table headers={['Rischio','Completezza','Revisione','Aggiornato il']} rows={bankability.map((b) => [<StatusBadge status={b.riskLevel} key="r" />, `${b.dataCompleteness}%`, b.humanReviewStatus, formatDateTime(b.updatedAt)])} />}</Card>
    <Card id="documenti" title="Documenti"><form action={uploadDocumentAndRefresh} className="mb-5 grid gap-3 md:grid-cols-4"><input type="hidden" name="clientId" value={client.id}/><input className="rounded-xl border p-3" type="file" name="file" required/><input className="rounded-xl border p-3" name="title" placeholder="Titolo" required/><select className="rounded-xl border p-3" name="clientServiceId"><option value="">Fascicolo generale</option>{clientServices.map(s=><option key={s.id} value={s.id}>{nameOf(s.serviceCatalogId)}</option>)}</select><select className="rounded-xl border p-3" name="serviceArea" defaultValue="altro">{serviceAreas.map(a=><option key={a} value={a}>{a}</option>)}</select><input className="rounded-xl border p-3" name="documentCategory" placeholder="Categoria" defaultValue="altro"/><input className="rounded-xl border p-3" name="validUntil" type="date"/><label className="flex items-center gap-2 rounded-xl border p-3 text-sm font-bold"><input type="checkbox" name="containsSensitiveData" value="true"/> Sensibile</label><PrimaryButton type="submit">Carica</PrimaryButton></form>{documents.length === 0 ? <EmptyState title="Nessun documento" /> : <Table headers={['Documento','Sezione','Categoria','Servizio','Sensibile','Tracciabilità','Scadenza','Download']} rows={documents.map((d) => { const ok = documentAvailability.get(d.id); return [<span key="n">{d.title}<br/><span className="text-xs text-slate-500">{d.fileName}{!ok ? ' · metadata demo / file non caricato' : ''}</span></span>, d.serviceArea, d.documentCategory, d.clientServiceId ? nameOf(clientServices.find(s => s.id === d.clientServiceId)?.serviceCatalogId ?? '') : 'Fascicolo generale', d.containsSensitiveData ? 'Sì' : 'No', <span key="t">Caricato il {formatDateTime(d.createdAt)} da {userOf(d.uploadedById)}<br/>Aggiornato il {formatDateTime(d.updatedAt)}</span>, formatDateTime(d.validUntil), ok ? <SecondaryLink key="d" href={`/documents/${d.id}/download`}>Scarica</SecondaryLink> : <DisabledAction key="d" reason="File fisico assente nello storage privato">File non disponibile</DisabledAction>]; })} />}</Card>
    <Card id="pre-analisi" title="Pre-analisi">{preAnalyses.length === 0 ? <EmptyState title="Nessuna pre-analisi" /> : <Table headers={['Stato','Sintesi','Creato il','Aggiornato il']} rows={preAnalyses.map((p) => [<StatusBadge status={p.status} key='s' />, p.internalSummary ?? '—', formatDateTime(p.createdAt), formatDateTime(p.updatedAt)])} />}</Card>
    <Card id="dossier" title="Dossier">{dossiers.length === 0 ? <EmptyState title="Nessun dossier" /> : <Table headers={['Titolo','Tipo','Stato','Creato il','Aggiornato il']} rows={dossiers.map((d) => [d.title, d.type, <StatusBadge status={d.status} key='s' />, formatDateTime(d.createdAt), formatDateTime(d.updatedAt)])} />}</Card>
    <Card id="contratti" title="Contratti">{contracts.length === 0 ? <EmptyState title="Nessun contratto" /> : <Table headers={['Numero','Servizio','Totale','Stato','Creato il','Aggiornato il']} rows={contracts.map((c) => [c.contractNumber, c.serviceName, `€ ${Number(c.totalAmount).toLocaleString('it-IT')}`, <StatusBadge status={c.status} key='s' />, formatDateTime(c.createdAt), formatDateTime(c.updatedAt)])} />}</Card>
    <Card id="pagamenti" title="Pagamenti">{payments.length === 0 ? <EmptyState title="Nessun pagamento" /> : <Table headers={['Totale','Metodo','Scadenza','Stato','Creato il','Aggiornato il']} rows={payments.map((p) => [`€ ${Number(p.totalAmount).toLocaleString('it-IT')}`, p.method ?? '—', formatDateTime(p.dueDate), <StatusBadge status={p.status} key='s' />, formatDateTime(p.createdAt), formatDateTime(p.updatedAt)])} />}</Card>
    <Card id="task-scadenze" title="Task / Scadenze">{tasks.length === 0 ? <EmptyState title="Nessun task" /> : <Table headers={['Task','Priorità','Scadenza','Stato','Creato il','Aggiornato il']} rows={tasks.map((t) => [t.title, t.priority, formatDateTime(t.dueAt), <StatusBadge status={t.status} key='s' />, formatDateTime(t.createdAt), formatDateTime(t.updatedAt)])} />}</Card>
    <Card id="output-ai" title="Output AI">{aiOutputs.length === 0 ? <EmptyState title="Nessun output AI" /> : <Table headers={['Titolo','Stato','Revisione umana','Creato il','Aggiornato il']} rows={aiOutputs.map((o) => [o.title, <StatusBadge status={o.status} key='s' />, o.requiresHumanReview ? 'Obbligatoria' : 'Non richiesta', formatDateTime(o.createdAt), formatDateTime(o.updatedAt)])} />}</Card>
    <Card id="audit-log" title="Audit log / Timeline fascicolo"><ActivityTimeline events={timeline} /></Card>
  </div>;
}
