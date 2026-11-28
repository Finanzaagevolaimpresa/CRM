import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import type { AuthSession } from './auth';
import { updateActor } from './record-updates';
import { withSerializableTransaction } from './serializable';
import { currentRecordUpdateUser } from './record-update-context';
import type { PermissionSession } from './permission-evaluator';
import { CalendarError, defaultCalendarAvailability } from './personal-calendar-contract';
import { GoogleCalendarAdapter } from './google-calendar-adapter';
import { environmentFeatureGateEnabled } from './application-security-policy';
import { calendarPilotAllowed, calendarUserId } from './personal-calendar-policy';

const scopes = ['openid', 'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.events.freebusy', 'https://www.googleapis.com/auth/calendar.calendarlist.readonly'];
export type CalendarOAuthConfig = { clientId: string; clientSecret: string; redirectUri: string; key: Buffer; pilotUserId: string };
export function calendarOAuthConfig(environment: Readonly<Record<string, string | undefined>> = process.env): CalendarOAuthConfig | null {
  if (!environmentFeatureGateEnabled('INTEGRATIONS', environment) || environment.GOOGLE_CALENDAR_INTEGRATION_MODE !== 'enabled') return null;
  const clientId = environment.GOOGLE_CALENDAR_OAUTH_CLIENT_ID, clientSecret = environment.GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET,
    redirectUri = environment.GOOGLE_CALENDAR_OAUTH_REDIRECT_URI, encoded = environment.GOOGLE_CALENDAR_TOKEN_KEY,
    pilotUserId = calendarUserId(environment.GOOGLE_CALENDAR_PILOT_USER_ID);
  if (!clientId || !clientSecret || !redirectUri || !encoded || !pilotUserId || !/^[A-Za-z0-9+/]{43}=$/.test(encoded)) return null;
  try {
    const url = new URL(redirectUri), origin = new URL(environment.APP_ORIGIN ?? '');
    if (url.origin !== origin.origin || (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname))
      || url.username || url.password || url.search || url.hash || url.pathname !== '/settings/integrations/google-calendar/callback') return null;
    const key = Buffer.from(encoded, 'base64');
    if (key.length !== 32 || key.toString('base64') !== encoded) return null;
    return { clientId, clientSecret, redirectUri, key, pilotUserId };
  } catch { return null; }
}
export function encryptCalendarSecret(value: string, context: string, key: Buffer) {
  const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from('fai-google-calendar-v1:' + context));
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [nonce, cipher.getAuthTag(), ciphertext].map(part => part.toString('base64url')).join('.');
}
export function decryptCalendarSecret(value: string, context: string, key: Buffer) {
  try {
    const parts = value.split('.');
    if (parts.length !== 3) throw new Error();
    const [nonce, tag, ciphertext] = parts.map(part => Buffer.from(part, 'base64url'));
    if (nonce.length !== 12 || tag.length !== 16) throw new Error();
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAAD(Buffer.from('fai-google-calendar-v1:' + context)); decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch { throw new CalendarError('UNCONNECTED'); }
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
function requireConfig(config: CalendarOAuthConfig | null): CalendarOAuthConfig { if (!config) throw new CalendarError('UNCONNECTED'); return config; }
export function canConnectGoogleCalendar(actor: PermissionSession & { userId: string }, configured = calendarOAuthConfig()) {
  return configured !== null && calendarPilotAllowed(actor, configured.pilotUserId);
}
function admit(actor: PermissionSession & { userId: string }, config: CalendarOAuthConfig) {
  if (!canConnectGoogleCalendar(actor, config)) throw new CalendarError('DENIED');
}
export async function beginGoogleCalendarConnection(db: PrismaClient, claimed: AuthSession, configured = calendarOAuthConfig()) {
  const config = requireConfig(configured), state = randomBytes(32).toString('base64url'), verifier = randomBytes(48).toString('base64url');
  await withSerializableTransaction(db, async tx => {
    const auth = await updateActor(tx, claimed); admit(auth.actor, config);
    await tx.googleCalendarOAuthState.create({ data: { stateHash: digest(state), userId: auth.actor.id, sessionId: auth.registry.id,
      verifierCiphertext: encryptCalendarSecret(verifier, `state:${auth.actor.id}:${auth.registry.id}`, config.key),
      expiresAt: new Date(Date.now() + 10 * 60_000) } });
    await auth.finish();
  });
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({ client_id: config.clientId, redirect_uri: config.redirectUri, response_type: 'code',
    scope: scopes.join(' '), state, code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256', access_type: 'offline', prompt: 'consent', include_granted_scopes: 'false' }).toString();
  return url.toString();
}
const tokenSchema = z.object({ access_token: z.string().min(1).max(8192), refresh_token: z.string().min(1).max(8192).optional(),
  token_type: z.literal('Bearer'), expires_in: z.number().int().min(30).max(86400), scope: z.string().optional() });
async function exchange(config: CalendarOAuthConfig, fields: Record<string, string>, transport: typeof fetch) {
  let result: Response;
  try { result = await transport('https://oauth2.googleapis.com/token', { method: 'POST', redirect: 'error',
    signal: AbortSignal.timeout(10_000), headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, ...fields }), cache: 'no-store' }); }
  catch { throw new CalendarError('UNCERTAIN'); }
  if (!result.ok) throw new CalendarError('UNCONNECTED');
  const parsed = tokenSchema.safeParse(await result.json());
  if (!parsed.success) throw new CalendarError('UNCONNECTED');
  return parsed.data;
}
async function claimCalendarState(db: PrismaClient, claimed: AuthSession, state: string, config: CalendarOAuthConfig) {
  // Commit the single-use claim before exchanging a code. An uncertain exchange
  // requires a new consent, never a blind retry with the same authorization code.
  return withSerializableTransaction(db, async tx => {
    const auth = await updateActor(tx, claimed); admit(auth.actor, config);
    const row = await tx.googleCalendarOAuthState.findUnique({ where: { stateHash: digest(state) } });
    if (!row || row.userId !== auth.actor.id || row.sessionId !== auth.registry.id || row.consumedAt || row.expiresAt <= new Date()) throw new CalendarError('DENIED');
    const consumed = await tx.googleCalendarOAuthState.updateMany({ where: { stateHash: row.stateHash, consumedAt: null }, data: { consumedAt: new Date() } });
    if (consumed.count !== 1) throw new CalendarError('DENIED');
    await auth.finish();
    return decryptCalendarSecret(row.verifierCiphertext, `state:${auth.actor.id}:${auth.registry.id}`, config.key);
  });
}
export async function cancelGoogleCalendarConnection(db: PrismaClient, claimed: AuthSession, rawState: unknown, configured = calendarOAuthConfig()) {
  const config = requireConfig(configured), state = z.string().regex(/^[A-Za-z0-9_-]{43}$/).parse(rawState);
  await claimCalendarState(db, claimed, state, config);
}
export async function completeGoogleCalendarConnection(db: PrismaClient, claimed: AuthSession, raw: unknown,
  configured = calendarOAuthConfig(), transport: typeof fetch = fetch) {
  const config = requireConfig(configured);
  const { state, code } = z.object({ state: z.string().regex(/^[A-Za-z0-9_-]{43}$/), code: z.string().min(1).max(4096) }).strict().parse(raw);
  const verifier = await claimCalendarState(db, claimed, state, config);
  const token = await exchange(config, { code, code_verifier: verifier, redirect_uri: config.redirectUri, grant_type: 'authorization_code' }, transport);
  if (!token.refresh_token || !token.scope || scopes.some(scope => !token.scope!.split(' ').includes(scope))) throw new CalendarError('UNCONNECTED');
  const options: RequestInit = { headers: { Authorization: 'Bearer ' + token.access_token }, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(10_000) };
  const [profileResponse, calendarResponse] = await Promise.all([
    transport('https://openidconnect.googleapis.com/v1/userinfo', options),
    transport('https://www.googleapis.com/calendar/v3/users/me/calendarList/primary', options),
  ]);
  if (!profileResponse.ok || !calendarResponse.ok) throw new CalendarError('UNCONNECTED');
  const profile = z.object({ sub: z.string().min(1).max(255) }).parse(await profileResponse.json());
  const calendar = z.object({ id: z.string().min(1).max(1000), primary: z.literal(true), accessRole: z.enum(['owner', 'writer']) }).parse(await calendarResponse.json());
  return withSerializableTransaction(db, async tx => {
    const auth = await updateActor(tx, claimed); admit(auth.actor, config);
    const existing = await tx.googleCalendarCredential.findUnique({ where: { userId: auth.actor.id } });
    if (existing && existing.googleSubject !== profile.sub) {
      const active = await tx.leadAppointment.count({ where: { calendar: { userId: auth.actor.id },
        OR: [{ status: 'BOOKED' }, { syncState: { in: ['PENDING', 'UNCERTAIN', 'ERROR'] } }] } });
      if (active) throw new CalendarError('STALE');
    }
    const secretData = { googleSubject: profile.sub, accessTokenCiphertext: encryptCalendarSecret(token.access_token, `access:${auth.actor.id}`, config.key),
      refreshTokenCiphertext: encryptCalendarSecret(token.refresh_token!, `refresh:${auth.actor.id}`, config.key),
      expiresAt: new Date(Date.now() + token.expires_in * 1000), scopes: token.scope! };
    await tx.googleCalendarCredential.upsert({ where: { userId: auth.actor.id }, create: { userId: auth.actor.id, ...secretData },
      update: { ...secretData, version: { increment: 1 } } });
    const row = await tx.personalCalendar.upsert({ where: { userId: auth.actor.id },
      create: { userId: auth.actor.id, availability: defaultCalendarAvailability, mode: 'GOOGLE', googleCalendarId: calendar.id,
        credentialReference: 'GOOGLE_CALENDAR:' + auth.actor.id, lastTestAt: new Date(), lastTestStatus: 'CONNECTED' },
      update: { mode: 'GOOGLE', googleCalendarId: calendar.id, credentialReference: 'GOOGLE_CALENDAR:' + auth.actor.id,
        lastTestAt: new Date(), lastTestStatus: 'CONNECTED' } });
    // Existing local appointments remain explicit pending work. Connection does
    // not start a worker or silently send events to the provider.
    await tx.leadAppointment.updateMany({ where: { calendarId: row.id, status: 'BOOKED', syncState: 'LOCAL' },
      data: { syncState: 'PENDING', syncError: null } });
    await tx.auditLog.create({ data: { actorId: auth.actor.id, event: 'google_calendar_connected', entityType: 'PersonalCalendar', entityId: row.id,
      after: { provider: 'GOOGLE', perUser: true } } });
    await auth.finish(); return row.id;
  });
}

/** Tokens are decrypted only on the server and only for a currently admitted
 * calendar owner. The returned adapter remains bound to that exact person. */
export async function connectedCalendarAdapter(db: PrismaClient, userId: string, configured = calendarOAuthConfig(), transport: typeof fetch = fetch) {
  const config = requireConfig(configured);
  if (userId !== config.pilotUserId) throw new CalendarError('DENIED');
  return withSerializableTransaction(db, async tx => {
    await tx.$queryRaw`SELECT "userId" FROM "GoogleCalendarCredential" WHERE "userId"=${userId} FOR UPDATE`;
    const [credential, calendar, user] = await Promise.all([
      tx.googleCalendarCredential.findUnique({ where: { userId } }), tx.personalCalendar.findUnique({ where: { userId } }),
      currentRecordUpdateUser(tx, userId),
    ]);
    if (!credential || !calendar || calendar.mode !== 'GOOGLE' || !calendar.googleCalendarId || !user
      || calendar.credentialReference !== 'GOOGLE_CALENDAR:' + userId) throw new CalendarError('UNCONNECTED');
    admit(user, config);
    let accessToken = decryptCalendarSecret(credential.accessTokenCiphertext, `access:${userId}`, config.key);
    if (credential.expiresAt.getTime() <= Date.now() + 60_000) {
      const token = await exchange(config, { grant_type: 'refresh_token', refresh_token: decryptCalendarSecret(credential.refreshTokenCiphertext, `refresh:${userId}`, config.key) }, transport);
      if (token.scope && scopes.some(scope => !token.scope!.split(' ').includes(scope))) throw new CalendarError('UNCONNECTED');
      accessToken = token.access_token;
      await tx.googleCalendarCredential.update({ where: { userId }, data: {
        accessTokenCiphertext: encryptCalendarSecret(accessToken, `access:${userId}`, config.key),
        ...(token.refresh_token ? { refreshTokenCiphertext: encryptCalendarSecret(token.refresh_token, `refresh:${userId}`, config.key) } : {}),
        expiresAt: new Date(Date.now() + token.expires_in * 1000), version: { increment: 1 },
      } });
    }
    return new GoogleCalendarAdapter({ userId, calendarId: calendar.googleCalendarId, accessToken }, transport);
  }, { timeout: 30_000 });
}
