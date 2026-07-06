import type { AuthSession } from './auth';
import { hasPermission } from './auth';
import { canViewDocument } from './access-control';
import { prisma } from './prisma';

const DISCLAIMER = 'Documento interno di lavoro. Finanza Agevola Impresa S.r.l. non eroga finanziamenti, non promette contributi e non garantisce esiti o erogazioni. Offre consulenza tecnica, strategica e di orientamento.';
const fmt = (value?: Date | string | null) => value ? new Date(value).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' }) : '—';
const clean = (value?: string | null) => value?.replaceAll('_', ' ') || '—';
const line = (label: string, value?: string | number | null) => `- **${label}:** ${value ?? '—'}`;
const list = <T>(items: T[], render: (item: T) => string) => items.length ? items.map(render).join('\n') : '- Nessun dato presente.';
const safeText = (value?: string | null, fallback = '—') => value?.trim() || fallback;

function taskBucket(status: string, dueAt?: Date | null) {
  if (status === 'completata') return 'completati';
  if (dueAt && dueAt < new Date()) return 'scaduti';
  return 'aperti';
}

export function reportFileName(title: string) { return title.toLowerCase().replace(/[^a-z0-9-_]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 90) || 'report-operativo'; }

export async function buildOperationalReportMarkdown(session: AuthSession, input: { clientId?: string; technicalPracticeId?: string }) {
  const practice = input.technicalPracticeId ? await prisma.technicalPractice.findUnique({ where: { id: input.technicalPracticeId } }) : null;
  const clientId = practice?.clientId ?? input.clientId;
  if (!clientId) return null;
  const [client, users] = await Promise.all([prisma.client.findUnique({ where: { id: clientId } }), prisma.user.findMany({ where: { active: true } })]);
  if (!client) return null;
  const userOf = (id?: string | null) => users.find((u) => u.id === id)?.name ?? (id ? 'Utente non attivo' : '—');

  const serviceFilter = practice?.clientServiceId ? [{ clientServiceId: practice.clientServiceId }] : [];
  const projectFilter = practice?.projectId ? [{ projectId: practice.projectId }] : [];
  const practiceLinkedFilters = [...serviceFilter, ...projectFilter];
  const scopeWhere = practice ? { OR: [{ clientId }, ...practiceLinkedFilters] } : { clientId };
  const clientDossierWhere = practice
    ? practiceLinkedFilters.length > 0 ? { clientId, OR: practiceLinkedFilters } : { id: '__no_practice_linked_dossier__' }
    : { clientId };
  const aiOutputWhere = practice
    ? practiceLinkedFilters.length > 0 ? { OR: practiceLinkedFilters } : { id: '__no_practice_linked_ai_output__' }
    : { OR: [{ clientId }] };
  const [services, projects, documents, checklist, tasks, communications, clientDossiers, aiOutputs, audits, catalog] = await Promise.all([
    prisma.clientService.findMany({ where: { clientId, deletedAt: null }, orderBy: { updatedAt: 'desc' } }),
    prisma.project.findMany({ where: { clientId, deletedAt: null }, orderBy: { updatedAt: 'desc' } }),
    prisma.document.findMany({ where: { deletedAt: null, ...scopeWhere }, orderBy: { createdAt: 'desc' } }),
    prisma.documentChecklistItem.findMany({ where: { active: true, deletedAt: null, ...scopeWhere }, orderBy: { updatedAt: 'desc' } }),
    prisma.task.findMany({ where: { deletedAt: null, ...scopeWhere }, orderBy: [{ status: 'asc' }, { dueAt: 'asc' }] }),
    hasPermission(session, 'practice_communications.read') ? prisma.practiceCommunication.findMany({ where: { deletedAt: null, ...(practice ? { technicalPracticeId: practice.id } : { clientId }) }, orderBy: { updatedAt: 'desc' } }) : Promise.resolve([]),
    hasPermission(session, 'dossier.read') ? prisma.clientDossier.findMany({ where: clientDossierWhere, orderBy: { updatedAt: 'desc' }, take: 10 }) : Promise.resolve([]),
    hasPermission(session, 'ai.review') || hasPermission(session, 'ai.approve') ? prisma.aiOutput.findMany({ where: aiOutputWhere, orderBy: { createdAt: 'desc' }, take: 10 }) : Promise.resolve([]),
    hasPermission(session, 'audit.read') ? prisma.auditLog.findMany({ where: practice ? { OR: [{ entityId: practice.id }, { entityId: clientId }] } : { entityId: clientId }, orderBy: { createdAt: 'desc' }, take: 20 }) : Promise.resolve([]),
    prisma.serviceCatalog.findMany(),
  ]);
  const serviceById = new Map(services.map((s) => [s.id, s]));
  const projectById = new Map(projects.map((p) => [p.id, p]));
  const visibleDocuments = hasPermission(session, 'document.download') ? documents.filter((document) => canViewDocument(session, { ...document, client, project: document.projectId ? { ...projectById.get(document.projectId)!, client } : null, clientService: document.clientServiceId ? serviceById.get(document.clientServiceId) : null }, hasPermission(session, 'document.sensitive.read'))) : [];
  const serviceName = (id?: string | null) => catalog.find((c) => c.id === serviceById.get(id ?? '')?.serviceCatalogId)?.name ?? 'Fascicolo generale';
  const missing = checklist.filter((i) => !i.documentId && !['ricevuto','validato','non_necessario'].includes(i.status));
  const timeline = [
    ...(practice ? [{ date: practice.createdAt, text: `Pratica tecnica creata: ${practice.title}` }, { date: practice.updatedAt, text: `Stato pratica tecnica: ${clean(practice.status)}` }] : []),
    ...visibleDocuments.map((d) => ({ date: d.createdAt, text: `Documento caricato: ${d.title} (${clean(d.status)})` })),
    ...tasks.map((t) => ({ date: t.updatedAt, text: `Task: ${t.title} (${clean(t.status)})` })),
    ...communications.map((c) => ({ date: c.updatedAt, text: `Comunicazione: ${c.title} (${clean(c.status)})` })),
  ].sort((a, b) => +new Date(b.date) - +new Date(a.date)).slice(0, 30);
  const title = practice ? `Report operativo pratica — ${practice.title}` : `Fascicolo completo cliente — ${client.displayName}`;
  const dossierAndAiRows = [
    ...clientDossiers.map((d) => ({ text: `Dossier: ${d.title} · ${clean(d.type)} · ${clean(d.status)} · aggiornato ${fmt(d.updatedAt)}` })),
    ...aiOutputs.map((o) => ({ text: `Output AI: ${o.title} · ${clean(o.status)} · creato ${fmt(o.createdAt)}` })),
  ];
  const noDossierAiMessage = practice ? '- Nessun dossier o output AI collegato direttamente alla pratica.' : '- Nessun dato presente.';
  return { title, markdown: [
    `# ${title}`,
    `Generato il ${fmt(new Date())}. Report interno per controllo qualità, passaggio operativo e riepilogo pratica.`,
    '', '## Dati cliente', line('Cliente', client.displayName), line('Tipo', client.type), line('Stato', clean(client.status)), line('Commerciale', userOf(client.salesOwnerId)), line('Consulente', userOf(client.consultantId)), line('Note', safeText(client.notes)),
    '', '## Pratica tecnica collegata', practice ? [line('Titolo', practice.title), line('Tipo pratica', practice.practiceType), line('Stato', clean(practice.status)), line('Priorità', clean(practice.priority)), line('Responsabile tecnico', userOf(practice.technicalOwnerId)), line('Owner commerciale', userOf(practice.commercialOwnerId)), line('Ente/portale', `${practice.targetEntity}${practice.targetPortal ? ` · ${practice.targetPortal}` : ''}`), line('Protocollo', practice.protocolNumber), line('Scadenza', fmt(practice.dueDate)), line('Stato comunicabile', practice.clientVisibleStatus), line('Note interne', practice.internalNotes)].join('\n') : list(services, (s) => `- ${serviceName(s.id)} · stato ${clean(s.status)} · operativo ${clean(s.operationalStatus)} · owner ${userOf(s.assignedToId)}`),
    '', '## Timeline operativa sintetica', list(timeline, (e) => `- ${fmt(e.date)} — ${e.text}`),
    '', '## Documenti presenti', list(visibleDocuments, (d) => `- ${d.title} · ${clean(d.documentCategory)} · stato ${clean(d.status)} · caricato ${fmt(d.createdAt)}${d.containsSensitiveData ? ' · sensibile' : ''}`),
    '', '## Documenti mancanti da checklist', list(missing, (i) => `- ${i.title} · stato ${clean(i.status)} · contesto ${serviceName(i.clientServiceId)} · aggiornato ${fmt(i.updatedAt)}`),
    '', '## Task aperti, scaduti e completati', list(tasks, (t) => `- [${taskBucket(t.status, t.dueAt)}] ${t.title} · priorità ${clean(t.priority)} · scadenza ${fmt(t.dueAt)} · assegnatario ${userOf(t.assignedToId)}`),
    '', '## Comunicazioni pratica', list(communications, (c) => `- ${c.title} · ${clean(c.type)}/${clean(c.channel)} · stato ${clean(c.status)} · creata ${fmt(c.createdAt)} · revisione ${fmt(c.reviewedAt)} · uso ${fmt(c.usedAt)}${c.internalNote ? ` · nota: ${c.internalNote}` : ''}`),
    '', '## Dossier e output AI autorizzati', dossierAndAiRows.length ? list(dossierAndAiRows, (x) => `- ${x.text}`) : noDossierAiMessage,
    ...(hasPermission(session, 'audit.read') ? ['', '## Audit log autorizzato', list(audits, (a) => `- ${fmt(a.createdAt)} · ${clean(a.event)} · ${clean(a.entityType)}`)] : []),
    '', '## Nota FAI', DISCLAIMER,
  ].join('\n') };
}
