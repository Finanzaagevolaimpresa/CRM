import Link from "next/link";
import {
  Badge,
  Card,
  EmptyState,
  Stat,
  PageHeader,
  formatDateTime,
} from "@/components/ui";
import { legalDisclaimer } from "@/lib/compliance";
import { canViewAiRecord, canViewClient, canViewProject } from "@/lib/access-control";
import { prisma } from "@/lib/prisma";
import { hasPermission, requireSession } from "@/lib/auth";
import type { OperationalServiceStatus, TaskStatus } from "@prisma/client";
export const dynamic = "force-dynamic";
export default async function Dashboard() {
  const session = await requireSession();
  const now = new Date();
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const endOfToday = new Date(now);
  endOfToday.setHours(23, 59, 59, 999);
  const next7 = new Date(now);
  next7.setDate(next7.getDate() + 7);
  const canReadServices = hasPermission(session, "service.read");
  const canReadTechnical = hasPermission(session, "technical.read");
  const canReadPracticeCommunications = hasPermission(
    session,
    "practice_communications.read",
  );
  const canReviewPracticeCommunications = hasPermission(
    session,
    "practice_communications.review",
  );
  const canReadLeads = hasPermission(session, "lead.read");
  const canReadClients = hasPermission(session, "client.read");
  const canReadProjects = hasPermission(session, "project.read");
  const canReadDossiers = hasPermission(session, "dossier.read");
  const canReadContracts = hasPermission(session, "contract.read");
  const canReadPayments = hasPermission(session, "payment.read");
  const canReviewAi = hasPermission(session, "ai.review");
  const canReadAudit = hasPermission(session, "audit.read");
  const canSeeAllTasks = [
    "admin",
    "direzione",
    "revisore",
    "backoffice",
  ].includes(session.role);
  const openTaskWhere = {
    deletedAt: null,
    status: { in: ["aperta", "in_lavorazione"] as TaskStatus[] },
    ...(canSeeAllTasks
      ? {}
      : {
          OR: [
            { assignedToId: session.userId },
            { createdById: session.userId },
          ],
        }),
  };
  const leadAccessWhere =
    session.role === "admin" || session.role === "direzione"
      ? {}
      : { OR: [{ assignedToId: null }, { assignedToId: session.userId }] };
  const [allDashboardClients, allDashboardProjects] = await Promise.all([
    prisma.client.findMany({ where: { deletedAt: null } }),
    prisma.project.findMany({ where: { deletedAt: null } }),
  ]);
  const accessibleDashboardClients = allDashboardClients.filter((client) => canViewClient(session, client));
  const accessibleDashboardClientIds = accessibleDashboardClients.map((client) => client.id);
  const dashboardClientWhere = { clientId: { in: accessibleDashboardClientIds } };
  const accessibleDashboardProjects = allDashboardProjects.filter((project) => canViewProject(session, { ...project, client: allDashboardClients.find((client) => client.id === project.clientId) ?? null }));
  const accessibleDashboardProjectIds = accessibleDashboardProjects.map((project) => project.id);
  const pipelineStatuses: OperationalServiceStatus[] = [
    "nuova",
    "pre_analisi",
    "documenti_richiesti",
    "documenti_ricevuti",
    "in_valutazione",
    "proposta_inviata",
    "domanda_in_preparazione",
    "domanda_presentata",
    "in_istruttoria",
    "approvata_deliberata",
    "respinta_non_procedibile",
    "rendicontazione",
    "chiusa",
    "archiviata",
  ];
  const highlightedPipelineStatuses: OperationalServiceStatus[] = [
    "in_istruttoria",
    "documenti_richiesti",
    "domanda_in_preparazione",
    "rendicontazione",
  ];
  const statusLabel = (status: string) => status.replaceAll("_", " ");
  const [
    leadNuovi,
    leadDaContattare,
    proposteInviate,
    trattativeAperte,
    leadVinti,
    leadPersi,
    commercialActionsOverdue,
    commercialActionsDueSoon,
    offerteInviate,
    offerteAccettate,
    offerteRifiutate,
    offerFollowUpsOverdue,
    offerFollowUpsDueSoon,
    clientiAttivi,
    progettiAttivi,
    serviziAcquistati,
    preReview,
    dossierBozza,
    contracts,
    payments,
    tasks,
    overdueTasks,
    dueSoonTasks,
    myTasks,
    aiReview,
    lastAudit,
    lastAiOutputCandidates,
    lastPayment,
    lastTask,
    pipelineCounts,
    commsToReview,
    overdueClientUpdates,
    approvedUnusedComms,
    todayTasksCount,
    activeTechnicalPracticesCount,
    operationalTasks,
    operationalCommsToReview,
    operationalActivePractices,
    operationalLeadFollowUps,
    operationalOfferFollowUps,
    operationalClients,
  ] = await Promise.all([
    canReadLeads
      ? prisma.lead.count({
          where: { deletedAt: null, status: "nuovo", ...leadAccessWhere },
        })
      : 0,
    canReadLeads
      ? prisma.lead.count({
          where: {
            deletedAt: null,
            status: "da_contattare",
            ...leadAccessWhere,
          },
        })
      : 0,
    canReadLeads
      ? prisma.lead.count({
          where: {
            deletedAt: null,
            ...leadAccessWhere,
            status: { in: ["proposta_inviata", "offerta_inviata"] },
          },
        })
      : 0,
    canReadLeads
      ? prisma.lead.count({
          where: {
            deletedAt: null,
            status: "in_trattativa",
            ...leadAccessWhere,
          },
        })
      : 0,
    canReadLeads
      ? prisma.lead.count({
          where: {
            deletedAt: null,
            ...leadAccessWhere,
            status: { in: ["vinto", "cliente_acquisito"] },
          },
        })
      : 0,
    canReadLeads
      ? prisma.lead.count({
          where: { deletedAt: null, status: "perso", ...leadAccessWhere },
        })
      : 0,
    canReadLeads
      ? prisma.lead.count({
          where: {
            deletedAt: null,
            ...leadAccessWhere,
            nextActionDate: { lt: now },
            status: {
              notIn: ["vinto", "perso", "archiviato", "cliente_acquisito"],
            },
          },
        })
      : 0,
    canReadLeads
      ? prisma.lead.count({
          where: {
            deletedAt: null,
            ...leadAccessWhere,
            nextActionDate: { gte: now, lte: next7 },
            status: {
              notIn: ["vinto", "perso", "archiviato", "cliente_acquisito"],
            },
          },
        })
      : 0,
    canReadLeads
      ? prisma.commercialOffer.count({
          where: { deletedAt: null, status: "inviata", OR: [{ clientId: null }, { clientId: { in: accessibleDashboardClientIds } }] },
        })
      : 0,
    canReadLeads
      ? prisma.commercialOffer.count({
          where: { deletedAt: null, status: "accettata", OR: [{ clientId: null }, { clientId: { in: accessibleDashboardClientIds } }] },
        })
      : 0,
    canReadLeads
      ? prisma.commercialOffer.count({
          where: { deletedAt: null, status: "rifiutata", OR: [{ clientId: null }, { clientId: { in: accessibleDashboardClientIds } }] },
        })
      : 0,
    canReadLeads
      ? prisma.commercialOffer.count({
          where: {
            deletedAt: null,
            OR: [{ clientId: null }, { clientId: { in: accessibleDashboardClientIds } }],
            followUpAt: { lt: now },
            status: { notIn: ["accettata", "rifiutata"] },
          },
        })
      : 0,
    canReadLeads
      ? prisma.commercialOffer.count({
          where: {
            deletedAt: null,
            OR: [{ clientId: null }, { clientId: { in: accessibleDashboardClientIds } }],
            followUpAt: { gte: now, lte: next7 },
            status: { notIn: ["accettata", "rifiutata"] },
          },
        })
      : 0,
    canReadClients ? accessibleDashboardClients.filter((client) => client.status === "attivo").length : 0,
    canReadProjects ? accessibleDashboardProjects.filter((project) => !["chiuso", "archiviato"].includes(project.status)).length : 0,
    canReadServices ? prisma.clientService.count({ where: { deletedAt: null, ...dashboardClientWhere } }) : 0,
    canReadDossiers ? prisma.preAnalysis.count({
      where: { clientId: { in: accessibleDashboardClientIds }, projectId: { in: accessibleDashboardProjectIds }, status: { in: ["bozza_generata", "da_revisionare"] } },
    }) : 0,
    canReadDossiers ? prisma.dossier.count({
      where: {
        clientId: { in: accessibleDashboardClientIds }, projectId: { in: accessibleDashboardProjectIds }, status: { in: ["bozza_ai", "bozza_consulente", "in_revisione"] },
      },
    }) : 0,
    canReadContracts ? prisma.contract.count({ where: dashboardClientWhere }) : 0,
    canReadPayments ? prisma.payment.count({
      where: { ...dashboardClientWhere, status: { notIn: ["incassato", "stornato", "rimborsato"] } },
    }) : 0,
    canReadServices ? prisma.task.count({ where: openTaskWhere }) : 0,
    canReadServices
      ? prisma.task.count({ where: { ...openTaskWhere, dueAt: { lt: now } } })
      : 0,
    canReadServices
      ? prisma.task.count({
          where: { ...openTaskWhere, dueAt: { gte: now, lte: next7 } },
        })
      : 0,
    canReadServices
      ? prisma.task.count({
          where: { ...openTaskWhere, assignedToId: session.userId },
        })
      : 0,
    canReviewAi ? prisma.aiOutput.count({
      where: {
        clientId: { in: accessibleDashboardClientIds },
        status: { in: ["needs_review", "flagged"] },
        requiresHumanReview: true,
      },
    }) : 0,
    canReadAudit ? prisma.auditLog.findFirst({ orderBy: { createdAt: "desc" } }) : null,
    canReviewAi ? prisma.aiOutput.findMany({
      where: { status: { in: ["needs_review", "flagged"] } },
      orderBy: { createdAt: "desc" },
      take: 50,
    }) : [],
    canReadPayments ? prisma.payment.findFirst({ where: dashboardClientWhere, orderBy: { createdAt: "desc" } }) : null,
    canReadServices
      ? prisma.task.findFirst({
          where: openTaskWhere,
          orderBy: { dueAt: "asc" },
        })
      : null,
    canReadServices
      ? prisma.clientService.groupBy({
          by: ["operationalStatus"],
          where: { deletedAt: null, ...dashboardClientWhere },
          _count: { _all: true },
        })
      : [],
    canReviewPracticeCommunications
      ? prisma.practiceCommunication.count({
          where: { deletedAt: null, status: "da_revisionare", clientId: { in: accessibleDashboardClientIds } },
        })
      : 0,
    canReadTechnical
      ? prisma.technicalPractice.count({
          where: { deletedAt: null, clientId: { in: accessibleDashboardClientIds }, nextClientUpdateAt: { lt: now } },
        })
      : 0,
    canReadPracticeCommunications
      ? prisma.practiceCommunication.count({
          where: { deletedAt: null, clientId: { in: accessibleDashboardClientIds }, status: "approvata", usedAt: null },
        })
      : 0,
    canReadServices
      ? prisma.task.count({
          where: {
            ...openTaskWhere,
            dueAt: { gte: startOfToday, lte: endOfToday },
          },
        })
      : 0,
    canReadTechnical
      ? prisma.technicalPractice.count({
          where: {
            deletedAt: null,
            clientId: { in: accessibleDashboardClientIds },
            status: { notIn: ["approvata", "respinta", "archiviata"] },
          },
        })
      : 0,
    canReadServices
      ? prisma.task.findMany({
          where: { ...openTaskWhere, dueAt: { lte: endOfToday } },
          orderBy: [{ dueAt: "asc" }, { createdAt: "asc" }],
          take: 20,
        })
      : [],
    canReviewPracticeCommunications
      ? prisma.practiceCommunication.findMany({
          where: { deletedAt: null, status: "da_revisionare", clientId: { in: accessibleDashboardClientIds } },
          orderBy: { createdAt: "asc" },
          take: 20,
        })
      : [],
    canReadTechnical
      ? prisma.technicalPractice.findMany({
          where: {
            deletedAt: null,
            clientId: { in: accessibleDashboardClientIds },
            status: { notIn: ["approvata", "respinta", "archiviata"] },
          },
          orderBy: [{ dueDate: "asc" }, { updatedAt: "desc" }],
          take: 20,
        })
      : [],
    canReadLeads
      ? prisma.lead.findMany({
          where: {
            deletedAt: null,
            ...leadAccessWhere,
            nextActionDate: { lte: next7 },
            status: {
              notIn: ["vinto", "perso", "archiviato", "cliente_acquisito"],
            },
          },
          orderBy: { nextActionDate: "asc" },
          take: 20,
        })
      : [],
    canReadLeads
      ? prisma.commercialOffer.findMany({
          where: {
            deletedAt: null,
            OR: [{ clientId: null }, { clientId: { in: accessibleDashboardClientIds } }],
            followUpAt: { lte: next7 },
            status: { notIn: ["accettata", "rifiutata"] },
          },
          orderBy: { followUpAt: "asc" },
          take: 20,
        })
      : [],
    canReadClients ? accessibleDashboardClients.map((client) => ({ id: client.id, displayName: client.displayName })) : [],
  ]);
  const lastAiRuns = lastAiOutputCandidates.length ? await prisma.aiRun.findMany({ where: { id: { in: lastAiOutputCandidates.map((output) => output.aiRunId) } } }) : [];
  const lastAiRunById = new Map(lastAiRuns.map((run) => [run.id, run]));
  const lastAiOutput = lastAiOutputCandidates.find((output) => canViewAiRecord(session, { createdById: lastAiRunById.get(output.aiRunId)?.createdById, client: output.clientId ? allDashboardClients.find((client) => client.id === output.clientId) ?? null : null, project: output.projectId ? accessibleDashboardProjects.find((project) => project.id === output.projectId) ?? null : null })) ?? null;
  const priorityStats = [
    [
      "Lead nuovi",
      leadNuovi,
      "Nuovi contatti da qualificare",
      "/leads",
      "blue",
    ],
    [
      "Follow-up lead scaduti",
      commercialActionsOverdue,
      "Azioni commerciali oltre scadenza",
      "/leads",
      "orange",
    ],
    [
      "Offerte da seguire",
      offerFollowUpsOverdue + offerFollowUpsDueSoon,
      "Follow-up offerta scaduti o a 7 giorni",
      "/leads",
      "purple",
    ],
    [
      "Attività scadute",
      overdueTasks,
      "Task operativi oltre scadenza",
      "/tasks",
      "orange",
    ],
    [
      "Output AI da revisionare",
      aiReview,
      "Bozze AI con human review obbligatoria",
      "/ai/outputs-to-review",
      "purple",
    ],
    [
      "Comunicazioni da revisionare",
      commsToReview,
      "Bozze cliente/commerciale in attesa approvazione",
      "/technical-office/practices",
      "orange",
    ],
    [
      "Update cliente scaduti",
      overdueClientUpdates,
      "Pratiche con prossima comunicazione oltre data",
      "/technical-office/practices",
      "orange",
    ],
    [
      "Comunicazioni approvate non usate",
      approvedUnusedComms,
      "Pronte per uso manuale, senza invio automatico",
      "/technical-office/practices",
      "green",
    ],
  ].filter(([label]) => (canReadLeads || !String(label).includes("Lead")) && (canReadServices || !String(label).includes("Attività")) && (canReviewAi || !String(label).includes("Output AI")) && (canReviewPracticeCommunications || !String(label).includes("Comunicazioni da revisionare")) && (canReadTechnical || !String(label).includes("Update cliente")) && (canReadPracticeCommunications || !String(label).includes("Comunicazioni approvate")));
  const businessStats = [
    [
      "Clienti attivi",
      clientiAttivi,
      "Fascicoli cliente aperti",
      "/clients",
      "green",
    ],
    [
      "Progetti attivi",
      progettiAttivi,
      "Pratiche in lavorazione",
      "/projects",
      "blue",
    ],
    [
      "Servizi acquistati",
      serviziAcquistati,
      "Servizi FAI collegati",
      "/clients",
      "lime",
    ],
    [
      "Pre-analisi da revisionare",
      preReview,
      "Bozze tecniche da controllare",
      "/preanalyses",
      "orange",
    ],
    [
      "Dossier in bozza",
      dossierBozza,
      "Documenti non ancora approvati",
      "/dossiers",
      "purple",
    ],
    [
      "Pagamenti aperti",
      payments,
      "Incassi e scadenze amministrative",
      "/payments",
      "orange",
    ],
  ].filter(([label]) => (canReadClients || label !== "Clienti attivi") && (canReadProjects || label !== "Progetti attivi") && (canReadServices || label !== "Servizi acquistati") && (canReadDossiers || !String(label).includes("Dossier") && !String(label).includes("Pre-analisi")) && (canReadPayments || label !== "Pagamenti aperti"));
  const strategicAreas = [
    [
      "Ufficio Tecnico",
      "Progettazione e preparazione pratiche per enti e portali competenti.",
      "/technical-office",
      "green",
    ],
    [
      "Legale / Compliance AI",
      "Revisione interna di contratti, PEC, privacy e output AI sensibili.",
      "/legal-compliance",
      "purple",
    ],
  ].filter(([label]) => (canReadTechnical || label !== "Ufficio Tecnico") && (canReadContracts || label !== "Legale / Compliance AI"));
  const tracking = [
    [
      "Ultima sincronizzazione dati",
      formatDateTime(new Date()),
      "Snapshot dashboard calcolato lato server",
    ],
    [
      "Ultima attività CRM",
      formatDateTime(lastAudit?.createdAt),
      lastAudit
        ? `${lastAudit.event} · ${lastAudit.entityType ?? "entità"}`
        : "Nessun audit registrato",
    ],
    [
      "Ultimo output AI da revisionare",
      formatDateTime(lastAiOutput?.createdAt),
      lastAiOutput?.title ?? "Nessuna bozza in coda",
    ],
    [
      "Ultimo pagamento registrato",
      formatDateTime(lastPayment?.createdAt),
      lastPayment
        ? `€ ${Number(lastPayment.totalAmount).toLocaleString("it-IT")}`
        : "Nessun pagamento",
    ],
    [
      "Prossima attività aperta",
      formatDateTime(lastTask?.dueAt ?? lastTask?.createdAt),
      lastTask?.title ?? "Nessuna attività aperta",
    ],
  ].filter(([label]) => (canReadAudit || label !== "Ultima attività CRM") && (canReviewAi || label !== "Ultimo output AI da revisionare") && (canReadPayments || label !== "Ultimo pagamento registrato") && (canReadServices || label !== "Prossima attività aperta"));
  const taskSummary = [
    [
      "Attività aperte",
      tasks,
      "Totale attività aperte o in lavorazione",
      "blue",
    ],
    [
      "Attività scadute",
      overdueTasks,
      "Scadenza precedente alla data corrente",
      "orange",
    ],
    [
      "In scadenza 7 giorni",
      dueSoonTasks,
      "Scadenza entro i prossimi 7 giorni",
      "purple",
    ],
    [
      "Assegnate a me",
      myTasks,
      "Attività assegnate all’utente loggato",
      "green",
    ],
  ].filter(() => canReadServices);
  const commercialSummary = [
    ["Nuovi lead", leadNuovi, "Contatti appena entrati", "blue"],
    [
      "Da contattare",
      leadDaContattare,
      "Lead in attesa di primo contatto",
      "orange",
    ],
    [
      "Proposte inviate",
      proposteInviate,
      "Offerte/proposte già inviate",
      "purple",
    ],
    [
      "Trattative aperte",
      trattativeAperte,
      "Negoziazioni commerciali attive",
      "blue",
    ],
    ["Lead vinti", leadVinti, "Esiti commerciali positivi", "green"],
    ["Lead persi", leadPersi, "Esiti commerciali negativi", "gray"],
    [
      "Azioni scadute",
      commercialActionsOverdue,
      "Prossime azioni oltre scadenza",
      "orange",
    ],
    [
      "Azioni 7 giorni",
      commercialActionsDueSoon,
      "Follow-up da eseguire a breve",
      "purple",
    ],
    ["Offerte inviate", offerteInviate, "Offerte segnate come inviate", "blue"],
    [
      "Offerte accettate",
      offerteAccettate,
      "Trattative vinte su offerta",
      "green",
    ],
    [
      "Offerte rifiutate",
      offerteRifiutate,
      "Trattative chiuse con rifiuto",
      "gray",
    ],
    [
      "Follow-up offerta scaduti",
      offerFollowUpsOverdue,
      "Follow-up offerta oltre scadenza",
      "orange",
    ],
    [
      "Follow-up offerta 7 giorni",
      offerFollowUpsDueSoon,
      "Follow-up offerta entro 7 giorni",
      "purple",
    ],
  ].filter(() => canReadLeads);

  const clientNames = new Map(
    operationalClients.map((client) => [client.id, client.displayName]),
  );
  const operationalCards = [
    [
      "Task in scadenza oggi",
      todayTasksCount,
      "Da completare entro oggi",
      "/tasks",
      "blue",
    ],
    [
      "Task scaduti",
      overdueTasks,
      "Attività aperte oltre scadenza",
      "/tasks",
      "orange",
    ],
    [
      "Pratiche tecniche attive",
      activeTechnicalPracticesCount,
      "Stati operativi ancora aperti",
      "/technical-office/practices",
      "green",
    ],
    [
      "Comunicazioni in approvazione",
      canReviewPracticeCommunications ? commsToReview : 0,
      "Bozze da validare prima dell'uso",
      "/technical-office/practices",
      "purple",
    ],
    [
      "Comunicazioni approvate non usate",
      approvedUnusedComms,
      "Pronte per l'invio o uso manuale",
      "/technical-office/practices",
      "lime",
    ],
    [
      "Lead/offerte da ricontattare",
      commercialActionsOverdue +
        commercialActionsDueSoon +
        offerFollowUpsOverdue +
        offerFollowUpsDueSoon,
      "Follow-up commerciali prossimi o scaduti",
      "/leads",
      "orange",
    ],
  ].filter(([label]) => (canReadServices || !String(label).includes("Task")) && (canReadTechnical || !String(label).includes("Pratiche tecniche")) && (canReviewPracticeCommunications || !String(label).includes("approvazione")) && (canReadPracticeCommunications || !String(label).includes("approvate")) && (canReadLeads || !String(label).includes("Lead")));
  const priorityItems = [
    ...operationalTasks.map((task) => ({
      id: `task-${task.id}`,
      rank: task.dueAt && task.dueAt < startOfToday ? 0 : 1,
      title: task.title,
      related: task.clientId ? clientNames.get(task.clientId) : null,
      type:
        task.dueAt && task.dueAt < startOfToday ? "Task scaduto" : "Task oggi",
      date: task.dueAt,
      href: "/tasks",
    })),
    ...operationalCommsToReview.map((communication) => ({
      id: `communication-${communication.id}`,
      rank: 2,
      title: communication.title,
      related: clientNames.get(communication.clientId),
      type: "Comunicazione da approvare",
      date: communication.createdAt,
      href: `/technical-office/practices/${communication.technicalPracticeId}`,
    })),
    ...operationalActivePractices.map((practice) => ({
      id: `practice-${practice.id}`,
      rank: 3,
      title: practice.title,
      related: clientNames.get(practice.clientId),
      type: "Pratica tecnica aperta",
      date: practice.dueDate ?? practice.updatedAt,
      href: `/technical-office/practices/${practice.id}`,
    })),
    ...operationalLeadFollowUps.map((lead) => ({
      id: `lead-${lead.id}`,
      rank: 4,
      title: lead.companyName ?? `${lead.firstName} ${lead.lastName}`,
      related: lead.clientId ? clientNames.get(lead.clientId) : null,
      type: "Follow-up lead",
      date: lead.nextActionDate,
      href: `/leads/${lead.id}`,
    })),
    ...operationalOfferFollowUps.map((offer) => ({
      id: `offer-${offer.id}`,
      rank: 4,
      title: offer.title,
      related: offer.clientId ? clientNames.get(offer.clientId) : null,
      type: "Follow-up offerta",
      date: offer.followUpAt,
      href: `/commercial-offers/${offer.id}`,
    })),
  ]
    .sort(
      (a, b) =>
        a.rank - b.rank || (a.date?.getTime() ?? 0) - (b.date?.getTime() ?? 0),
    )
    .slice(0, 10);

  const toneClasses = {
    blue: "border-fai-blue/20 bg-fai-blue/5 text-fai-blue",
    green: "border-fai-green/20 bg-fai-teal/5 text-fai-green",
    orange: "border-fai-orange/30 bg-fai-orange/10 text-fai-orange",
    purple: "border-fai-purple/20 bg-fai-purple/10 text-fai-purple",
    gray: "border-slate-200 bg-slate-50 text-slate-500",
  } as const;
  const miniCard = ([label, value, desc, tone]: Array<string | number>) => (
    <div
      key={String(label)}
      className={`min-h-28 rounded-2xl border p-4 ${toneClasses[tone as keyof typeof toneClasses] ?? toneClasses.blue}`}
    >
      <p className="text-2xl font-black text-fai-navy">{value}</p>
      <p className="mt-1 text-[0.68rem] font-black uppercase tracking-wide">
        {label}
      </p>
      <p className="mt-2 text-xs leading-5 text-slate-500">{desc}</p>
    </div>
  );
  const pipelineCount = (status: OperationalServiceStatus) =>
    pipelineCounts.find((row) => row.operationalStatus === status)?._count
      ._all ?? 0;
  return (
    <div className="space-y-6">
      <PageHeader title="Dashboard operativa" description={legalDisclaimer} />
      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        {priorityStats.map(([l, v, d, h, t]) => (
          <Stat
            key={String(l)}
            label={String(l)}
            value={Number(v)}
            description={String(d)}
            href={String(h)}
            tone={t as never}
          />
        ))}
      </section>
      <Card title="Operatività di oggi">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          {operationalCards.map(([l, v, d, h, t]) => (
            <Stat
              key={String(l)}
              label={String(l)}
              value={Number(v)}
              description={String(d)}
              href={String(h)}
              tone={t as never}
            />
          ))}
        </div>
      </Card>
      <Card title="Priorità operative">
        {priorityItems.length === 0 ? (
          <EmptyState title="Nessuna priorità operativa">
            Non ci sono attività, comunicazioni, pratiche o follow-up da
            lavorare subito.
          </EmptyState>
        ) : (
          <div className="space-y-3">
            {priorityItems.map((item) => (
              <div
                key={item.id}
                className="grid gap-3 rounded-2xl border border-slate-200 bg-slate-50/70 p-4 text-sm md:grid-cols-[1.4fr_1fr_0.9fr_0.8fr_auto] md:items-center"
              >
                <div>
                  <p className="font-extrabold text-fai-navy">{item.title}</p>
                  <p className="mt-1 text-xs text-slate-500">
                    {item.related ?? "Nessun cliente collegato"}
                  </p>
                </div>
                <Badge
                  tone={
                    item.rank === 0
                      ? "orange"
                      : item.rank === 2
                        ? "purple"
                        : "blue"
                  }
                >
                  {item.type}
                </Badge>
                <span className="text-xs font-bold text-slate-600">
                  {formatDateTime(item.date)}
                </span>
                <span className="text-xs text-slate-500">
                  Priorità #{priorityItems.indexOf(item) + 1}
                </span>
                <Link
                  className="text-xs font-black uppercase tracking-wide text-fai-green underline"
                  href={item.href}
                >
                  Apri
                </Link>
              </div>
            ))}
          </div>
        )}
      </Card>
      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        {businessStats.map(([l, v, d, h, t]) => (
          <Stat
            key={String(l)}
            label={String(l)}
            value={Number(v)}
            description={String(d)}
            href={String(h)}
            tone={t as never}
          />
        ))}
      </section>
      <Card title="Aree strategiche">
        <div className="grid gap-3 md:grid-cols-2">
          {strategicAreas.map(([label, desc, href, tone]) => (
            <Stat
              key={label}
              label={label}
              value="→"
              description={desc}
              href={href}
              tone={tone as never}
            />
          ))}
        </div>
      </Card>
      <Card title="Riepilogo commerciale">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-7">
          {commercialSummary.map((item) => miniCard(item))}
        </div>
      </Card>
      <Card title="Pipeline pratiche / servizi">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
          {pipelineStatuses.map((status) => {
            const highlighted = highlightedPipelineStatuses.includes(status);
            return (
              <div
                key={status}
                className={
                  highlighted
                    ? "min-h-24 rounded-2xl border border-fai-orange/30 bg-fai-orange/10 p-4"
                    : "min-h-24 rounded-2xl border border-slate-200 bg-white p-4"
                }
              >
                <p className="text-2xl font-black text-fai-navy">
                  {pipelineCount(status)}
                </p>
                <p
                  className={
                    highlighted
                      ? "mt-1 text-[0.68rem] font-black uppercase tracking-wide text-fai-orange"
                      : "mt-1 text-[0.68rem] font-black uppercase tracking-wide text-fai-blue"
                  }
                >
                  {statusLabel(status)}
                </p>
                {highlighted ? (
                  <p className="mt-2 text-xs font-bold text-fai-orange">
                    Da monitorare
                  </p>
                ) : null}
              </div>
            );
          })}
        </div>
      </Card>
      <Card title="Attività e scadenze">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {taskSummary.map((item) => miniCard(item))}
        </div>
      </Card>
      <Card title="Tracciabilità temporale">
        <div className="grid gap-3 md:grid-cols-5">
          {tracking.map(([label, date, desc]) => (
            <div
              key={label}
              className="rounded-2xl bg-slate-50/80 p-4 text-xs text-slate-500 ring-1 ring-slate-200/80"
            >
              <p className="font-black uppercase tracking-wide text-fai-navy">
                {label}
              </p>
              <p className="mt-2 text-sm font-semibold text-slate-700">
                {date}
              </p>
              <p className="mt-1 leading-5">{desc}</p>
            </div>
          ))}
        </div>
      </Card>
      <section className="grid gap-5 md:grid-cols-2">
        <Card title="Priorità interne">
          <div className="space-y-3 text-sm leading-7 text-slate-600">
            {[
              "Revisionare gli output AI prima di qualsiasi utilizzo operativo.",
              "Richiamare lead e clienti con prossima azione o attività aperte.",
              "Verificare contratti, incassi e documenti mancanti.",
            ].map((item, index) => (
              <div
                key={item}
                className="flex gap-3 rounded-2xl bg-slate-50/80 p-3 ring-1 ring-slate-200/80"
              >
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-fai-lime/20 text-xs font-black text-fai-green">
                  {index + 1}
                </span>
                <p>{item}</p>
              </div>
            ))}
          </div>
        </Card>
        <Card title="Compliance">
          <p className="text-sm leading-7 text-slate-600">
            Nessun invio automatico al cliente, documenti non pubblici e nessuna
            promessa di risultato. Le fonti non verificate restano da
            controllare su fonte ufficiale.
          </p>
          <div className="mt-5 rounded-2xl bg-fai-purple/5 p-4 text-xs font-bold uppercase tracking-wide text-fai-purple ring-1 ring-fai-purple/10">
            Human review obbligatoria sugli output AI
          </div>
        </Card>
      </section>
    </div>
  );
}
