export type DashboardCounterAccess = {
  canReadLeads: boolean;
  canReadTechnical: boolean;
  canReviewPracticeCommunications: boolean;
  canReadPracticeCommunications: boolean;
  canReadClients: boolean;
  canReadProjects: boolean;
  canReadServices: boolean;
  canReadPayments: boolean;
  canReadDossiers: boolean;
  canReadAiOutputs: boolean;
  isAdmin: boolean;
};

export type DashboardCounterCounts = {
  leadDaContattare: number;
  trattativeAperte: number;
  offerteInviate: number;
  offerteAccettate: number;
  activeTechnicalPracticesCount: number;
  overdueClientUpdates: number;
  commsToReview: number;
  approvedUnusedComms: number;
  clientiAttivi: number;
  progettiAttivi: number;
  serviziAcquistati: number;
  tasks: number;
  todayTasksCount: number;
  overdueTasks: number;
  dueSoonTasks: number;
  payments: number;
  preReview: number;
  dossierBozza: number;
  aiReview: number;
  pendingAiAuthorizationRequestCount: number;
};

export type DashboardCounter = {
  label: string;
  value: number;
  description: string;
  href: string | null;
};

export type DashboardCounterGroup = {
  id: string;
  title: string;
  description: string;
  tone: "blue" | "green" | "orange" | "purple";
  counters: DashboardCounter[];
};

type CounterDefinition = Omit<DashboardCounter, "value"> & {
  count: keyof DashboardCounterCounts;
  permission: keyof DashboardCounterAccess;
  destinationPermission?: keyof DashboardCounterAccess;
};

type GroupDefinition = Omit<DashboardCounterGroup, "counters"> & {
  counters: CounterDefinition[];
};

const groups: GroupDefinition[] = [
  {
    id: "commerciale",
    title: "Commerciale",
    description: "Contatti, trattative e offerte nel tuo perimetro.",
    tone: "blue",
    counters: [
      { count: "leadDaContattare", permission: "canReadLeads", label: "Lead da contattare", description: "Contatti in attesa del primo contatto", href: "/leads" },
      { count: "trattativeAperte", permission: "canReadLeads", label: "Trattative aperte", description: "Lead in trattativa", href: "/leads" },
      { count: "offerteInviate", permission: "canReadLeads", label: "Offerte inviate", description: "Offerte nello stato inviata", href: "/commercial-offers" },
      { count: "offerteAccettate", permission: "canReadLeads", label: "Offerte accettate", description: "Offerte nello stato accettata", href: "/commercial-offers" },
    ],
  },
  {
    id: "ufficio-tecnico",
    title: "Ufficio Tecnico",
    description: "Pratiche e comunicazioni da seguire.",
    tone: "green",
    counters: [
      { count: "activeTechnicalPracticesCount", permission: "canReadTechnical", label: "Pratiche tecniche attive", description: "Pratiche accessibili in stato operativo", href: "/technical-office/practices" },
      { count: "overdueClientUpdates", permission: "canReadTechnical", label: "Aggiornamenti cliente scaduti", description: "Pratiche visibili con aggiornamento oltre data", href: "/technical-office/practices" },
      { count: "commsToReview", permission: "canReviewPracticeCommunications", destinationPermission: "canReadTechnical", label: "Comunicazioni da revisionare", description: "Bozze in attesa di revisione", href: "/technical-office/practices" },
      { count: "approvedUnusedComms", permission: "canReadPracticeCommunications", destinationPermission: "canReadTechnical", label: "Approvate non utilizzate", description: "Comunicazioni approvate, senza utilizzo registrato", href: "/technical-office/practices" },
    ],
  },
  {
    id: "clienti-servizi",
    title: "Clienti e servizi",
    description: "Clienti, progetti e servizi accessibili.",
    tone: "green",
    counters: [
      { count: "clientiAttivi", permission: "canReadClients", label: "Clienti attivi", description: "Anagrafiche cliente in stato attivo", href: "/clients" },
      { count: "progettiAttivi", permission: "canReadProjects", label: "Progetti attivi", description: "Progetti non chiusi o archiviati", href: "/projects" },
      { count: "serviziAcquistati", permission: "canReadServices", label: "Servizi acquistati", description: "Servizi visibili, compresi quelli conclusi", href: "/dashboard#pipeline-pratiche" },
    ],
  },
  {
    id: "attivita-scadenze",
    title: "Attività e scadenze",
    description: "Attività aperte e relative scadenze.",
    tone: "orange",
    counters: [
      { count: "tasks", permission: "canReadServices", label: "Attività aperte", description: "Attività aperte o in lavorazione", href: "/tasks" },
      { count: "todayTasksCount", permission: "canReadServices", label: "In scadenza oggi", description: "Attività con scadenza nella giornata corrente", href: "/tasks" },
      { count: "overdueTasks", permission: "canReadServices", label: "Attività scadute", description: "Attività aperte oltre la scadenza", href: "/tasks" },
      { count: "dueSoonTasks", permission: "canReadServices", label: "Entro 7 giorni", description: "Scadenze da ora ai prossimi 7 giorni", href: "/tasks" },
    ],
  },
  {
    id: "amministrazione",
    title: "Amministrazione",
    description: "Registrazioni di pagamento da seguire.",
    tone: "orange",
    counters: [
      { count: "payments", permission: "canReadPayments", label: "Pagamenti aperti", description: "Numero di registrazioni aperte, non importo in euro", href: "/payments" },
    ],
  },
  {
    id: "revisioni-autorizzazioni",
    title: "Revisioni e autorizzazioni",
    description: "Bozze e richieste da valutare separatamente.",
    tone: "purple",
    counters: [
      { count: "preReview", permission: "canReadDossiers", label: "Pre-analisi da revisionare", description: "Pre-analisi in bozza o da revisionare", href: "/preanalyses" },
      { count: "dossierBozza", permission: "canReadDossiers", label: "Dossier in bozza", description: "Dossier in bozza o in revisione", href: "/dossiers" },
      { count: "aiReview", permission: "canReadAiOutputs", label: "Output AI da revisionare", description: "Output accessibili con revisione umana richiesta", href: "/ai/outputs-to-review" },
      { count: "pendingAiAuthorizationRequestCount", permission: "isAdmin", label: "Autorizzazioni AI in attesa", description: "Totale richieste pendenti e non scadute", href: "/settings/ai-authorizations" },
    ],
  },
];

export function buildDashboardCounterGroups(
  access: DashboardCounterAccess,
  counts: DashboardCounterCounts,
): DashboardCounterGroup[] {
  return groups.flatMap(({ counters, ...group }) => {
    const visibleCounters = counters
      .filter((counter) => access[counter.permission])
      .map((counter) => ({
        label: counter.label,
        description: counter.description,
        href: counter.destinationPermission && !access[counter.destinationPermission]
          ? null
          : counter.href,
        value: counts[counter.count],
      }));
    return visibleCounters.length > 0 ? [{ ...group, counters: visibleCounters }] : [];
  });
}
