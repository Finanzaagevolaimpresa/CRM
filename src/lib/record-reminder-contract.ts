import { canonicalSha256 } from './canonical-json';
import { RecordUpdateError, parseUpdateSelection, resolveUpdateSelection,
  type UpdateDirectoryPerson, type UpdateSelection } from './record-update-contract';

/** Pure domain rules. The read-only preview adapter supplies locked current
 * source/admission facts. Persistence, native actions and delivery integration
 * are separate; these rules alone do not schedule a notification. */
export const RECORD_REMINDER_PROTOCOL = 'FAI_RECORD_REMINDER_V1' as const;
const kinds = ['CLIENT', 'PROJECT', 'PRACTICE'] as const;
type Kind = typeof kinds[number];
const fail = (code: RecordUpdateError['code']): never => { throw new RecordUpdateError(code); };
function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/u.test(value)) return fail('INVALID');
  return value;
}
function epoch(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 2_147_483_647) return fail('INVALID');
  return Number(value);
}
function digest(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) return fail('INVALID');
  return value;
}
function instant(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return fail('INVALID');
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) return fail('INVALID');
  return value;
}
export type ReminderInput = Readonly<{ commandId: string; kind: Kind; recordId: string; taskId: string;
  remindAt: string; selection: UpdateSelection; mode: 'CRM' }>;
export function parseRecordReminder(value: unknown): ReminderInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('INVALID');
  const v = value as Record<string, unknown>;
  const keys = ['commandId', 'kind', 'recordId', 'taskId', 'remindAt', 'selection', 'mode'];
  if (Object.keys(v).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(v, key))
    || typeof v.commandId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(v.commandId)
    || !kinds.includes(v.kind as Kind) || v.mode !== 'CRM') return fail('INVALID');
  return { commandId: v.commandId, kind: v.kind as Kind, recordId: id(v.recordId), taskId: id(v.taskId),
    remindAt: instant(v.remindAt), selection: parseUpdateSelection(v.selection), mode: 'CRM' };
}
export type ReminderSource = Readonly<{
  kind: Kind; recordId: string; taskId: string; generation: number; scopeGeneration: number;
  dueAt: string; scopeDigest: string; status: 'aperta' | 'in_lavorazione' | 'completata' | 'annullata';
  taskDeleted: boolean; recordDeleted: boolean;
}>;
export type ReminderRecipientAdmission = Readonly<{
  id: string; epoch: number; canReadRecord: boolean; canReadTaskDeadline: boolean;
  accessBinding: string; accessUntil: string | null;
}>;
export type ReminderContext = Readonly<{
  now: string;
  actor: Readonly<{ id: string; epoch: number; sessionId: string; role: string;
    active: boolean; sessionLive: boolean; canWriteRecord: boolean; canReadTaskDeadline: boolean; accessBinding: string }>;
  source: ReminderSource;
  directory: readonly UpdateDirectoryPerson[];
  recipients: readonly ReminderRecipientAdmission[];
  policyExpiresAt: string | null;
}>;
type FrozenSource = Pick<ReminderSource, 'kind' | 'recordId' | 'taskId' | 'generation' | 'scopeGeneration' | 'dueAt' | 'scopeDigest'>;
function sourceSnapshot(source: ReminderSource): FrozenSource {
  if (!kinds.includes(source.kind) || !['aperta', 'in_lavorazione'].includes(source.status)
    || source.taskDeleted || source.recordDeleted) return fail('DENIED');
  const generation = epoch(source.generation), scopeGeneration = epoch(source.scopeGeneration);
  if (scopeGeneration > generation) return fail('INVALID');
  return { kind: source.kind, recordId: id(source.recordId), taskId: id(source.taskId),
    generation, scopeGeneration, dueAt: instant(source.dueAt), scopeDigest: digest(source.scopeDigest) };
}
type Recipient = Readonly<{ id: string; epoch: number; accessBinding: string; accessUntil: string | null }>;
export type PreparedRecordReminder = Readonly<{
  protocol: typeof RECORD_REMINDER_PROTOCOL; input: ReminderInput; source: FrozenSource;
  authorId: string; authorEpoch: number; authorAccessBinding: string; sessionId: string; directoryBinding: string;
  recipients: readonly Recipient[]; excluded: readonly { id: string; reason: 'NO_CURRENT_ACCESS' | 'EXPIRES_BEFORE_REMINDER' }[];
  policyExpiresAt: string | null; summary: { event: 'DEADLINE'; changed: ['dueDate'] };
  eventKey: string; digest: string;
}>;
export function prepareRecordReminder(raw: unknown, context: ReminderContext): PreparedRecordReminder {
  const input = parseRecordReminder(raw), now = instant(context.now), actor = context.actor;
  if (actor.role !== 'admin' || !actor.active || !actor.sessionLive || !actor.canWriteRecord || !actor.canReadTaskDeadline) return fail('DENIED');
  if (Date.parse(input.remindAt) <= Date.parse(now)) return fail('INVALID');
  const source = sourceSnapshot(context.source);
  if (source.kind !== input.kind || source.recordId !== input.recordId || source.taskId !== input.taskId) return fail('STALE');
  const policyExpiresAt = context.policyExpiresAt === null ? null : instant(context.policyExpiresAt);
  if (policyExpiresAt && Date.parse(policyExpiresAt) <= Date.parse(input.remindAt)) return fail('DENIED');
  const resolved = resolveUpdateSelection(input.selection, context.directory);
  const admissions = new Map(context.recipients.map(person => [person.id, person]));
  if (admissions.size !== context.recipients.length) return fail('INVALID');
  const recipients: Recipient[] = [], excluded: Array<{ id: string; reason: 'NO_CURRENT_ACCESS' | 'EXPIRES_BEFORE_REMINDER' }> = [];
  for (const person of resolved.people) {
    const admitted = admissions.get(person.id);
    if (!admitted || !admitted.canReadRecord || !admitted.canReadTaskDeadline) {
      excluded.push({ id: person.id, reason: 'NO_CURRENT_ACCESS' }); continue;
    }
    const accessUntil = admitted.accessUntil === null ? null : instant(admitted.accessUntil);
    if (accessUntil && Date.parse(accessUntil) <= Date.parse(input.remindAt)) {
      excluded.push({ id: person.id, reason: 'EXPIRES_BEFORE_REMINDER' }); continue;
    }
    recipients.push({ id: person.id, epoch: epoch(admitted.epoch), accessBinding: digest(admitted.accessBinding), accessUntil });
  }
  if (!recipients.length) return fail('DENIED');
  const prepared = { protocol: RECORD_REMINDER_PROTOCOL, input, source, authorId: id(actor.id), authorEpoch: epoch(actor.epoch),
    authorAccessBinding: digest(actor.accessBinding),
    sessionId: id(actor.sessionId), directoryBinding: resolved.directoryBinding, recipients, excluded, policyExpiresAt,
    summary: { event: 'DEADLINE' as const, changed: ['dueDate'] as ['dueDate'] }, eventKey: `record-reminder:${input.commandId}` };
  return { ...prepared, digest: canonicalSha256(prepared) };
}
export function assertRecordReminderPreview(expectedDigest: string, fresh: PreparedRecordReminder) {
  if (digest(expectedDigest) !== fresh.digest || canonicalSha256(withoutDigest(fresh)) !== fresh.digest) return fail('STALE');
}
function withoutDigest(prepared: PreparedRecordReminder) {
  const { digest: ignored, ...value } = prepared; void ignored; return value;
}
export type ReminderDeliveryContext = Readonly<{
  now: string; source: ReminderSource; authorId: string; authorEpoch: number; authorAuthorized: boolean; authorAccessBinding: string;
  policyRevoked: boolean; directory: readonly UpdateDirectoryPerson[]; recipient: ReminderRecipientAdmission;
  readAt: string | null;
}>;
export type ReminderAvailability =
  | { state: 'SUPPRESSED'; reason: 'INVALID' | 'SOURCE_CHANGED' | 'REVOKED' | 'DIRECTORY_CHANGED' | 'NO_CURRENT_ACCESS' }
  | { state: 'SCHEDULED'; availableAt: string; emailSent: false }
  | { state: 'AVAILABLE'; availableAt: string; emailSent: false }
  | { state: 'READ'; availableAt: string; readAt: string; emailSent: false };

