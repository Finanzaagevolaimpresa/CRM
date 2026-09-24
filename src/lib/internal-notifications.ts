import { hasPermission, type AuthSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import type { TaskStatus } from "@prisma/client";
import { leadVisibilityWhere } from "./core-query-policy";
import { buildNotificationAccess } from "./internal-notification-policy";

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

export async function getInternalNotifications(session: AuthSession, options?: { limit?: number }) {
  const now = new Date();
  const { startOfToday, endOfToday } = todayBounds(now);
  const limit = options?.limit ?? 100;
  const canReadServices = hasPermission(session, "service.read");
  const canReadTechnical = hasPermission(session, "technical.read");
  const canReadPracticeCommunications = hasPermission(session, "practice_communications.read");
  const canReviewPracticeCommunications = hasPermission(session, "practice_communications.review");
  const canReadLeads = hasPermission(session, "lead.read");
  const leadWhere = leadVisibilityWhere(session);
  // Resolve current ownership before applying preview limits. Communication
  // snapshots and creator/upload provenance never replace current access.
  const [clients, projects, services, practiceContexts, leadContexts] = await Promise.all([
    prisma.client.findMany({ where: { deletedAt: null }, select: { id: true, displayName: true, salesOwnerId: true, consultantId: true, deletedAt: true } }),
    prisma.project.findMany({ where: { deletedAt: null }, select: { id: true, clientId: true, consultantId: true, deletedAt: true } }),
    prisma.clientService.findMany({ where: { deletedAt: null }, select: { id: true, clientId: true, projectId: true, assignedToId: true, deletedAt: true } }),
    prisma.technicalPractice.findMany({ where: { deletedAt: null }, select: { id: true, clientId: true, projectId: true, clientServiceId: true, commercialOwnerId: true, technicalOwnerId: true, deletedAt: true } }),
    prisma.lead.findMany({ where: { deletedAt: null }, select: { id: true, assignedToId: true, clientId: true } }),
  ]);
  const access = buildNotificationAccess(session, { clients, projects, services, practices: practiceContexts, leads: leadContexts });
  const openTaskWhere = { deletedAt: null, status: { in: ["aperta", "in_lavorazione"] as TaskStatus[] }, AND: [access.taskWhere] };

  const [aiAuthorizationNotifications, tasks, communicationsToReview, approvedCommunications, practices, leads, offers] = await Promise.all([
    session.role === "admin"
      ? prisma.aiExecutionAdminNotification.findMany({
          where: {
            recipientAdminId: session.userId,
            isRead: false,
            decidedAt: null,
            request: {
              status: "PENDING_ADMIN_APPROVAL",
              expiresAt: { gt: now },
            },
          },
          include: {
            request: {
              include: {
                requester: { select: { name: true } },
                client: { select: { displayName: true } },
                project: { select: { title: true } },
              },
            },
          },
          orderBy: { createdAt: "asc" },
          take: limit,
        })
      : [],
    canReadServices
      ? prisma.task.findMany({
          where: { ...openTaskWhere, dueAt: { lte: endOfToday } },
          orderBy: [{ dueAt: "asc" }, { createdAt: "asc" }],
          take: limit,
        })
      : [],
    canReviewPracticeCommunications
      ? prisma.practiceCommunication.findMany({
          where: { deletedAt: null, status: "da_revisionare", technicalPracticeId: { in: access.practiceIds } },
          orderBy: { createdAt: "asc" },
          take: limit,
        })
      : [],
    canReadPracticeCommunications
      ? prisma.practiceCommunication.findMany({
          where: { deletedAt: null, status: "approvata", usedAt: null, technicalPracticeId: { in: access.practiceIds } },
          orderBy: { updatedAt: "asc" },
          take: limit,
        })
      : [],
    canReadTechnical
      ? prisma.technicalPractice.findMany({
          where: { deletedAt: null, id: { in: access.practiceIds }, status: { notIn: ["approvata", "respinta", "archiviata"] } },
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
          where: { deletedAt: null, AND: [access.offerWhere], followUpAt: { lte: endOfToday }, status: { notIn: ["accettata", "rifiutata"] } },
          orderBy: { followUpAt: "asc" },
          take: limit,
        })
      : [],
  ]);

  const clientNames = new Map(clients.map((client) => [client.id, client.displayName]));
  const visibleCommunicationsToReview = communicationsToReview.filter(access.canViewCommunication);
  const visibleApprovedCommunications = approvedCommunications.filter(access.canViewCommunication);
  const visiblePractices = practices;
  const visibleOffers = offers.filter(access.canViewOffer);
  const visibleTasks = tasks.filter(access.canViewTask);
  const notifications: InternalNotification[] = [
    ...aiAuthorizationNotifications.map((notification) => ({
      id: `ai-authorization-${notification.id}`,
      title: `${notification.request.functionCode.replaceAll("_", " ")} · ${notification.request.requester?.name ?? "Sistema"}`,
      category: "Autorizzazione AI da decidere",
      priority: notification.priority === "HIGH" || notification.priority === "URGENT" ? "alta" as const : "media" as const,
      date: notification.createdAt,
      related: notification.request.client?.displayName ?? notification.request.project?.title ?? "Richiesta amministrativa",
      href: notification.approvalPath,
    })),
    ...visibleTasks.map((task) => ({
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
