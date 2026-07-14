import type { AuthSession } from "./auth";
import { hasPermission } from "./auth";
import { canViewDocument, canViewTechnicalPractice } from "./access-control";
import { prisma } from "./prisma";

const DISCLAIMER =
  "Documento interno di lavoro. Finanza Agevola Impresa S.r.l. non eroga finanziamenti, non promette contributi e non garantisce esiti o erogazioni. Offre consulenza tecnica, strategica e di orientamento.";
const fmt = (value?: Date | string | null) =>
  value
    ? new Date(value).toLocaleString("it-IT", {
        dateStyle: "short",
        timeStyle: "short",
      })
    : "—";
const clean = (value?: string | null) => value?.replaceAll("_", " ") || "—";
const line = (label: string, value?: string | number | null) =>
  `- **${label}:** ${value ?? "—"}`;
const RAW_PLACEHOLDER_PATTERN =
  /\[(?:NOME_PRATICA|NOME_CLIENTE|DOCUMENTI_MANCANTI|STATO_PRATICA|PROSSIMA_AZIONE)\]/;
const list = <T>(items: T[], render: (item: T) => string) =>
  items.length ? items.map(render).join("\n") : "- Nessun dato presente.";
const safeText = (value?: string | null, fallback = "—") =>
  value?.trim() || fallback;

function renderCommunicationText(
  value: string,
  replacements: Record<string, string>,
) {
  return Object.entries(replacements)
    .reduce(
      (text, [placeholder, replacement]) =>
        text.replaceAll(placeholder, replacement),
      value,
    )
    .replace(/\s+/g, " ")
    .trim();
}

function hasRawPlaceholders(value: string) {
  return RAW_PLACEHOLDER_PATTERN.test(value);
}

function taskBucket(status: string, dueAt?: Date | null) {
  if (status === "completata") return "completati";
  if (dueAt && dueAt < new Date()) return "scaduti";
  return "aperti";
}

export function reportFileName(title: string) {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9-_]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 90) || "report-operativo"
  );
}

