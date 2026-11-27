import { Card } from './ui';
import { LeadAppointmentForm } from './lead-appointment-form';
import { prisma } from '@/lib/prisma';
import { hasPermission, type AuthSession } from '@/lib/auth';
import { leadVisibilityWhere } from '@/lib/core-query-policy';
import { listBookableCalendars } from '@/lib/personal-calendar';
import { isTechnicalAccount } from '@/lib/technical-confidentiality';

export async function LeadAppointmentPanel({ leadId, actor }: { leadId: string; actor: AuthSession }) {
  if (isTechnicalAccount(actor) || !hasPermission(actor, 'lead.write')) return null;
  const lead = await prisma.lead.findFirst({ where: { id: leadId, deletedAt: null, AND: [leadVisibilityWhere(actor)] },
    select: { id: true, assignedToId: true, updatedAt: true, setterNextKind: true, nextActionDate: true } });
  if (!lead) return null;
  const [appointment, calendars] = await Promise.all([prisma.leadAppointment.findUnique({ where: { leadId } }), listBookableCalendars(prisma, actor)]);
  return <Card title="Appuntamento"><LeadAppointmentForm key={appointment?.version ?? lead.updatedAt.toISOString()} leadId={leadId} leadVersion={lead.updatedAt.toISOString()} assignedToId={lead.assignedToId}
    legacyDate={lead.setterNextKind === 'VIDEO' ? lead.nextActionDate?.toISOString() ?? null : null} calendars={calendars}
    appointment={appointment ? { id: appointment.id, calendarId: appointment.calendarId, version: appointment.version, startsAt: appointment.startsAt.toISOString(),
      endsAt: appointment.endsAt.toISOString(), status: appointment.status, syncState: appointment.syncState, syncError: appointment.syncError } : null} /></Card>;
}
