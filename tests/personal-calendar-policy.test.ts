import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RoleCode } from '@prisma/client';
import type { PermissionSession } from '../src/lib/permission-evaluator';
import { calendarUserId, calendarPilotAllowed, canViewAllCalendars } from '../src/lib/personal-calendar-policy';
import { calendarOAuthConfig } from '../src/lib/google-calendar-oauth';

const pilot = 'calendar-pilot-synthetic', setter = 'calendar-setter-synthetic';
function actor(userId = pilot, role: RoleCode = 'commerciale'): PermissionSession & { userId: string } {
  return { userId, role, active: true, permissionOverrides: [] };
}

test('Calendar identity configuration admits one exact identifier, never CSV, whitespace or a partial match', () => {
  for (const id of [pilot, 'a', '0_A-b', 'a'.repeat(128)]) assert.equal(calendarUserId(id), id);
  for (const id of [undefined, '', ' ', ' pilot', 'pilot ', 'pilot\n', 'pilot,other', 'pilot;other', 'pilot/other',
    'pilot@invalid.test', '*', '-pilot', '_pilot', 'a'.repeat(129), 'Pílota', 'pilot\u0000other']) assert.equal(calendarUserId(id), null);
  let coercions = 0;
  for (const id of [null, true, 17, [pilot], { toString: () => { coercions++; return pilot; } }]) assert.equal(calendarUserId(id), null);
  assert.equal(coercions, 0);
  assert.equal(calendarPilotAllowed(actor(), pilot + '-other'), false);
  assert.equal(calendarPilotAllowed(actor(), 'calendar-pilot'), false);
});

test('Only the active nontechnical commercial pilot can connect, independent of display name or privileged role', () => {
  assert.equal(calendarPilotAllowed(actor(), pilot), true);
  for (const role of ['admin', 'direzione', 'consulente', 'backoffice', 'amministrazione', 'revisore', 'collaboratore_limitato'] as const)
    assert.equal(calendarPilotAllowed(actor(pilot, role), pilot), false, role);
  assert.equal(calendarPilotAllowed(actor('another-commercial'), pilot), false);
  assert.equal(calendarPilotAllowed({ ...actor(), active: false }, pilot), false);
  assert.equal(calendarPilotAllowed({ ...actor(), technicalRestricted: true }, pilot), false);
  assert.equal(calendarPilotAllowed({ ...actor(), permissionOverrides: [{ permission: 'technical.write', allowed: true }] }, pilot), false);
  assert.equal(calendarPilotAllowed({ ...actor(), permissionOverrides: [{ permission: 'lead.read', allowed: false }] }, pilot), false);
  for (const id of [null, undefined, '', pilot + ',other']) assert.equal(calendarPilotAllowed(actor(), id), false);
});

test('All-referent visibility is Admin or the exact Setter; it never grants OAuth or follows a commercial role alone', () => {
  const env = { CALENDAR_SETTER_USER_ID: setter };
  assert.equal(canViewAllCalendars(actor('admin-synthetic', 'admin'), env), true);
  assert.equal(canViewAllCalendars(actor(setter), env), true);
  assert.equal(canViewAllCalendars(actor(pilot), env), false);
  assert.equal(canViewAllCalendars(actor('another-commercial'), env), false);
  assert.equal(canViewAllCalendars(actor(setter, 'consulente'), env), false);
  assert.equal(canViewAllCalendars({ ...actor(setter), active: false }, env), false);
  assert.equal(canViewAllCalendars({ ...actor(setter), technicalRestricted: true }, env), false);
  assert.equal(canViewAllCalendars({ ...actor(setter), permissionOverrides: [{ permission: 'lead.read', allowed: false }] }, env), false);
  assert.equal(canViewAllCalendars({ ...actor('admin-synthetic', 'admin'), permissionOverrides: [{ permission: 'lead.read', allowed: false }] }, env), false);
  assert.equal(calendarPilotAllowed(actor(setter), pilot), false);
  assert.equal(calendarPilotAllowed(actor('admin-synthetic', 'admin'), pilot), false);
  for (const value of [undefined, '', setter + ',other', ' ' + setter]) {
    assert.equal(canViewAllCalendars(actor(setter), { CALENDAR_SETTER_USER_ID: value }), false);
    assert.equal(canViewAllCalendars(actor('admin-synthetic', 'admin'), { CALENDAR_SETTER_USER_ID: value }), true);
  }
});

test('The already enabled integrations gate alone cannot enable Calendar, and a valid pilot ID is mandatory', () => {
  const environment = { FEATURE_INTEGRATIONS_ENABLED: 'true', GOOGLE_CALENDAR_INTEGRATION_MODE: 'enabled',
    GOOGLE_CALENDAR_PILOT_USER_ID: pilot, GOOGLE_CALENDAR_OAUTH_CLIENT_ID: 'synthetic-client',
    GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET: 'synthetic-secret', GOOGLE_CALENDAR_TOKEN_KEY: Buffer.alloc(32, 17).toString('base64'),
    APP_ORIGIN: 'http://localhost:3059', GOOGLE_CALENDAR_OAUTH_REDIRECT_URI: 'http://localhost:3059/settings/integrations/google-calendar/callback' };
  assert.equal(calendarOAuthConfig(environment)?.pilotUserId, pilot);
  for (const mode of [undefined, '', 'disabled', 'shadow'])
    assert.equal(calendarOAuthConfig({ ...environment, GOOGLE_CALENDAR_INTEGRATION_MODE: mode }), null);
  for (const id of [undefined, '', pilot + ',other', ' ' + pilot])
    assert.equal(calendarOAuthConfig({ ...environment, GOOGLE_CALENDAR_PILOT_USER_ID: id }), null);
  assert.equal(calendarOAuthConfig({ ...environment, FEATURE_INTEGRATIONS_ENABLED: 'false' }), null);
  assert.equal(calendarOAuthConfig({ ...environment, GOOGLE_CALENDAR_OAUTH_REDIRECT_URI: 'https://foreign.invalid/callback' }), null);
});
