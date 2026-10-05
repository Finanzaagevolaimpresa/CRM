import React from 'react';
import { createRoot } from 'react-dom/client';
import { DashboardOverview } from '../../src/components/dashboard-overview';
import { buildDashboardCounterGroups, type DashboardCounterAccess, type DashboardCounterCounts } from '../../src/lib/dashboard-counter-groups';

const access: DashboardCounterAccess = { canReadLeads: true, canReadTechnical: true, canReviewPracticeCommunications: true,
  canReadPracticeCommunications: true, canReadClients: true, canReadProjects: true, canReadServices: true,
  canReadPayments: true, canReadDossiers: true, canReadAiOutputs: true, canReviewAiOutputs: true, isAdmin: true };
const large = new URLSearchParams(location.search).has('large');
const counts: DashboardCounterCounts = { leadDaContattare: large ? 123456789 : 24, trattativeAperte: 8, offerteInviate: 3,
  offerteAccettate: 0, activeTechnicalPracticesCount: 12, overdueClientUpdates: 2, commsToReview: 4, approvedUnusedComms: 0,
  clientiAttivi: 18, progettiAttivi: 11, serviziAcquistati: 21, tasks: 27, todayTasksCount: 5, overdueTasks: 2,
  dueSoonTasks: 8, payments: 0, preReview: 3, dossierBozza: 2, aiReview: 0, pendingAiAuthorizationRequestCount: 0 };
if (new URLSearchParams(location.search).has('zero')) for (const key of Object.keys(counts) as Array<keyof DashboardCounterCounts>) counts[key] = 0;
const groups = buildDashboardCounterGroups(access, counts);
createRoot(document.getElementById('root')!).render(<main style={{ maxWidth: 1360, margin: 'auto', padding: 16 }}>
  <p style={{ marginBottom: 16 }}>PRELANCIO-01 · verifica del componente candidato · dati interamente sintetici</p>
  <DashboardOverview greeting="Il tuo quadro operativo" summary="Contatori distinti per area e prossime attività."
    kpis={[
      { label: 'Lead da contattare', value: counts.leadDaContattare, description: 'Richieste nel perimetro assegnato', href: '/leads', tone: 'blue' },
      { label: 'Pratiche tecniche', value: counts.activeTechnicalPracticesCount, description: 'Pratiche accessibili in lavorazione', href: '/technical-office/practices', tone: 'green' },
      { label: 'Attività aperte', value: counts.tasks, description: 'Attività aperte o in lavorazione', href: '/tasks', tone: 'orange' },
      { label: 'Da revisionare', value: counts.preReview, description: 'Pre-analisi in attesa di revisione', href: '/preanalyses', tone: 'purple' },
    ]} counterGroups={groups} priorities={[]} shortcuts={[]}
    pipeline={[{ label: 'nuova', value: counts.progettiAttivi }, { label: 'in valutazione', value: counts.trattativeAperte }, { label: 'chiusa', value: counts.offerteInviate }]} />
</main>);
