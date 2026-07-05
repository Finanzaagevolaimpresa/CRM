import Link from 'next/link';
import { PrimaryButton, SecondaryLink } from '@/components/actions';
import { PracticeCommunicationTemplates } from '@/components/practice-communication-templates';
import { ActivityTimeline, Card, EmptyState, PageHeader, StatusBadge, Table, TimestampMeta, formatDateTime } from '@/components/ui';
import { hasPermission, requirePermission } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { canViewTechnicalPractice } from '@/lib/access-control';
import { archivePracticeCommunicationAndRefresh, archiveTechnicalPracticeAndRefresh, approvePracticeCommunicationDraftAndRefresh, assignTechnicalPracticeAndRefresh, createPracticeCommunicationDraftAndRefresh, markPracticeCommunicationAsUsedAndRefresh, updateTechnicalPracticeAndRefresh, updateTechnicalPracticeStatusAndRefresh } from '@/lib/form-actions';
import { practiceCommunicationTemplates } from '@/lib/practice-communication-templates';

export const dynamic = 'force-dynamic';
const statuses = ['da_progettare','in_progettazione','documenti_richiesti','documenti_completi','pronta_presentazione','presentata','integrazione_richiesta','in_istruttoria','approvata','respinta','archiviata'];
const priorities = ['bassa','media','alta','urgente'];
const auditEventLabels: Record<string, string> = {
  technical_practice_update: 'Aggiornamento pratica tecnica',
  technical_practice_status_change: 'Cambio stato pratica tecnica',
  practice_communication_draft_create: 'Bozza comunicazione creata',
  practice_communication_approve: 'Comunicazione approvata',
  practice_communication_used: 'Comunicazione usata/inviata',
};
const auditLabel = (event: string) => auditEventLabels[event] ?? event.replaceAll('_', ' ');
const isRedundantOperationalAudit = (event: { category: string; type: string; entity?: string | null; dedupeKey?: string | null; date: Date | string }, events: Array<{ category: string; type: string; entity?: string | null; dedupeKey?: string | null; date: Date | string }>) => event.category === 'audit' && events.some((candidate) => candidate.category !== 'audit' && candidate.dedupeKey && candidate.dedupeKey === event.dedupeKey && Math.abs(+new Date(candidate.date) - +new Date(event.date)) <= 120000 && ((event.type === 'Cambio stato pratica tecnica' && candidate.type === 'stato pratica tecnica') || (event.type === 'Aggiornamento pratica tecnica' && ['stato pratica tecnica', 'aggiornamento pratica tecnica'].includes(candidate.type))));