export async function buildOperationalReportMarkdown(
  session: AuthSession,
  input: { clientId?: string; technicalPracticeId?: string },
) {
  const practice = input.technicalPracticeId
    ? await prisma.technicalPractice.findUnique({
        where: { id: input.technicalPracticeId },
      })
    : null;
  const clientId = practice?.clientId ?? input.clientId;
  if (!clientId) return null;
  const [client, users] = await Promise.all([
    prisma.client.findUnique({ where: { id: clientId } }),
    prisma.user.findMany({ where: { active: true } }),
  ]);
  if (!client) return null;
  const canReadServices = hasPermission(session, 'service.read');
  const canReadProjects = hasPermission(session, 'project.read');
  const canReadDocuments = hasPermission(session, 'document.download');
  const canReadDossiers = hasPermission(session, 'dossier.read');
  const canReviewAi = hasPermission(session, 'ai.review') || hasPermission(session, 'ai.approve');
  const canReadTechnical = hasPermission(session, 'technical.read');
  const canReadCommunications = hasPermission(session, 'practice_communications.read');
  const canReadAudit = hasPermission(session, 'audit.read');
  const userOf = (id?: string | null) =>
    users.find((u) => u.id === id)?.name ?? (id ? "Utente non attivo" : "—");

  const serviceFilter = practice?.clientServiceId
    ? [{ clientServiceId: practice.clientServiceId }]
    : [];
  const projectFilter = practice?.projectId
    ? [{ projectId: practice.projectId }]
    : [];
  const practiceLinkedFilters = [...serviceFilter, ...projectFilter];
  const scopeWhere = practice
    ? { OR: [{ clientId }, ...practiceLinkedFilters] }
    : { clientId };
  const clientDossierWhere = practice
    ? practiceLinkedFilters.length > 0
      ? { clientId, OR: practiceLinkedFilters }
      : { id: "__no_practice_linked_dossier__" }
    : { clientId };
  const aiOutputWhere = practice
    ? practiceLinkedFilters.length > 0
      ? { OR: practiceLinkedFilters }
      : { id: "__no_practice_linked_ai_output__" }
    : { OR: [{ clientId }] };
  const [services, projects] = await Promise.all([
    canReadServices ? prisma.clientService.findMany({
      where: { clientId, deletedAt: null },
      orderBy: { updatedAt: "desc" },
    }) : Promise.resolve([]),
    canReadProjects ? prisma.project.findMany({
      where: { clientId, deletedAt: null },
      orderBy: { updatedAt: "desc" },
    }) : Promise.resolve([]),
  ]);
  const [
    documents,
    checklist,
    tasks,
    communications,
    clientDossiers,
    aiOutputs,
    audits,
    catalog,
    technicalPractices,
  ] = await Promise.all([
    canReadDocuments ? prisma.document.findMany({
      where: { deletedAt: null, ...scopeWhere },
      orderBy: { createdAt: "desc" },
    }) : Promise.resolve([]),
    canReadServices ? prisma.documentChecklistItem.findMany({
      where: { active: true, deletedAt: null, ...scopeWhere },
      orderBy: { updatedAt: "desc" },
    }) : Promise.resolve([]),
    canReadServices ? prisma.task.findMany({
      where: { deletedAt: null, ...scopeWhere },
      orderBy: [{ status: "asc" }, { dueAt: "asc" }],
    }) : Promise.resolve([]),
    canReadCommunications
      ? prisma.practiceCommunication.findMany({
          where: {
            deletedAt: null,
            ...(practice ? { technicalPracticeId: practice.id } : { clientId }),
          },
          orderBy: { updatedAt: "desc" },
        })
      : Promise.resolve([]),
    canReadDossiers
      ? prisma.clientDossier.findMany({
          where: clientDossierWhere,
          orderBy: { updatedAt: "desc" },
          take: 10,
        })
      : Promise.resolve([]),
    canReviewAi
      ? prisma.aiOutput.findMany({
          where: aiOutputWhere,
          orderBy: { createdAt: "desc" },
          take: 10,
        })
      : Promise.resolve([]),
    canReadAudit
      ? prisma.auditLog.findMany({
          where: practice
            ? { OR: [{ entityId: practice.id }, { entityId: clientId }] }
            : { entityId: clientId },
          orderBy: { createdAt: "desc" },
          take: 20,
        })
      : Promise.resolve([]),
    prisma.serviceCatalog.findMany(),
    canReadTechnical ? prisma.technicalPractice.findMany({
      where: {
        deletedAt: null,
        OR: [
          { clientId },
          ...(services.length
            ? [
                {
                  clientServiceId: {
                    in: services.map((service) => service.id),
                  },
                },
              ]
            : []),
          ...(projects.length
            ? [{ projectId: { in: projects.map((project) => project.id) } }]
            : []),
        ],
      },
      orderBy: [{ dueDate: "asc" }, { updatedAt: "desc" }],
    }) : Promise.resolve([]),
  ]);
  const visibleTechnicalPractices = technicalPractices.filter((item) =>
    canViewTechnicalPractice(session, { ...item, client }),
  );
  const serviceById = new Map(services.map((s) => [s.id, s]));
  const projectById = new Map(projects.map((p) => [p.id, p]));
  const visibleDocuments = hasPermission(session, "document.download")
    ? documents.filter((document) =>
        canViewDocument(
          session,
          {
            ...document,
            client,
            project: document.projectId
              ? { ...projectById.get(document.projectId)!, client }
              : null,
            clientService: document.clientServiceId
              ? serviceById.get(document.clientServiceId)
              : null,
          },
          hasPermission(session, "document.sensitive.read"),
        ),
      )
    : [];
  const serviceName = (id?: string | null) =>
    catalog.find((c) => c.id === serviceById.get(id ?? "")?.serviceCatalogId)
      ?.name ?? "Fascicolo generale";
  const missing = checklist.filter(
    (i) =>
      !i.documentId &&
      !["ricevuto", "validato", "non_necessario"].includes(i.status),
  );
  const title = practice && canReadTechnical
    ? `Report operativo pratica — ${practice.title}`
    : `Fascicolo completo cliente — ${client.displayName}`;
  const dossierAndAiRows = [
    ...clientDossiers.map((d) => ({
      text: `Dossier: ${d.title} · ${clean(d.type)} · ${clean(d.status)} · aggiornato ${fmt(d.updatedAt)}`,
    })),
    ...aiOutputs.map((o) => ({
      text: `Output AI: ${o.title} · ${clean(o.status)} · creato ${fmt(o.createdAt)}`,
    })),
  ];
  const noDossierAiMessage = practice
    ? "- Nessun dossier o output AI collegato direttamente alla pratica."
    : "- Nessun dato presente.";
  const visibleTechnicalPracticeById = new Map(
    visibleTechnicalPractices.map((item) => [item.id, item]),
  );
  const practiceIdentifier = (
    item: (typeof visibleTechnicalPractices)[number],
  ) =>
    item.protocolNumber ? `protocollo ${item.protocolNumber}` : `ID ${item.id}`;
  const linkedToPractice = (
    item: { clientServiceId?: string | null; projectId?: string | null },
    itemPractice: (typeof visibleTechnicalPractices)[number],
  ) =>
    (!!item.clientServiceId &&
      item.clientServiceId === itemPractice.clientServiceId) ||
    (!!item.projectId && item.projectId === itemPractice.projectId);
  const missingForPractice = (
    itemPractice?: (typeof visibleTechnicalPractices)[number],
  ) =>
    itemPractice
      ? missing.filter((item) => linkedToPractice(item, itemPractice))
      : [];
  const nextActionForPractice = (
    itemPractice?: (typeof visibleTechnicalPractices)[number],
  ) => {
    if (!itemPractice) return "prossima azione da verificare";
    const linkedOpenTask = tasks.find(
      (task) =>
        task.status !== "completata" && linkedToPractice(task, itemPractice),
    );
    return (
      itemPractice.integrationRequestNote ??
      itemPractice.clientVisibleStatus ??
      linkedOpenTask?.title ??
      "prossima azione da verificare"
    );
  };
  const communicationReplacements = (
    communication: (typeof communications)[number],
  ) => {
    const itemPractice = communication.technicalPracticeId
      ? visibleTechnicalPracticeById.get(communication.technicalPracticeId)
      : (practice ?? undefined);
    const communicationMissing = missingForPractice(itemPractice);
    return {
      "[NOME_PRATICA]": itemPractice?.title ?? "pratica non verificata",
      "[NOME_CLIENTE]": client.displayName,
      "[DOCUMENTI_MANCANTI]":
        communicationMissing.map((item) => item.title).join(", ") ||
        "documentazione da verificare",
      "[STATO_PRATICA]": itemPractice
        ? clean(itemPractice.status)
        : "stato da verificare",
      "[PROSSIMA_AZIONE]": nextActionForPractice(itemPractice),
    };
  };
  const renderHistoricalCommunicationText = (
    value: string,
    replacements: Record<string, string>,
  ) => {
    const rendered = renderCommunicationText(value, replacements);
    return hasRawPlaceholders(rendered)
      ? "bozza storica da verificare: comunicazione storica con dati non disponibili"
      : rendered;
  };
  const timeline = [
    ...(practice
      ? [
          {
            date: practice.createdAt,
            text: `Pratica tecnica creata: ${practice.title}`,
          },
          {
            date: practice.updatedAt,
            text: `Stato pratica tecnica: ${clean(practice.status)}`,
          },
        ]
      : []),
    ...visibleDocuments.map((d) => ({
      date: d.createdAt,
      text: `Documento caricato: ${d.title} (${clean(d.status)})`,
    })),
    ...tasks.map((t) => ({
      date: t.updatedAt,
      text: `Task: ${t.title} (${clean(t.status)})`,
    })),
    ...communications.map((c) => {
      const replacements = communicationReplacements(c);
      const originalText = `${c.title} ${c.content}`;
      const renderedTitle = renderHistoricalCommunicationText(
        c.title,
        replacements,
      );
      const historicalDraft = hasRawPlaceholders(originalText);
      return {
        date: c.updatedAt,
        text: `Comunicazione: ${renderedTitle} (${clean(c.status)})${historicalDraft ? " · bozza storica da verificare" : ""}`,
      };
    }),
  ]
    .sort((a, b) => +new Date(b.date) - +new Date(a.date))
    .slice(0, 30);
  return {
    title,
    markdown: [
      `# ${title}`,
      `Generato il ${fmt(new Date())}. Report interno per controllo qualità, passaggio operativo e riepilogo pratica.`,
      "",
      "## Dati cliente",
      line("Cliente", client.displayName),
      line("Tipo", client.type),
      line("Stato", clean(client.status)),
      line("Commerciale", userOf(client.salesOwnerId)),
      line("Consulente", userOf(client.consultantId)),
      line("Note", safeText(client.notes)),
      "",
      ...(canReadTechnical ? ["## Pratica tecnica collegata",
      practice
        ? [
            line("Titolo", practice.title),
            line("Tipo pratica", practice.practiceType),
            line("Stato", clean(practice.status)),
            line("Priorità", clean(practice.priority)),
            line("Responsabile tecnico", userOf(practice.technicalOwnerId)),
            line("Owner commerciale", userOf(practice.commercialOwnerId)),
            line(
              "Ente/portale",
              `${practice.targetEntity}${practice.targetPortal ? ` · ${practice.targetPortal}` : ""}`,
            ),
            line("Protocollo", practice.protocolNumber),
            line("Scadenza", fmt(practice.dueDate)),
            line("Stato comunicabile", practice.clientVisibleStatus),
            line("Note interne", practice.internalNotes),
          ].join("\n")
        : list(
            services,
            (s) =>
              `- ${serviceName(s.id)} · stato ${clean(s.status)} · operativo ${clean(s.operationalStatus)} · owner ${userOf(s.assignedToId)}`,
          ),
      ""] : []),
      ...(canReadTechnical && practice
        ? []
        : [
            "",
            "## Pratiche tecniche collegate visibili",
            list(
              visibleTechnicalPractices,
              (item) =>
                `- ${item.title} · tipo ${item.practiceType} · stato ${clean(item.status)} · priorità ${clean(item.priority)} · responsabile ${userOf(item.technicalOwnerId)} · owner ${userOf(item.commercialOwnerId)} · scadenza ${fmt(item.dueDate)} · ${practiceIdentifier(item)}`,
            ),
          ]),
      "",
      "## Timeline operativa sintetica",
      list(timeline, (e) => `- ${fmt(e.date)} — ${e.text}`),
      "",
      ...(canReadDocuments ? ["## Documenti presenti",
      list(
        visibleDocuments,
        (d) =>
          `- ${d.title} · ${clean(d.documentCategory)} · stato ${clean(d.status)} · caricato ${fmt(d.createdAt)}${d.containsSensitiveData ? " · sensibile" : ""}`,
      ),
      ""] : []),
      ...(canReadServices ? ["## Documenti mancanti da checklist",
      list(
        missing,
        (i) =>
          `- ${i.title} · stato ${clean(i.status)} · contesto ${serviceName(i.clientServiceId)} · aggiornato ${fmt(i.updatedAt)}`,
      ),
      ""] : []),
      ...(canReadServices ? ["## Task aperti, scaduti e completati",
      list(
        tasks,
        (t) =>
          `- [${taskBucket(t.status, t.dueAt)}] ${t.title} · priorità ${clean(t.priority)} · scadenza ${fmt(t.dueAt)} · assegnatario ${userOf(t.assignedToId)}`,
      ),
      ""] : []),
      ...(canReadCommunications ? ["## Comunicazioni pratica",
      list(communications, (c) => {
        const originalText = `${c.title} ${c.content}`;
        const historicalDraft = hasRawPlaceholders(originalText);
        const replacements = communicationReplacements(c);
        const renderedTitle = renderCommunicationText(c.title, replacements);
        const renderedContent = renderCommunicationText(
          c.content,
          replacements,
        ).slice(0, 240);
        return `- ${renderedTitle} · ${clean(c.type)}/${clean(c.channel)} · stato ${clean(c.status)} · creata ${fmt(c.createdAt)} · revisione ${fmt(c.reviewedAt)} · uso ${fmt(c.usedAt)}${historicalDraft ? " · bozza storica da verificare" : ""}${c.internalNote ? ` · nota: ${c.internalNote}` : ""} · testo: ${renderedContent}`;
      }),
      ""] : []),
      ...((canReadDossiers || canReviewAi) ? ["## Dossier e output AI autorizzati",
      dossierAndAiRows.length
        ? list(dossierAndAiRows, (x) => `- ${x.text}`)
        : noDossierAiMessage,
      ""] : []),
      ...(canReadAudit
        ? [
            "",
            "## Audit log autorizzato",
            list(
              audits,
              (a) =>
                `- ${fmt(a.createdAt)} · ${clean(a.event)} · ${clean(a.entityType)}`,
            ),
          ]
        : []),
      "",
      "## Nota FAI",
      DISCLAIMER,
    ].join("\n"),
  };
}
