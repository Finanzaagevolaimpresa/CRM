export const dynamic = 'force-dynamic';

import Link from 'next/link';
import type { Prisma } from '@prisma/client';
import { OpenLink, PrimaryButton } from '@/components/actions';
import { Card, EmptyState, PageHeader, StatusBadge, formatDateTime } from '@/components/ui';
import { canViewClient, canViewDocument, canViewTechnicalPractice } from '@/lib/access-control';
import { hasPermission, requireSession, type Permission } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

type SearchResult = {
  id: string;
  title: string;
  subtitle: string;
  category: string;
  status?: string | null;
  date?: Date | string | null;
  href: string;
};

type ResultGroup = {
  title: string;
  permission: Permission;
  items: SearchResult[];
};

const takePerCategory = 12;
const text = (query: string): Prisma.StringFilter => ({ contains: query, mode: 'insensitive' });
const snippet = (value?: string | null, max = 120) => {
  if (!value) return '—';
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
};
const fullName = (firstName: string, lastName: string) => `${firstName} ${lastName}`.trim();

function ResultsSection({ group }: { group: ResultGroup }) {
  if (group.items.length === 0) return null;
  return (
    <Card title={`${group.title} (${group.items.length})`}>
      <div className="grid gap-3">
        {group.items.map((item) => (
          <div key={`${item.category}-${item.id}`} className="rounded-2xl border border-slate-200/80 bg-white p-4 shadow-sm transition hover:border-fai-blue/25 hover:shadow-md">
            <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
              <div className="min-w-0 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge status={item.category} />
                  {item.status ? <StatusBadge status={item.status} /> : null}
                  {item.date ? <span className="text-xs font-bold text-slate-500">{formatDateTime(item.date)}</span> : null}
                </div>
                <h3 className="break-words text-base font-black text-fai-navy">{item.title}</h3>
                <p className="text-sm leading-6 text-slate-600">{item.subtitle}</p>
              </div>
              <OpenLink href={item.href}>Apri</OpenLink>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

export default async function Page({ searchParams }: { searchParams?: Promise<{ q?: string }> }) {
  const session = await requireSession();
  const params = await searchParams;
  const q = (params?.q ?? '').trim();
  const isTooShort = q.length > 0 && q.length < 2;
  const canReadSensitive = hasPermission(session, 'document.sensitive.read');

  let groups: ResultGroup[] = [];

  if (q.length >= 2) {
    const [clients, projects, services, documents, technicalPractices, tasks, communications, leads, offers, aiOutputs, dossiers] = await Promise.all([
      hasPermission(session, 'client.read')
        ? prisma.client.findMany({ where: { deletedAt: null, OR: [{ displayName: text(q) }, { status: text(q) }, { notes: text(q) }] }, orderBy: { updatedAt: 'desc' }, take: takePerCategory })
        : Promise.resolve([]),
      prisma.project.findMany({ where: { deletedAt: null }, select: { id: true, title: true, consultantId: true, clientId: true }, take: 500 }),
      prisma.clientService.findMany({ where: { deletedAt: null }, take: 500 }),
      hasPermission(session, 'document.download')
        ? prisma.document.findMany({ where: { deletedAt: null, OR: [{ title: text(q) }, { fileName: text(q) }, { documentCategory: text(q) }, { type: text(q) }, ] }, orderBy: { updatedAt: 'desc' }, take: takePerCategory })
        : Promise.resolve([]),
      hasPermission(session, 'technical.read')
        ? prisma.technicalPractice.findMany({ where: { deletedAt: null, OR: [{ title: text(q) }, { practiceType: text(q) }, { targetEntity: text(q) }, { targetPortal: text(q) }, { protocolNumber: text(q) }, { integrationRequestNote: text(q) }, { internalNotes: text(q) }, { clientVisibleStatus: text(q) }] }, orderBy: { updatedAt: 'desc' }, take: takePerCategory })
        : Promise.resolve([]),
      hasPermission(session, 'service.read')
        ? prisma.task.findMany({ where: { deletedAt: null, OR: [{ title: text(q) }, { description: text(q) }, { type: text(q) }] }, orderBy: [{ dueAt: 'asc' }, { updatedAt: 'desc' }], take: takePerCategory })
        : Promise.resolve([]),
      hasPermission(session, 'practice_communications.read')
        ? prisma.practiceCommunication.findMany({ where: { deletedAt: null, OR: [{ title: text(q) }, { content: text(q) }, { internalNote: text(q) }] }, orderBy: { updatedAt: 'desc' }, take: takePerCategory })
        : Promise.resolve([]),
      hasPermission(session, 'lead.read')
        ? prisma.lead.findMany({ where: { deletedAt: null, OR: [{ firstName: text(q) }, { lastName: text(q) }, { companyName: text(q) }, { contactPerson: text(q) }, { phone: text(q) }, { email: text(q) }, { source: text(q) }, { region: text(q) }, { province: text(q) }, { city: text(q) }, { interest: text(q) }, { commercialStatus: text(q) }, { nextActionNote: text(q) }, { notes: text(q) }, { commercialProposal: text(q) }] }, orderBy: { updatedAt: 'desc' }, take: takePerCategory })
        : Promise.resolve([]),
      hasPermission(session, 'lead.read')
        ? prisma.commercialOffer.findMany({ where: { deletedAt: null, OR: [{ title: text(q) }, { description: text(q) }, { services: text(q) }, { includedActivities: text(q) }, { operationalConditions: text(q) }, { commercialProposal: text(q) }, { notes: text(q) }, { followUpNote: text(q) }, { outcomeNote: text(q) }, { rejectionReason: text(q) }] }, orderBy: { updatedAt: 'desc' }, take: takePerCategory })
        : Promise.resolve([]),
      hasPermission(session, 'ai.review')
        ? prisma.aiOutput.findMany({ where: { OR: [{ title: text(q) }, { content: text(q) }] }, orderBy: { updatedAt: 'desc' }, take: takePerCategory })
        : Promise.resolve([]),
      hasPermission(session, 'dossier.read')
        ? prisma.clientDossier.findMany({ where: { OR: [{ title: text(q) }, { content: text(q) }] }, orderBy: { updatedAt: 'desc' }, take: takePerCategory })
        : Promise.resolve([]),
    ]);

    const allClients = await prisma.client.findMany({ where: { deletedAt: null } });
    const clientById = new Map(allClients.map((client) => [client.id, client]));
    const projectById = new Map(projects.map((project) => [project.id, { ...project, client: clientById.get(project.clientId) }]));
    const serviceById = new Map(services.map((service) => [service.id, service]));

    const visibleClients = clients.filter((client) => canViewClient(session, client));
    const visiblePractices = technicalPractices.filter((practice) => canViewTechnicalPractice(session, { ...practice, client: clientById.get(practice.clientId) ?? null }));
    const visibleDocuments = documents.filter((document) => canViewDocument(session, { ...document, client: document.clientId ? clientById.get(document.clientId) : null, project: document.projectId ? projectById.get(document.projectId) : null, clientService: document.clientServiceId ? serviceById.get(document.clientServiceId) : null }, canReadSensitive));
    const visibleTasks = session.role === 'admin' || session.role === 'direzione' || ['revisore', 'backoffice'].includes(session.role) ? tasks : tasks.filter((task) => task.assignedToId === session.userId || task.createdById === session.userId);
    const visibleCommunications = communications.filter((communication) => canViewTechnicalPractice(session, { commercialOwnerId: communication.commercialOwnerId, technicalOwnerId: communication.technicalOwnerId, client: clientById.get(communication.clientId) ?? null }));
    const visibleLeads = session.role === 'admin' || session.role === 'direzione' ? leads : leads.filter((lead) => !lead.assignedToId || lead.assignedToId === session.userId);
    const visibleOffers = session.role === 'admin' || session.role === 'direzione' ? offers : offers.filter((offer) => !offer.createdById || offer.createdById === session.userId || (offer.leadId && visibleLeads.some((lead) => lead.id === offer.leadId)) || (offer.clientId && visibleClients.some((client) => client.id === offer.clientId)));

    groups = [
      { title: 'Clienti', permission: 'client.read', items: visibleClients.map((client) => ({ id: client.id, title: client.displayName, subtitle: [client.type, client.notes].filter(Boolean).join(' · ') || 'Fascicolo cliente', category: 'Clienti', status: client.status, date: client.updatedAt, href: `/clients/${client.id}` })) },
      { title: 'Pratiche', permission: 'technical.read', items: visiblePractices.map((practice) => ({ id: practice.id, title: practice.title, subtitle: `${practice.practiceType} · ${practice.targetEntity}${practice.targetPortal ? ` · ${practice.targetPortal}` : ''}`, category: 'Pratiche', status: practice.status, date: practice.dueDate ?? practice.updatedAt, href: `/technical-office/practices/${practice.id}` })) },
      { title: 'Documenti', permission: 'document.download', items: visibleDocuments.map((document) => ({ id: document.id, title: document.title, subtitle: `${document.fileName} · ${document.documentCategory}`, category: 'Documenti', status: document.status, date: document.validUntil ?? document.updatedAt, href: document.clientId ? `/clients/${document.clientId}#documenti` : '/documents' })) },
      { title: 'Task', permission: 'service.read', items: visibleTasks.map((task) => ({ id: task.id, title: task.title, subtitle: snippet(task.description ?? task.type ?? 'Task operativo'), category: 'Task', status: task.status, date: task.dueAt ?? task.updatedAt, href: '/tasks' })) },
      { title: 'Comunicazioni', permission: 'practice_communications.read', items: visibleCommunications.map((communication) => ({ id: communication.id, title: communication.title, subtitle: snippet(`${communication.type} · ${communication.channel} · ${communication.content}`), category: 'Comunicazioni', status: communication.status, date: communication.usedAt ?? communication.reviewedAt ?? communication.updatedAt, href: `/technical-office/practices/${communication.technicalPracticeId}` })) },
      { title: 'Lead', permission: 'lead.read', items: visibleLeads.map((lead) => ({ id: lead.id, title: lead.companyName || fullName(lead.firstName, lead.lastName), subtitle: [lead.contactPerson, lead.email, lead.phone, lead.interest].filter(Boolean).join(' · ') || 'Lead commerciale', category: 'Lead', status: lead.status, date: lead.nextActionDate ?? lead.updatedAt, href: `/leads/${lead.id}` })) },
      { title: 'Offerte', permission: 'lead.read', items: visibleOffers.map((offer) => ({ id: offer.id, title: offer.title, subtitle: snippet(offer.description ?? offer.services ?? offer.commercialProposal ?? 'Offerta commerciale'), category: 'Offerte', status: offer.status, date: offer.followUpAt ?? offer.validUntil ?? offer.updatedAt, href: `/commercial-offers/${offer.id}` })) },
      { title: 'Output AI', permission: 'ai.review', items: aiOutputs.map((output) => ({ id: output.id, title: output.title, subtitle: snippet(output.content), category: 'Output AI', status: output.status, date: output.updatedAt, href: `/ai/outputs/${output.id}` })) },
      { title: 'Dossier', permission: 'dossier.read', items: dossiers.map((dossier) => ({ id: dossier.id, title: dossier.title, subtitle: snippet(dossier.content), category: 'Dossier', status: dossier.status, date: dossier.updatedAt, href: `/client-dossiers/${dossier.id}` })) },
    ] satisfies ResultGroup[];
    groups = groups.filter((group) => hasPermission(session, group.permission));
  }

  const resultCount = groups.reduce((sum, group) => sum + group.items.length, 0);

  return (
    <div className="space-y-6">
      <PageHeader title="Ricerca globale" description="Trova clienti, pratiche, documenti, task, comunicazioni, lead, offerte e contenuti interni autorizzati da un unico punto del CRM." />
      <Card title="Cerca nel CRM">
        <form action="/search" className="grid gap-3 md:grid-cols-[1fr_auto]">
          <input aria-label="Termine di ricerca" className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm shadow-inner outline-none transition focus:border-fai-blue focus:ring-2 focus:ring-fai-lime/40" defaultValue={q} name="q" placeholder="Cerca nome cliente, email, pratica, documento, comunicazione…" />
          <PrimaryButton type="submit">Cerca</PrimaryButton>
        </form>
        <p className="mt-3 text-xs font-semibold text-slate-500">La ricerca mostra solo categorie e record coerenti con ruolo e permessi della sessione corrente.</p>
      </Card>

      {!q ? <EmptyState title="Inserisci un termine di ricerca">Digita almeno 2 caratteri per avviare la ricerca globale.</EmptyState> : null}
      {isTooShort ? <EmptyState title="Query troppo corta">Inserisci almeno 2 caratteri per cercare nel CRM.</EmptyState> : null}
      {q.length >= 2 && resultCount === 0 ? <EmptyState title="Nessun risultato trovato">Nessun elemento autorizzato corrisponde a “{q}”. Prova con nome, email, titolo pratica, documento o stato.</EmptyState> : null}
      {q.length >= 2 && resultCount > 0 ? <div className="flex flex-wrap items-center gap-2 text-sm font-bold text-slate-600"><span>{resultCount} risultati per “{q}”</span><Link className="text-fai-blue underline" href="/search">Pulisci ricerca</Link></div> : null}
      {groups.map((group) => <ResultsSection group={group} key={group.title} />)}
    </div>
  );
}
