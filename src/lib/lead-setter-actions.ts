'use server';
import { revalidatePath } from 'next/cache';
import { requirePermission } from './auth';
import { assertTechnicalServerAction } from './technical-server-guards';
import { prisma } from './prisma';
import { CommercialLeadInboxError } from './commercial-lead-inbox-contract';
import { saveSetterCall } from './commercial-lead-inbox';
import { prepareSetterCommand, SetterInputError, type SetterCommand } from './lead-setter-contract';
import { CalendarError, calendarErrorMessage } from './personal-calendar-contract';
import { connectedCalendarAdapter } from './google-calendar-oauth';
import { synchronizeLeadAppointment } from './personal-calendar';
import { leadVisibilityWhere } from './core-query-policy';

export async function saveSetterCallAction(input: SetterCommand) {
  await assertTechnicalServerAction("lead-setter-actions:saveSetterCallAction");
  const actor = await requirePermission('lead.write');
  if (!actor.sessionId) return { ok: false, message: 'Accedi nuovamente per registrare la chiamata.' };
  try {
    const { value } = prepareSetterCommand(input);
    const lead = await prisma.lead.findFirst({ where: { id: value.leadId, assignedToId: actor.userId, deletedAt: null,
      AND: [leadVisibilityWhere(actor)] }, select: { id: true } });
    if (!lead) throw new CalendarError('DENIED');
    // Replaying a committed call only verifies its bound payload in the service.
    // A connection lost afterwards must not hide that existing receipt.
    const prior = await prisma.leadSetterCall.findFirst({ where: { id: value.id, leadId: value.leadId, actorId: actor.userId }, select: { id: true } });
    const calendar = value.appointment ? await prisma.personalCalendar.findUnique({ where: { id: value.appointment.calendarId } }) : null;
    const provider = !prior && calendar?.mode === 'GOOGLE' ? await connectedCalendarAdapter(prisma, calendar.userId) : undefined;
    const receipt = await saveSetterCall(prisma, { userId: actor.userId, sessionId: actor.sessionId }, input, provider);
    let syncPending = false;
    if (receipt.appointmentId) {
      // The call is already committed. A provider failure may not erase it or
      // turn a retry into a second interaction/reservation.
      try {
        const saved = await prisma.leadAppointment.findUniqueOrThrow({ where: { id: receipt.appointmentId }, include: { calendar: true } });
        if (saved.calendar.mode === 'GOOGLE') syncPending = !(await synchronizeLeadAppointment(prisma, actor, saved.id,
          provider ?? await connectedCalendarAdapter(prisma, saved.calendar.userId))).ok;
      } catch { syncPending = true; }
    }
    for (const path of ['/calendars','/dashboard','/leads','/leads/inbox','/leads/work','/notifications','/leads/' + input.leadId]) revalidatePath(path);
    const message = receipt.replay ? 'Chiamata già registrata.' : 'Chiamata e prossimo passo salvati.';
    return { ok: true, message: message + (syncPending ? ' Sincronizzazione da verificare nel riquadro Appuntamento.' : ''), id: receipt.id };
  } catch (error) {
    if (error instanceof CalendarError) return { ok: false, message: calendarErrorMessage(error) + ' La chiamata non è stata salvata: conserva le scelte e correggi l’appuntamento.' };
    if (error instanceof SetterInputError) return { ok: false, message: error.message };
    if (error instanceof CommercialLeadInboxError) return { ok: false, message: 'Verifica il referente, lo storico e la versione corrente della scheda prima di riprendere.' };
    throw error;
  }
}
