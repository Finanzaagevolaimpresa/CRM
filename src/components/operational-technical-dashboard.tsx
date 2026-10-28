import { DashboardOverview } from './dashboard-overview';
import { Card } from './ui';
import { SecondaryLink } from './actions';
import type { AuthSession } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { hasPermission } from '@/lib/permission-evaluator';
import { loadOperationalWorkCatalogue } from '@/lib/operational-work';
import { selectOperationalWork } from '@/lib/operational-work-projection';
import { listDashboardTodayTasks } from '@/lib/dashboard-detail';
export async function OperationalTechnicalDashboard({ session, view }: { session: AuthSession; view?: string }) {
  const now = new Date();
  const [practiceCatalogue, projectCatalogue, user, today] = await Promise.all([
    hasPermission(session, 'technical.read') ? loadOperationalWorkCatalogue(prisma, session, 'TechnicalPractice').catch(() => null) : null,
    hasPermission(session, 'project.read') ? loadOperationalWorkCatalogue(prisma, session, 'Project').catch(() => null) : null,
    prisma.user.findUnique({ where: { id: session.userId }, select: { name: true } }),
    hasPermission(session, 'service.read') ? listDashboardTodayTasks(session, now) : [],
  ]);
  const practices = practiceCatalogue ? selectOperationalWork(practiceCatalogue.records, { active: true }) : null;
  const projects = projectCatalogue ? selectOperationalWork(projectCatalogue.records) : null;
  const unknown = practiceCatalogue ? selectOperationalWork(practiceCatalogue.records).hiddenStatus : 0;
  return <div className="crm-space-y-6"><DashboardOverview greeting="Il tuo lavoro tecnico" userName={user?.name ?? ''}
    summary="Responsabilità ordinarie e incarichi personali correnti, senza duplicati." showPipeline={false} pipeline={[]}
    priorities={[]} priorityLinks={[]}
    kpis={[...(practices ? [{ id: 'pratiche' as const, label: 'Pratiche attive', value: practices.total,
      description: 'Stati operativi leggibili: escluse approvate, respinte e archiviate.',
      href: '/technical-office/practices?dashboard=attive', tone: 'green' as const }] : []),
      ...(hasPermission(session, 'service.read') ? [{ id: 'oggi' as const, label: 'In scadenza oggi', value: today.length,
        description: 'Attività in scadenza nel tuo perimetro.', href: '/tasks?dashboard=oggi', tone: 'orange' as const }] : [])]}
    selectedKpiId={view === 'oggi' ? 'oggi' : 'pratiche'} detailItems={view === 'oggi'
      ? today.slice(0, 3).map(row => ({ id: row.id, title: row.title, status: row.status, href: '/tasks?dashboard=oggi' }))
      : practices?.records.slice(0, 3).map(row => ({
      id: row.id, title: row.title ?? 'Pratica · titolo non condiviso', status: row.status!, href: row.href,
    })) ?? []}
    shortcuts={[
      ...(practices ? [{ label: 'Ufficio tecnico', description: 'Pratiche e scadenze nel tuo perimetro', href: '/technical-office', icon: 'gear', tone: 'green' }] : []),
      ...(projects ? [{ label: 'Progetti', description: projects.total + ' progetti autorizzati', href: '/projects', icon: 'folder', tone: 'blue' }] : []),
      { label: 'I miei incarichi tecnici', description: 'Schede ordinarie e perimetri personali', href: '/technical-work', icon: 'folder', tone: 'green' },
      { label: 'Richieste all’Admin', description: 'Segui le richieste pertinenti', href: '/admin-requests', icon: 'mail', tone: 'purple' },
      { label: 'Attività e scadenze', description: 'Le attività autorizzate', href: '/tasks', icon: 'calendar', tone: 'orange' },
    ]}
    perimeterLinks={[{ label: 'I miei incarichi tecnici', href: '/technical-work' }, { label: 'Le mie assegnazioni', href: '/assignments' }]} />
    {((hasPermission(session, 'technical.read') && !practiceCatalogue) || (hasPermission(session, 'project.read') && !projectCatalogue)) &&
      <p role="status">Una vista non è disponibile con la sessione corrente; non è conteggiata come un elenco vuoto.</p>}
    {((practiceCatalogue && !practiceCatalogue.selectiveAvailable) || (projectCatalogue && !projectCatalogue.selectiveAvailable)) &&
      <p role="status">Incarichi personali non disponibili: sono mostrati soltanto i dati ordinari autorizzati.</p>}
    {unknown > 0 && <Card title="Pratiche con stato non condiviso"><p>{unknown} ulteriori pratiche autorizzate non contribuiscono ai contatori per stato.</p><SecondaryLink href="/technical-office/practices">Apri tutte le pratiche autorizzate</SecondaryLink></Card>}
  </div>;
}