/** Evaluates availability only. It never marks a notification as read, acquires
 * an authorization, creates delivery work or contacts an external channel. */
export function recordReminderAvailability(prepared: PreparedRecordReminder, context: ReminderDeliveryContext): ReminderAvailability {
  try {
    if (prepared.protocol !== RECORD_REMINDER_PROTOCOL || canonicalSha256(withoutDigest(prepared)) !== prepared.digest) return { state: 'SUPPRESSED', reason: 'INVALID' };
    const now = Date.parse(instant(context.now)), availableAt = instant(prepared.input.remindAt);
    if (!context.authorAuthorized || context.policyRevoked || context.authorId !== prepared.authorId || context.authorEpoch !== prepared.authorEpoch
      || context.authorAccessBinding !== prepared.authorAccessBinding
      || (prepared.policyExpiresAt && Date.parse(prepared.policyExpiresAt) <= now)) return { state: 'SUPPRESSED', reason: 'REVOKED' };
    if (canonicalSha256(sourceSnapshot(context.source)) !== canonicalSha256(prepared.source)) return { state: 'SUPPRESSED', reason: 'SOURCE_CHANGED' };
    if (resolveUpdateSelection(prepared.input.selection, context.directory).directoryBinding !== prepared.directoryBinding) return { state: 'SUPPRESSED', reason: 'DIRECTORY_CHANGED' };
    const current = context.recipient, recipient = prepared.recipients.find(person => person.id === current.id);
    if (!recipient || current.epoch !== recipient.epoch || current.accessBinding !== recipient.accessBinding
      || !current.canReadRecord || !current.canReadTaskDeadline
      || (recipient.accessUntil && Date.parse(recipient.accessUntil) <= now)
      || (current.accessUntil && Date.parse(instant(current.accessUntil)) <= now)) return { state: 'SUPPRESSED', reason: 'NO_CURRENT_ACCESS' };
    const readAt = context.readAt === null ? null : instant(context.readAt);
    if (readAt && (Date.parse(readAt) < Date.parse(availableAt) || Date.parse(readAt) > now)) return { state: 'SUPPRESSED', reason: 'INVALID' };
    if (now < Date.parse(availableAt)) return { state: 'SCHEDULED', availableAt, emailSent: false };
    return readAt ? { state: 'READ', availableAt, readAt, emailSent: false }
      : { state: 'AVAILABLE', availableAt, emailSent: false };
  } catch (error) {
    if (error instanceof RecordUpdateError) return { state: 'SUPPRESSED', reason: error.code === 'DENIED' ? 'SOURCE_CHANGED' : 'INVALID' };
    throw error;
  }
}
