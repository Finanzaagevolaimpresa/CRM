import type { Prisma } from '@prisma/client';
import type { AuthSession } from './auth';
import { leadVisibilityWhere } from './core-query-policy';
import { romeDateTimeInput, resolveRomeDateTime } from './rome-date-time';

export const leadWorkQueues = {
  workday: 'Oggi',
  proposals: 'Proposte da confermare',
  today: 'Entrati oggi', unassigned: 'Da assegnare', contact: 'Assegnati da contattare',
  callbacks: 'Richiami di oggi', overdue: 'Scaduti', videos: 'Videochiamate fissate', missing: 'Assegnati senza prossimo passo',
} as const;
export type LeadWorkQueue = keyof typeof leadWorkQueues;
export function romeWorkDay(now: Date) {
  const localDay = romeDateTimeInput(now).slice(0, 10);
  const following = new Date(Date.parse(localDay + 'T12:00:00Z') + 86_400_000).toISOString().slice(0, 10);
  const start = resolveRomeDateTime(localDay + 'T00:00'), end = resolveRomeDateTime(following + 'T00:00');
  if (start.kind !== 'unique' || end.kind !== 'unique') throw new Error('ROME_WORK_DAY_INVALID');
  return { gte: new Date(start.instants[0]), lt: new Date(end.instants[0]) };
}
export function leadWorkWhere(actor: Parameters<typeof leadVisibilityWhere>[0], queue: LeadWorkQueue, now: Date): Prisma.LeadWhereInput {
  const visible = leadVisibilityWhere(actor), day = romeWorkDay(now);
  if (queue === 'today') return { deletedAt: null, createdAt: day, AND: [visible] };
  const open: Prisma.LeadWhereInput = { clientId: null, status: { notIn: ['archiviato','cliente_acquisito','vinto','perso','non_qualificato'] },
    OR: [{ commercialInboxItem: { is: null } }, { commercialInboxItem: { is: { state: 'OPEN' } } }] };
  const conditions: Prisma.LeadWhereInput[] = [visible, open];
  switch (queue) {
    case 'proposals': conditions.push({ assignmentProposals: { some: { state: 'PENDING' } } }); break;
    case 'workday': conditions.push({ assignedToId: { not: null }, OR: [
      { nextActionDate: { lt: day.lt } },
      { nextActionDate: null, nextAction: { lt: day.lt } },
      { nextActionDate: null, nextAction: null },
    ] }); break;
    case 'unassigned': conditions.push({ assignedToId: null }); break;
    case 'contact':
      conditions.push({ assignedToId: { not: null }, setterCalls: { none: { outcome: { in: ['CONTACT','VIDEO_BOOKED','VIDEO_HELD'] } } },
        NOT: { commercialInboxItem: { is: { OR: [{ historicalContacts: { some: {} } }, { slaCycles: { some: { firstResponseAt: { not: null } } } }] } } } });
      break;
    case 'missing': conditions.push({ assignedToId: { not: null }, nextActionDate: null, nextAction: null,
      OR: [{ nextActionNote: null }, { nextActionNote: '' }] }); break;
    case 'videos': conditions.push({ setterNextKind: 'VIDEO', nextActionDate: { not: null } }); break;
    case 'callbacks': conditions.push({ setterNextKind: 'CALLBACK', nextActionDate: day }); break;
    case 'overdue': conditions.push({ OR: [{ nextActionDate: { lt: day.gte } }, { nextActionDate: null, nextAction: { lt: day.gte } }] }); break;
  }
  return { deletedAt: null, AND: conditions };
}
export function leadWorkHref(queue: LeadWorkQueue) { return '/leads/work?queue=' + queue; }
export async function countLeadWork(db: Pick<Prisma.TransactionClient,'lead'>, actor: AuthSession, now: Date) {
  const queues = Object.keys(leadWorkQueues) as LeadWorkQueue[];
  const counts = await Promise.all(queues.map(queue => db.lead.count({ where: leadWorkWhere(actor, queue, now) })));
  return Object.fromEntries(queues.map((key, index) => [key, counts[index]])) as Record<LeadWorkQueue,number>;
}
