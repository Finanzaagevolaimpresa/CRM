import { currentAssignmentNotices } from './assignment-notices';
import { isTechnicalAccount } from './technical-confidentiality';
import { hasPermission, type AuthSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import type { TaskStatus } from "@prisma/client";
import { leadVisibilityWhere } from "./core-query-policy";
import { buildNotificationAccess } from "./internal-notification-policy";
import { contextOutsideSelection } from './selective-project-policy';
import { companyClientContextOutsideSelection } from './selective-client-policy';
import { listSelectedRecordNotices } from './record-reminder-notifications';
import { loadActivePrivilegedStepUpKey } from './application-key-registry';
import { internalSessionMode } from './session';
import { notificationSnapshot, unreadNotifications, notificationOccurrenceId, notificationSourceId } from './internal-notification-read-contract';
import { readSelectedRecordNotice } from './record-reminder-notifications';
import { romeWorkDay } from './lead-work-queues';
import { readWorkflowInternalNotices } from './workflow-internal-notices';

export type InternalNotification = {
  id: string;
  title: string;
  category: string;
  priority: "alta" | "media" | "bassa";
  date: Date | null;
  related: string | null;
  href: string;
  readAt?: Date | null;
};

function todayBounds(now = new Date()) {
  const bounds = romeWorkDay(now);
  return { startOfToday: bounds.gte, endOfToday: new Date(bounds.lt.getTime() - 1) };
}

async function notificationCandidates(session: AuthSession, includeResolved = false) {
  if (isTechnicalAccount(session)) return [] as InternalNotification[];
  const now = new Date();
  const { startOfToday, endOfToday } = todayBounds(now);
  const limit = 500;
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
    prisma.lead.findMany({ where: { deletedAt: null, AND: [leadVisibilityWhere(session)] }, select: { id: true, assignedToId: true, clientId: true } }),
  ]);
  const access = buildNotificationAccess(session, { clients, projects, services, practices: practiceContexts, leads: leadContexts });
  const openTaskWhere = { technicalPrivate: false, deletedAt: null, ...(includeResolved ? {} : { status: { in: ["aperta", "in_lavorazione"] as TaskStatus[] } }), AND: [access.taskWhere] };

  const [aiAuthorizationNotifications, tasks, communicationsToReview, approvedCommunications, practices, leads, offers] = await Promise.all([
    session.role === "admin"
      ? prisma.aiExecutionAdminNotification.findMany({
          where: {
            recipientAdminId: session.userId,
            ...(includeResolved ? {} : { isRead: false, decidedAt: null }),
            request: {
              AND: [contextOutsideSelection(session), companyClientContextOutsideSelection(session)],
              ...(includeResolved ? {} : { status: "PENDING_ADMIN_APPROVAL", expiresAt: { gt: now } }),
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
        })
      : [],
    canReadServices
      ? prisma.task.findMany({
          where: { ...openTaskWhere, ...(includeResolved ? {} : { dueAt: { lte: endOfToday } }) },
          orderBy: [{ dueAt: "asc" }, { createdAt: "asc" }],
        })
      : [],
    canReviewPracticeCommunications
      ? prisma.practiceCommunication.findMany({
          where: { deletedAt: null, ...(includeResolved ? {} : { status: "da_revisionare" }), technicalPracticeId: { in: access.practiceIds } },
          orderBy: { createdAt: "asc" },
        })
      : [],
    canReadPracticeCommunications
      ? prisma.practiceCommunication.findMany({
          where: { deletedAt: null, ...(includeResolved ? {} : { status: "approvata", usedAt: null }), technicalPracticeId: { in: access.practiceIds } },
          orderBy: { updatedAt: "asc" },
        })
      : [],
    canReadTechnical
      ? prisma.technicalPractice.findMany({
          where: { deletedAt: null, id: { in: access.practiceIds }, ...(includeResolved ? {} : { status: { notIn: ["approvata", "respinta", "archiviata"] } }) },
          orderBy: [{ dueDate: "asc" }, { updatedAt: "desc" }],
        })
      : [],
    canReadLeads
      ? prisma.lead.findMany({
          where: { deletedAt: null, ...leadWhere, ...(includeResolved ? {} : { nextActionDate: { lte: endOfToday }, status: { notIn: ["vinto", "perso", "archiviato", "cliente_acquisito", "non_qualificato"] } }) },
          orderBy: { nextActionDate: "asc" },
        })
      : [],
    canReadLeads
      ? prisma.commercialOffer.findMany({
          where: { deletedAt: null, AND: [access.offerWhere], ...(includeResolved ? {} : { followUpAt: { lte: endOfToday }, status: { notIn: ["accettata", "rifiutata"] } }) },
          orderBy: { followUpAt: "asc" },
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
    ...await currentAssignmentNotices(session,Number.MAX_SAFE_INTEGER,includeResolved),
    ...aiAuthorizationNotifications.map((notification) => ({
      id: `ai-authorization-${notification.id}`,
      title: `${notification.request.functionCode.replaceAll("_", " ")} · ${notification.request.requester?.name ?? "Sistema"}`,
      category: "Autorizzazione AI da decidere",
      priority: notification.priority === "HIGH" || notification.priority === "URGENT" ? "alta" as const : "media" as const,
      date: notification.createdAt,
      related: notification.request.client?.displayName ?? notification.request.project?.title ?? "Richiesta amministrativa",
      href: notification.approvalPath,
      readAt: notification.isRead ? notification.createdAt : null,
    })),
    ...visibleTasks.map((task) => ({
      id: notificationOccurrenceId(`task-${task.id}`, task.dueAt),
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
  if (internalSessionMode() === 'registry' && session.sessionId) {
    notifications.push(...await readWorkflowInternalNotices(session, Number.MAX_SAFE_INTEGER, includeResolved));
    const updates = await listSelectedRecordNotices(prisma, session, await loadActivePrivilegedStepUpKey(prisma), limit, !includeResolved, true);
    notifications.push(...updates.map(row => ({ id: `record-update-${row.id}`, title: row.title,
      category: row.category, related: row.related, date: row.date, priority: row.priority, href: row.href, readAt: row.readAt })));
  }
  return notifications.map(row => ['lead-', 'offer-'].some(prefix => row.id.startsWith(prefix) && !row.id.startsWith('lead-selection-'))
    ? { ...row, id: notificationOccurrenceId(row.id, row.date) } : row)
    .sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority] || (a.date?.getTime() ?? 0) - (b.date?.getTime() ?? 0));
}

export async function getInternalNotifications(session: AuthSession, options?: { limit?: number; state?: 'active' | 'read' }) {
  const read = options?.state === 'read';
  const [candidates, receipts] = await Promise.all([
    notificationCandidates(session, read),
    prisma.internalNotificationRead.findMany({ where: { recipientId: session.userId }, orderBy: [{ readAt: 'desc' }, { id: 'desc' }] }),
  ]);
  if (!read) {
    const rows = unreadNotifications(candidates, new Set(receipts.map(row => row.notificationId)));
    return options?.limit ? rows.slice(0, options.limit) : rows;
  }
  // Retain the read identity after its queue is completed. Current authorization
  // and current labels are recalculated, including after a relationship changes.
  const admitted = new Map(candidates.map(row => [notificationSourceId(row.id), row]));
  const rows: InternalNotification[] = candidates.filter(row => row.readAt);
  for (const receipt of receipts) {
    const parsed = notificationSnapshot.safeParse(receipt.snapshot);
    const current = admitted.get(notificationSourceId(receipt.notificationId));
    if (!parsed.success || parsed.data.id !== receipt.notificationId || !current) continue;
    // The receipt is historical; labels and links follow today's authorized
    // context. A task moved between clients cannot reveal its old private label.
    if (!rows.some(row => row.id === parsed.data.id)) rows.push({ ...current, id: parsed.data.id,
      date: parsed.data.date ? new Date(parsed.data.date) : null, readAt: receipt.readAt });
  }
  return options?.limit ? rows.slice(0, options.limit) : rows;
}

export async function markInternalNotificationRead(session: AuthSession, id: string) {
  // Neither the destination nor the recipient are accepted from the browser.
  const prior = await prisma.internalNotificationRead.findUnique({ where: { recipientId_notificationId: { recipientId: session.userId, notificationId: id } } });
  const nativeRead = !prior && id.startsWith('record-update-') ? await readSelectedRecordNotice(prisma, session,
    await loadActivePrivilegedStepUpKey(prisma), id.slice('record-update-'.length), false) : null;
  const nativeAi = id.startsWith('ai-authorization-');
  const candidates = await notificationCandidates(session, Boolean(prior || nativeRead?.readAt || nativeAi));
  let notice = candidates.find(row => row.id === id);
  if (!prior && nativeAi && !notice?.readAt) notice = (await notificationCandidates(session)).find(row => row.id === id);
  if (!notice) {
    const parsed = notificationSnapshot.safeParse(prior?.snapshot);
    const current = candidates.find(row => notificationSourceId(row.id) === notificationSourceId(id));
    if (parsed.success && parsed.data.id === id && current) notice = { ...current, id };
  }
  if (!notice) return null;
  if (id.startsWith('record-update-')) {
    const selected = await readSelectedRecordNotice(prisma, session, await loadActivePrivilegedStepUpKey(prisma), id.slice('record-update-'.length), true);
    if (!selected) return null;
  }
  const snapshot = notificationSnapshot.parse({ id: notice.id, title: notice.title, category: notice.category,
    priority: notice.priority, date: notice.date?.toISOString() ?? null, related: notice.related, href: notice.href });
  await prisma.internalNotificationRead.upsert({
    where: { recipientId_notificationId: { recipientId: session.userId, notificationId: id } },
    create: { recipientId: session.userId, notificationId: id, snapshot }, update: {},
  });
  return notice;
}

export async function getInternalNotificationCount(session: AuthSession) {
  return (await getInternalNotifications(session)).length;
}
