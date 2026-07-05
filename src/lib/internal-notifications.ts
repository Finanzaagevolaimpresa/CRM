import { hasPermission, type AuthSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import type { TaskStatus } from "@prisma/client";

export type InternalNotification = {
  id: string;
  title: string;
  category: string;
  priority: "alta" | "media" | "bassa";
  date: Date | null;
  related: string | null;
  href: string;
};

function todayBounds(now = new Date()) {
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const endOfToday = new Date(now);
  endOfToday.setHours(23, 59, 59, 999);
  return { startOfToday, endOfToday };
}

function taskAccessWhere(session: AuthSession) {
  const canSeeAllTasks = ["admin", "direzione", "revisore", "backoffice"].includes(session.role);
  return {
    deletedAt: null,
    status: { in: ["aperta", "in_lavorazione"] as TaskStatus[] },
    ...(canSeeAllTasks ? {} : { OR: [{ assignedToId: session.userId }, { createdById: session.userId }] }),
  };
}

function leadAccessWhere(session: AuthSession) {
  return session.role === "admin" || session.role === "direzione"
    ? {}
    : { OR: [{ assignedToId: null }, { assignedToId: session.userId }] };
}

export async function getInternalNotifications(session: AuthSession, options?: { limit?: number }) {
  const now = new Date();
  const { startOfToday, endOfToday } = todayBounds(now);
  const limit = options?.limit ?? 100;
  const canReadServices = hasPermission(session, "service.read");
  const canReadTechnical = hasPermission(session, "technical.read");
  const canReadPracticeCommunications = hasPermission(session, "practice_communications.read");
  const canReviewPracticeCommunications = hasPermission(session, "practice_communications.review");
  const canReadLeads = hasPermission(session, "lead.read");
  const openTaskWhere = taskAccessWhere(session);
  const leadWhere = leadAccessWhere(session);

  const [tasks, communicationsToReview, approvedCommunications, practices, leads, offers, clients] = await Promise.all([
    canReadServices
      ? prisma.task.findMany({
          where: { ...openTaskWhere, dueAt: { lte: endOfToday } },
          orderBy: [{ dueAt: "asc" }, { createdAt: "asc" }],
          take: limit,
        })
      : [],
    canReviewPracticeCommunications
      ? prisma.practiceCommunication.findMany({
          where: { deletedAt: null, status: "da_revisionare" },
          orderBy: { createdAt: "asc" },
          take: limit,
        })
      : [],
    canReadPracticeCommunications
      ? prisma.practiceCommunication.findMany({
          where: { deletedAt: null, status: "approvata", usedAt: null },
          orderBy: { updatedAt: "asc" },
          take: limit,
        })
      : [],
    canReadTechnical
      ? prisma.technicalPractice.findMany({
          where: { deletedAt: null, status: { notIn: ["approvata", "respinta", "archiviata"] } },
          orderBy: [{ dueDate: "asc" }, { updatedAt: "desc" }],
          take: limit,
        })
      : [],
    canReadLeads
      ? prisma.lead.findMany({
          where: { deletedAt: null, ...leadWhere, nextActionDate: { lte: endOfToday }, status: { notIn: ["vinto", "perso", "archiviato", "cliente_acquisito"] } },
          orderBy: { nextActionDate: "asc" },
          take: limit,
        })
      : [],
    canReadLeads
      ? prisma.commercialOffer.findMany({
          where: { deletedAt: null, followUpAt: { lte: endOfToday }, status: { notIn: ["accettata", "rifiutata"] } },
          orderBy: { followUpAt: "asc" },
          take: limit,
        })
      : [],
    prisma.client.findMany({ where: { deletedAt: null }, select: { id: true, displayName: true, salesOwnerId: true, consultantId: true } }),
  ]);

  const clientNames = new Map(clients.map((client) => [client.id, client.displayName]));
  const clientAccess = new Map(
    clients.map((client) => [
      client.id,
      session.role === "admin" ||
        session.role === "direzione" ||
        ["revisore", "backoffice", "amministrazione"].includes(session.role) ||
        client.salesOwnerId === session.userId ||
        client.consultantId === session.userId,
    ]),
  );
  const canSeeByOwnership = (item: { clientId?: string | null; commercialOwnerId?: string | null; technicalOwnerId?: string | null; createdById?: string | null }) =>
    session.role === "admin" ||
    session.role === "direzione" ||
    ["revisore", "backoffice", "amministrazione"].includes(session.role) ||
    item.commercialOwnerId === session.userId ||
    item.technicalOwnerId === session.userId ||
    item.createdById === session.userId ||
    (!!item.clientId && clientAccess.get(item.clientId));
  const visibleCommunicationsToReview = communicationsToReview.filter(canSeeByOwnership);
  const visibleApprovedCommunications = approvedCommunications.filter(canSeeByOwnership);
  const visiblePractices = practices.filter(canSeeByOwnership);
  const visibleOffers = offers.filter(canSeeByOwnership);
  const notifications: InternalNotification[] = [
    ...tasks.map((task) => ({
      id: `task-${task.id}`,
      title: task.title,
      category: task.dueAt && task.dueAt < startOfToday ? "Task scaduto" : "Task in scadenza oggi",
      priority: task.dueAt && task.dueAt < startOfToday ? "alta" as const : "media" as const,
      date: task.dueAt,
      related: task.clientId ? clientNames.get(task.clientId) ?? null : null,
      href: "/tasks",
    })),
    ...visibleCommunicationsToReview.map((communication) => ({ id: `communication-review-${communication.id}`, title: communication.title, category: "Comunicazione da approvare", priority: "alta" as const, date: communication.createdAt, related: clientNames.get(communication.clientId) ?? null, href: `/technical-office/practices/${communication.technicalPracticeId}` })),
    ...visibleApprovedCommunications.map((communication) => ({ id: `communication-approved-${communication.id}`, title: communication.title, category: "Comunicazione approvata da usare", priority: "media" as const, date: communication.updatedAt, related: clientNames.get(communication.clientId) ?? null, href: `/technical-office/practices/${communication.technicalPracticeId}` })),
    ...visiblePractices.map((practice) => ({ id: `practice-${practice.id}`, title: practice.title, category: "Pratica tecnica da lavorare", priority: practice.priority === "alta" || (practice.dueDate && practice.dueDate < startOfToday) ? "alta" as const : practice.priority === "bassa" ? "bassa" as const : "media" as const, date: practice.dueDate ?? practice.updatedAt, related: clientNames.get(practice.clientId) ?? null, href: `/technical-office/practices/${practice.id}` })),
    ...leads.map((lead) => ({ id: `lead-${lead.id}`, title: lead.companyName ?? `${lead.firstName} ${lead.lastName}`, category: "Follow-up commerciale lead", priority: lead.nextActionDate && lead.nextActionDate < startOfToday ? "alta" as const : "media" as const, date: lead.nextActionDate, related: lead.clientId ? clientNames.get(lead.clientId) ?? null : null, href: `/leads/${lead.id}` })),
    ...visibleOffers.map((offer) => ({ id: `offer-${offer.id}`, title: offer.title, category: "Follow-up commerciale offerta", priority: offer.followUpAt && offer.followUpAt < startOfToday ? "alta" as const : "media" as const, date: offer.followUpAt, related: offer.clientId ? clientNames.get(offer.clientId) ?? null : null, href: `/commercial-offers/${offer.id}` })),
  ];

  const priorityOrder = { alta: 0, media: 1, bassa: 2 };
  return notifications.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority] || (a.date?.getTime() ?? 0) - (b.date?.getTime() ?? 0)).slice(0, limit);
}

export async function getInternalNotificationCount(session: AuthSession) {
  return (await getInternalNotifications(session, { limit: 500 })).length;
}
