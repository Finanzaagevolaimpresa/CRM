import type { PermissionSession } from './permission-evaluator';
import { recordUpdatePermission } from './record-update-context';
import { isTechnicalAccount } from './technical-confidentiality';

type CalendarActor = PermissionSession & { userId: string };

/** One stable CRM identity, never a display name, role-wide grant or CSV list. */
export function calendarUserId(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value) ? value : null;
}

export function calendarPilotAllowed(actor: CalendarActor, pilotUserId: string | null | undefined): boolean {
  return calendarUserId(pilotUserId ?? undefined) === actor.userId
    && actor.role === 'commerciale' && !isTechnicalAccount(actor)
    && recordUpdatePermission(actor, 'lead.read');
}

/** Calendar consultation does not grant access to another person's lead data. */
export function canViewAllCalendars(actor: CalendarActor,
  environment: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return !isTechnicalAccount(actor) && recordUpdatePermission(actor, 'lead.read')
    && (actor.role === 'admin' || (actor.role === 'commerciale'
      && calendarUserId(environment.CALENDAR_SETTER_USER_ID) === actor.userId));
}
