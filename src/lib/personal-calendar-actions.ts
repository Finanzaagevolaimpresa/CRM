'use server';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { requirePermission, requireSession } from './auth';
import { prisma } from './prisma';
import { leadVisibilityWhere } from './core-query-policy';
import { assertTechnicalServerAction } from './technical-server-guards';
import { beginGoogleCalendarConnection, connectedCalendarAdapter } from './google-calendar-oauth';
import { appointmentCommandSchema, CalendarError } from './personal-calendar-contract';
import { saveCalendarAvailability, saveLeadAppointment, synchronizeLeadAppointment } from './personal-calendar';

function message(error: unknown) {
  if (!(error instanceof CalendarError)) return 'Salvataggio non confermato. Ricarica la scheda e verifica l’esito prima di riprovare.';
  return { DENIED: 'Calendario o scheda non autorizzati.', STALE: 'La scheda è cambiata. Ricarica e verifica l’appuntamento.',
    BUSY: 'La fascia è occupata. Scegli un altro orario.', OUTSIDE_HOURS: 'Scegli una data futura nelle fasce del referente.',
    INVALID: 'Verifica data, ora di Roma e durata.', UNCONNECTED: 'Google Calendar non è collegato o la connessione richiede verifica.',
    UNCERTAIN: 'Esito Google da riconciliare. Verifica la sincronizzazione prima di riprovare.' }[error.code];
}
export async function saveAvailabilityAction(raw: unknown) {
  await assertTechnicalServerAction('personal-calendar-actions:saveAvailabilityAction');
  const actor = await requireSession();
  try { await saveCalendarAvailability(prisma, actor, raw); revalidatePath('/calendars'); return { ok: true, message: 'Fasce salvate.' }; }
  catch (error) { return { ok: false, message: message(error) }; }
}
export async function connectGoogleCalendarAction() {
  await assertTechnicalServerAction('personal-calendar-actions:connectGoogleCalendarAction');
  const actor = await requireSession();
  let target: string;
  try { target = await beginGoogleCalendarConnection(prisma, actor); }
  catch { redirect('/calendars?connection=unavailable'); }
  redirect(target);
}
export async function saveAppointmentAction(raw: unknown) {
  await assertTechnicalServerAction('personal-calendar-actions:saveAppointmentAction');
  const actor = await requirePermission('lead.write');
  try {
    const input = appointmentCommandSchema.parse(raw);
    const lead = await prisma.lead.findFirst({ where: { id: input.leadId, deletedAt: null, AND: [leadVisibilityWhere(actor)] }, select: { id: true } });
    if (!lead) throw new CalendarError('DENIED');
    const calendar = await prisma.personalCalendar.findUnique({ where: { id: input.calendarId } });
    if (!calendar) throw new CalendarError('DENIED');
    const adapter = calendar.mode === 'GOOGLE' ? await connectedCalendarAdapter(prisma, calendar.userId) : undefined;
    const row = await saveLeadAppointment(prisma, actor, input, adapter);
    const sync = adapter ? await synchronizeLeadAppointment(prisma, actor, row.id, adapter) : null;
    for (const path of ['/calendars', '/dashboard', '/leads/work', '/leads/' + input.leadId]) revalidatePath(path);
    return { ok: true, message: sync && !sync.ok ? 'Appuntamento salvato. Sincronizzazione da verificare nella scheda.' : input.operation === 'CANCEL' ? 'Appuntamento annullato.' : 'Appuntamento salvato.' };
  } catch (error) { return { ok: false, message: message(error) }; }
}
export async function reconcileAppointmentAction(id: string) {
  await assertTechnicalServerAction('personal-calendar-actions:reconcileAppointmentAction');
  const actor = await requirePermission('lead.write');
  try {
    const row = await prisma.leadAppointment.findFirst({ where: { id, lead: { deletedAt: null, AND: [leadVisibilityWhere(actor)] } }, include: { calendar: true } });
    if (!row) throw new CalendarError('DENIED');
    const result = await synchronizeLeadAppointment(prisma, actor, id, await connectedCalendarAdapter(prisma, row.calendar.userId));
    revalidatePath('/calendars'); revalidatePath('/leads/' + row.leadId);
    return { ok: result.ok, message: result.ok ? 'Evento Google riconciliato.' : message(new CalendarError(result.code)) };
  } catch (error) { return { ok: false, message: message(error) }; }
}