export default async function Page({ params, searchParams }: { params: Promise<{ id: string }>; searchParams?: Promise<{ timelineFilter?: string }> }) {
  const session = await requirePermission('technical.read');
  const { id } = await params;
  const query = await searchParams;
  const practice = await prisma.technicalPractice.findUnique({ where: { id } });
  if (!practice) return <h1 className="text-3xl font-bold text-fai-navy">Pratica non trovata</h1>;
  const [client, project, service, users, documents, tasks, checklist, communications, audits] = await Promise.all([
    prisma.client.findUnique({ where: { id: practice.clientId } }),
    practice.projectId ? prisma.project.findUnique({ where: { id: practice.projectId } }) : null,
    practice.clientServiceId ? prisma.clientService.findUnique({ where: { id: practice.clientServiceId } }) : null,
    prisma.user.findMany({ where: { active: true }, orderBy: { name: 'asc' } }),
    prisma.document.findMany({ where: { deletedAt: null, OR: [{ clientId: practice.clientId }, ...(practice.projectId ? [{ projectId: practice.projectId }] : []), ...(practice.clientServiceId ? [{ clientServiceId: practice.clientServiceId }] : [])] }, orderBy: { createdAt: 'desc' } }),
    prisma.task.findMany({ where: { deletedAt: null, OR: [{ clientId: practice.clientId }, ...(practice.projectId ? [{ projectId: practice.projectId }] : []), ...(practice.clientServiceId ? [{ clientServiceId: practice.clientServiceId }] : [])] }, orderBy: { dueAt: 'asc' } }),
    prisma.documentChecklistItem.findMany({ where: { active: true, deletedAt: null, OR: [{ clientId: practice.clientId }, ...(practice.projectId ? [{ projectId: practice.projectId }] : []), ...(practice.clientServiceId ? [{ clientServiceId: practice.clientServiceId }] : [])] }, orderBy: { updatedAt: 'desc' } }),
    prisma.practiceCommunication.findMany({ where: { technicalPracticeId: practice.id, deletedAt: null }, orderBy: { updatedAt: 'desc' } }),
    prisma.auditLog.findMany({ where: hasPermission(session, 'audit.read') ? { OR: [{ entityType: 'TechnicalPractice', entityId: practice.id }] } : { id: '__no_audit_permission__' }, orderBy: { createdAt: 'desc' }, take: 30 }),
  ]);
  if (!client || !canViewTechnicalPractice(session, { ...practice, client })) return <h1 className="text-3xl font-bold text-fai-navy">Pratica non accessibile</h1>;
  const userOf = (userId?: string | null) => users.find((u) => u.id === userId)?.name ?? '—';
  const canWrite = hasPermission(session, 'technical.write');
  const canStatus = hasPermission(session, 'technical.status');
  const canAssign = hasPermission(session, 'technical.assign');
  const canCommRead = hasPermission(session, 'practice_communications.read');
  const canCommWrite = hasPermission(session, 'practice_communications.write');
  const canCommReview = hasPermission(session, 'practice_communications.review');
  const canCommUsed = hasPermission(session, 'practice_communications.mark_used');
  const missingDocs = checklist.filter((item) => ['da_richiedere','richiesto'].includes(item.status));
  const nextTask = tasks.find((task) => task.status !== 'completata' && task.status !== 'annullata');
  const timelineFilters = [['tutti', 'Tutti'], ['stato', 'Stato pratica'], ['comunicazioni', 'Comunicazioni'], ['documenti', 'Documenti'], ['task', 'Task'], ['audit', 'Audit']] as const;
  const activeTimelineFilter = timelineFilters.some(([value]) => value === query?.timelineFilter) ? query?.timelineFilter : 'tutti';
  const allTimelineEvents = [
    { id: `practice-created-${practice.id}`, date: practice.createdAt, user: userOf(practice.createdById), type: 'pratica tecnica creata', entity: 'Pratica tecnica', dedupeKey: practice.id, category: 'stato', description: `${practice.title} creata`, beforeAfter: practice.practiceType },
    { id: `practice-status-${practice.id}`, date: practice.updatedAt, user: userOf(practice.technicalOwnerId ?? practice.commercialOwnerId), type: 'stato pratica tecnica', entity: 'Pratica tecnica', dedupeKey: practice.id, category: 'stato', description: `${practice.title} · ${practice.status.replaceAll('_', ' ')}`, beforeAfter: practice.clientVisibleStatus ?? practice.integrationRequestNote },
    ...communications.flatMap((c) => [
      { id: `communication-created-${c.id}`, date: c.createdAt, user: userOf(c.createdById), type: 'comunicazione creata', entity: 'Comunicazione pratica', dedupeKey: c.id, category: 'comunicazioni', description: `${c.title} · ${c.type}/${c.channel}`, beforeAfter: c.internalNote ?? c.content.slice(0, 180) },
      ...(c.reviewedAt ? [{ id: `communication-reviewed-${c.id}`, date: c.reviewedAt, user: userOf(c.reviewedById), type: 'comunicazione approvata', entity: 'Comunicazione pratica', dedupeKey: c.id, category: 'comunicazioni', description: `${c.title} approvata`, beforeAfter: c.internalNote ?? null }] : []),
      ...(c.usedAt ? [{ id: `communication-used-${c.id}`, date: c.usedAt, user: userOf(c.reviewedById), type: 'comunicazione usata/inviata', entity: 'Comunicazione pratica', dedupeKey: c.id, category: 'comunicazioni', description: `${c.title} segnata come usata/inviata`, beforeAfter: 'Invio manuale tracciato: nessun automatismo CRM.' }] : []),
    ]),
    ...documents.flatMap((d) => [
      { id: `document-created-${d.id}`, date: d.createdAt, user: userOf(d.uploadedById), type: 'documento caricato', entity: 'Documento', category: 'documenti', description: `${d.title} · ${d.documentCategory}`, beforeAfter: d.status.replaceAll('_', ' ') },
      ...(d.updatedAt.getTime() !== d.createdAt.getTime() ? [{ id: `document-updated-${d.id}`, date: d.updatedAt, user: userOf(d.uploadedById), type: 'documento aggiornato', entity: 'Documento', category: 'documenti', description: `${d.title} aggiornato`, beforeAfter: `Stato ${d.status.replaceAll('_', ' ')}` }] : []),
    ]),
    ...tasks.map((t) => ({ id: `task-${t.id}`, date: t.updatedAt ?? t.createdAt, user: userOf(t.assignedToId ?? t.createdById), type: 'task/scadenza', entity: 'Task', category: 'task', description: `${t.title} · ${t.status.replaceAll('_', ' ')}`, beforeAfter: [t.description, t.dueAt ? `Scadenza ${formatDateTime(t.dueAt)}` : null].filter(Boolean).join(' · ') || null })),
    ...audits.map((a) => ({ id: `audit-${a.id}`, date: a.createdAt, user: userOf(a.actorId), type: auditLabel(a.event), entity: a.entityType ?? 'AuditLog', dedupeKey: a.entityId, category: 'audit', description: auditLabel(a.event), beforeAfter: a.before || a.after ? 'Dettaglio disponibile nel registro audit.' : null })),
  ].sort((a, b) => +new Date(b.date) - +new Date(a.date));
  const timeline = allTimelineEvents.filter((event) => activeTimelineFilter === 'tutti' ? !isRedundantOperationalAudit(event, allTimelineEvents) : event.category === activeTimelineFilter).slice(0, 60);

  return <div className="space-y-6"><PageHeader title={practice.title} description="Dettaglio pratica tecnica interna. Gli aggiornamenti al cliente vanno verificati prima dell’invio: il CRM non invia email, PEC o WhatsApp automatici." />
    <div className="flex flex-wrap gap-2"><SecondaryLink href="/technical-office/practices">← Pratiche</SecondaryLink><SecondaryLink href={`/clients/${client.id}#ufficio-tecnico-pratiche`}>Fascicolo cliente</SecondaryLink><StatusBadge status={practice.status}/><StatusBadge status={practice.priority}/></div>
    <div className="grid gap-5 lg:grid-cols-[1.2fr_.8fr]"><Card title="Dati pratica"><div className="grid gap-3 text-sm md:grid-cols-2"><p><b>Cliente:</b> {client.displayName}</p><p><b>Progetto:</b> {project?.title ?? '—'}</p><p><b>Servizio:</b> {service?.practiceType ?? service?.serviceCatalogId ?? '—'}</p><p><b>Commerciale referente:</b> {userOf(practice.commercialOwnerId)}</p><p><b>Responsabile tecnico:</b> {userOf(practice.technicalOwnerId)}</p><p><b>Ente/portale:</b> {practice.targetEntity}{practice.targetPortal ? ` · ${practice.targetPortal}` : ''}</p><p><b>Protocollo:</b> {practice.protocolNumber ?? '—'}</p><p><b>Presentata il:</b> {formatDateTime(practice.submittedAt)}</p><p><b>Scadenza:</b> {formatDateTime(practice.dueDate)}</p><p><b>Prossimo update cliente:</b> {formatDateTime(practice.nextClientUpdateAt)}</p></div><TimestampMeta createdAt={practice.createdAt} updatedAt={practice.updatedAt} createdBy={userOf(practice.createdById)} updatedBy={userOf(practice.technicalOwnerId)} /></Card>
    <Card title="Visibilità commerciale / cliente"><p className="text-sm leading-6 text-slate-600"><b>Stato interno sintetico:</b> {practice.status.replaceAll('_',' ')}</p><p className="mt-2 text-sm leading-6 text-slate-600"><b>Stato comunicabile al cliente:</b> {practice.clientVisibleStatus ?? 'Da preparare e verificare prima dell’invio.'}</p><p className="mt-2 text-sm leading-6 text-slate-600"><b>Documenti mancanti:</b> {missingDocs.length || 'nessuno'}</p><p className="mt-2 text-sm leading-6 text-slate-600"><b>Prossima azione:</b> {nextTask?.title ?? practice.integrationRequestNote ?? 'Da pianificare'}</p><p className="mt-4 rounded-2xl bg-fai-orange/10 p-3 text-xs font-bold text-fai-orange">Disclaimer: ogni aggiornamento al cliente deve essere verificato manualmente prima dell’invio.</p></Card></div>
    {canStatus ? <Card title="Aggiorna stato"><form action={updateTechnicalPracticeStatusAndRefresh} className="grid gap-3 md:grid-cols-3"><input type="hidden" name="id" value={practice.id}/><select name="status" defaultValue={practice.status} className="rounded-xl border p-2">{statuses.map(s=><option key={s} value={s}>{s.replaceAll('_',' ')}</option>)}</select><input type="date" name="submittedAt" defaultValue={practice.submittedAt?.toISOString().slice(0,10) ?? ''} className="rounded-xl border p-2"/><input name="protocolNumber" defaultValue={practice.protocolNumber ?? ''} placeholder="Protocollo" className="rounded-xl border p-2"/><textarea name="clientVisibleStatus" defaultValue={practice.clientVisibleStatus ?? ''} placeholder="Stato comunicabile al cliente" className="rounded-xl border p-2 md:col-span-3"/><textarea name="integrationRequestNote" defaultValue={practice.integrationRequestNote ?? ''} placeholder="Note integrazione/prossima azione" className="rounded-xl border p-2 md:col-span-3"/><input type="date" name="nextClientUpdateAt" defaultValue={practice.nextClientUpdateAt?.toISOString().slice(0,10) ?? ''} className="rounded-xl border p-2"/><input type="date" name="lastClientUpdateAt" defaultValue={practice.lastClientUpdateAt?.toISOString().slice(0,10) ?? ''} className="rounded-xl border p-2"/><PrimaryButton type="submit">Salva stato</PrimaryButton></form></Card> : null}
    {canAssign ? <Card title="Assegna referenti"><form action={assignTechnicalPracticeAndRefresh} className="flex flex-wrap gap-3"><input type="hidden" name="id" value={practice.id}/><select name="commercialOwnerId" defaultValue={practice.commercialOwnerId ?? ''} className="rounded-xl border p-2"><option value="">Commerciale</option>{users.map(u=><option key={u.id} value={u.id}>{u.name}</option>)}</select><select name="technicalOwnerId" defaultValue={practice.technicalOwnerId ?? ''} className="rounded-xl border p-2"><option value="">Tecnico</option>{users.map(u=><option key={u.id} value={u.id}>{u.name}</option>)}</select><PrimaryButton type="submit">Assegna</PrimaryButton></form></Card> : null}
    {canWrite ? <Card title="Modifica dati tecnici"><form action={updateTechnicalPracticeAndRefresh} className="grid gap-3 md:grid-cols-3"><input type="hidden" name="id" value={practice.id}/><input type="hidden" name="clientId" value={practice.clientId}/><input name="title" defaultValue={practice.title} className="rounded-xl border p-2 md:col-span-2"/><input name="practiceType" defaultValue={practice.practiceType} className="rounded-xl border p-2"/><input name="targetEntity" defaultValue={practice.targetEntity} className="rounded-xl border p-2"/><input name="targetPortal" defaultValue={practice.targetPortal ?? ''} className="rounded-xl border p-2"/><select name="priority" defaultValue={practice.priority} className="rounded-xl border p-2">{priorities.map(p=><option key={p} value={p}>{p}</option>)}</select><input type="date" name="dueDate" defaultValue={practice.dueDate?.toISOString().slice(0,10) ?? ''} className="rounded-xl border p-2"/><textarea name="internalNotes" defaultValue={practice.internalNotes ?? ''} className="rounded-xl border p-2 md:col-span-3"/><PrimaryButton type="submit">Salva dati</PrimaryButton></form><form action={archiveTechnicalPracticeAndRefresh} className="mt-4"><input type="hidden" name="id" value={practice.id}/><button className="rounded-xl border border-red-200 px-4 py-2 text-sm font-bold text-red-600" type="submit">Archivia pratica</button></form></Card> : null}

    <Card title="Aggiornamenti cliente / commerciale">
      <p className="mb-4 rounded-2xl bg-fai-orange/10 p-3 text-xs font-bold text-fai-orange">Nessun invio automatico: prepara bozze modificabili, fai revisionare e segna come usata/inviata solo dopo comunicazione manuale. Non promettere contributi, finanziamenti o approvazioni.</p>
      {canCommWrite ? <div className="mb-5 grid gap-4 lg:grid-cols-2">
        <form action={createPracticeCommunicationDraftAndRefresh} className="grid gap-3 rounded-2xl bg-slate-50 p-4 ring-1 ring-slate-200">
          <input type="hidden" name="technicalPracticeId" value={practice.id}/><input type="hidden" name="type" value="cliente"/>
          <select name="channel" defaultValue="email" className="rounded-xl border p-2"><option value="email">Email</option><option value="whatsapp">WhatsApp</option><option value="telefono">Telefono</option><option value="pec">PEC</option></select>
          <select name="title" className="rounded-xl border p-2">{practiceCommunicationTemplates.filter((template) => template.category === 'cliente').map((template) => <option key={template.id} value={template.suggestedTitle}>{template.name}</option>)}</select>
          <textarea name="content" rows={5} className="rounded-xl border p-2" defaultValue={practiceCommunicationTemplates[0]?.suggestedText ?? ''} />
          <select name="status" defaultValue="da_revisionare" className="rounded-xl border p-2"><option value="bozza">Bozza</option><option value="da_revisionare">Da revisionare</option></select><PrimaryButton type="submit">Crea bozza cliente</PrimaryButton>
        </form>
        <form action={createPracticeCommunicationDraftAndRefresh} className="grid gap-3 rounded-2xl bg-slate-50 p-4 ring-1 ring-slate-200">
          <input type="hidden" name="technicalPracticeId" value={practice.id}/><input type="hidden" name="type" value="commerciale"/><input type="hidden" name="channel" value="nota_interna"/>
          <input name="title" className="rounded-xl border p-2" defaultValue={practiceCommunicationTemplates.find((template) => template.category === 'commerciale')?.suggestedTitle ?? 'Aggiornamento commerciale interno'}/><textarea name="content" rows={5} className="rounded-xl border p-2" defaultValue={practiceCommunicationTemplates.find((template) => template.category === 'commerciale')?.suggestedText ?? ''} /><textarea name="internalNote" rows={2} className="rounded-xl border p-2" placeholder="Nota interna opzionale"/>
          <select name="status" defaultValue="da_revisionare" className="rounded-xl border p-2"><option value="bozza">Bozza</option><option value="da_revisionare">Da revisionare</option></select><PrimaryButton type="submit">Crea nota per commerciale</PrimaryButton>
        </form>
      </div> : <EmptyState title="Comunicazioni in sola lettura" />}
      {communications.length === 0 ? <EmptyState title="Nessuna comunicazione pratica" /> : <Table headers={['Titolo','Tipo/canale','Stato','Contenuto','Revisionata/usata','Azioni']} rows={communications.map((c) => [
        <span key="title" className="font-semibold text-fai-navy">{c.title}<br/><span className="text-xs font-normal text-slate-500">Creata da {userOf(c.createdById)}</span></span>,
        `${c.type} · ${c.channel}`, <StatusBadge key="s" status={c.status}/>, <span key="content" className="line-clamp-4 whitespace-pre-wrap text-sm">{c.content}</span>,
        <span key="dates">{formatDateTime(c.reviewedAt)}<br/><span className="text-xs text-slate-500">Uso: {formatDateTime(c.usedAt)}</span></span>,
        <div key="actions" className="grid gap-2">{canCommReview && c.status !== 'approvata' && c.status !== 'usata_inviata' ? <form action={approvePracticeCommunicationDraftAndRefresh}><input type="hidden" name="id" value={c.id}/><PrimaryButton type="submit">Approva</PrimaryButton></form> : null}{canCommUsed && c.status === 'approvata' ? <form action={markPracticeCommunicationAsUsedAndRefresh}><input type="hidden" name="id" value={c.id}/><PrimaryButton type="submit">Segna usata/inviata</PrimaryButton></form> : null}{canCommWrite && c.status !== 'archiviata' ? <form action={archivePracticeCommunicationAndRefresh}><input type="hidden" name="id" value={c.id}/><button className="rounded-xl border px-3 py-2 text-xs font-bold" type="submit">Archivia</button></form> : null}</div>
      ])} />}
      <p className="mt-4 text-xs text-slate-500">Integrazione AI futura: eventuali bozze assistite resteranno non attive e sempre da revisionare manualmente.</p>
    </Card>
    {canCommRead ? <Card title="Template comunicazioni" id="template-comunicazioni"><PracticeCommunicationTemplates templates={practiceCommunicationTemplates} technicalPracticeId={practice.id} canCreateDraft={canCommWrite} /></Card> : null}

    <Card title="Documenti collegati / fascicolo">{documents.length === 0 ? <EmptyState title="Nessun documento collegato" /> : <Table headers={['Documento','Categoria','Stato','Caricato il','Fascicolo']} rows={documents.map(d => [d.title, d.documentCategory, <StatusBadge key="s" status={d.status}/>, formatDateTime(d.createdAt), <Link key="c" className="font-bold text-fai-blue underline" href={`/clients/${client.id}#documenti`}>Apri fascicolo</Link>])} />}</Card>
    <Card title="Task e scadenze">{tasks.length === 0 ? <EmptyState title="Nessun task collegato" /> : <Table headers={['Task','Stato','Priorità','Scadenza','Assegnatario']} rows={tasks.map(t => [t.title, <StatusBadge key="s" status={t.status}/>, <StatusBadge key="p" status={t.priority}/>, formatDateTime(t.dueAt), userOf(t.assignedToId)])} />}</Card>
    <Card title="Timeline operativa" action={<div className="flex flex-wrap gap-2">{timelineFilters.map(([value, label]) => <Link key={value} className={`rounded-full px-3 py-1 text-xs font-black ring-1 ${activeTimelineFilter === value ? 'bg-fai-blue text-white ring-fai-blue' : 'bg-white text-fai-blue ring-fai-blue/15'}`} href={`/technical-office/practices/${practice.id}?timelineFilter=${value}`}>{label}</Link>)}</div>}><p className="mb-4 rounded-2xl bg-fai-blue/5 p-3 text-xs font-bold text-fai-blue">Aggrega eventi già presenti nel CRM per questa pratica: stati, comunicazioni, documenti, task/scadenze e audit log autorizzati.</p><ActivityTimeline events={timeline} /></Card>
  </div>;
}
