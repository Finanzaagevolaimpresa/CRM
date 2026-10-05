import { createHash, createHmac } from 'node:crypto';
import { z } from 'zod';
import { canonicalSha256 } from '../canonical-json';

export const MARKETING_PURPOSE = 'DIRECT_MARKETING' as const;
export const MARKETING_CHANNEL = 'EMAIL' as const;
// Cabina R12/R13 proposal, not a statutory term or an activated runtime policy.
export const PROPOSED_POLICY = Object.freeze({
  version: 'R13_PROPOSED_24_MONTHS_V1', grantMonths: 24, negativeMonths: 24,
  evidenceMonthsAfterEnd: 24, approvalReference: null,
});

const instant = z.string().datetime().refine(value => new Date(value).toISOString() === value);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
export const contactKeySchema = z.string().regex(/^r13-email-v1:[a-f0-9]{64}$/u);
export const eventSchema = z.object({
  eventId: z.string().uuid(), contactKey: contactKeySchema,
  kind: z.enum(['GRANTED', 'DENIED', 'WITHDRAWN', 'SUPPRESSED', 'PURPOSE_CLOSED']),
  occurredAt: instant, source: z.enum(['Q05_RECEIPT', 'PUBLIC_REQUEST', 'AUTHORIZED_OPERATOR', 'PURPOSE_POLICY']),
  operatorRef: z.string().regex(/^[a-zA-Z0-9_-]{1,120}$/u).nullable(),
  outcome: z.enum(['CONSENT_RECORDED', 'PROMOTIONAL_BLOCKED']),
  receiptId: z.string().uuid().nullable(), noticeVersionId: z.string().uuid().nullable(),
  noticeHash: hash.nullable(), canonicalNoticeText: z.string().min(1).max(200_000).nullable(),
}).strict().superRefine((event, ctx) => {
  const choice = event.kind === 'GRANTED' || event.kind === 'DENIED';
  const notice = event.canonicalNoticeText;
  const validChoice = event.source === 'Q05_RECEIPT' && event.operatorRef === null
    && event.receiptId !== null && event.noticeVersionId !== null && notice !== null
    && createHash('sha256').update(notice, 'utf8').digest('hex') === event.noticeHash;
  const validBlock = event.receiptId === null && event.noticeVersionId === null
    && event.noticeHash === null && notice === null && (
      (event.kind === 'SUPPRESSED' && event.source === 'PUBLIC_REQUEST' && event.operatorRef === null)
      || (event.kind === 'WITHDRAWN' && event.source === 'AUTHORIZED_OPERATOR' && event.operatorRef !== null)
      || (event.kind === 'PURPOSE_CLOSED' && event.source === 'PURPOSE_POLICY' && event.operatorRef !== null)
    );
  if (!(choice ? validChoice : validBlock)
    || event.outcome !== (event.kind === 'GRANTED' ? 'CONSENT_RECORDED' : 'PROMOTIONAL_BLOCKED')) {
    ctx.addIssue({ code: 'custom', message: 'MARKETING_EVENT_BINDING_INVALID' });
  }
});
export type PreferenceEvent = z.infer<typeof eventSchema>;
export type StoredEvent = PreferenceEvent & { eventHash: string; recordedAt: string };

export function eventHash(event: PreferenceEvent) {
  return canonicalSha256({ domain: 'fai.marketing-preference.r13.v1', ...eventSchema.parse(event) });
}

export function emailContactKey(email: string, secret: Uint8Array) {
  if (secret.byteLength !== 32) throw new Error('MARKETING_KEY_UNAVAILABLE');
  const canonical = z.string().max(254).email().parse(email.normalize('NFC').trim().toLowerCase());
  return `r13-email-v1:${createHmac('sha256', secret)
    .update(`fai.marketing-preference.r13.v1\n${MARKETING_PURPOSE}\n${MARKETING_CHANNEL}\n${canonical}`)
    .digest('hex')}`;
}

export function addCalendarMonths(value: string, months: number) {
  instant.parse(value);
  if (!Number.isSafeInteger(months) || months < 0 || months > 120) throw new Error('MARKETING_TERM_INVALID');
  const date = new Date(value);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + months);
  const monthEnd = new Date(date);
  monthEnd.setUTCMonth(monthEnd.getUTCMonth() + 1, 0);
  date.setUTCDate(Math.min(day, monthEnd.getUTCDate()));
  return instant.parse(date.toISOString());
}

export type Readiness = Readonly<{
  policyVersion: string; approvalReference: string | null;
  effectiveFrom: string; effectiveUntil: string; checkedAt: string;
  purposeOpen: boolean; reconciled: boolean; epoch: string;
  keyFingerprint: string; maxTicketAgeMs: number;
  approvedEmailNotices: readonly Readonly<{ noticeVersionId: string; contentHash: string }>[];
}>;
export type Snapshot = Readonly<{
  contactKey: string; revision: number; quarantined: boolean; epoch: string | null;
  events: readonly StoredEvent[];
}>;
export type Decision = Readonly<{
  eligible: boolean; reason: string; revision: number; expiresAt: string | null;
}>;

export function validReadiness(readiness: Readiness, now: string) {
  return Boolean(readiness.approvalReference?.trim())
    && readiness.policyVersion === PROPOSED_POLICY.version && readiness.purposeOpen
    && readiness.reconciled && z.string().uuid().safeParse(readiness.epoch).success
    && instant.safeParse(readiness.effectiveFrom).success && instant.safeParse(readiness.effectiveUntil).success
    && readiness.effectiveFrom <= now && now < readiness.effectiveUntil
    && instant.safeParse(readiness.checkedAt).success && readiness.checkedAt <= now
    && new Date(now).getTime() - new Date(readiness.checkedAt).getTime() < 60_000
    && Array.isArray(readiness.approvedEmailNotices) && readiness.approvedEmailNotices.length > 0
    && readiness.approvedEmailNotices.every(notice => z.string().uuid().safeParse(notice.noticeVersionId).success
      && hash.safeParse(notice.contentHash).success)
    && Number.isSafeInteger(readiness.maxTicketAgeMs) && readiness.maxTicketAgeMs > 0
    && readiness.maxTicketAgeMs <= 60_000;
}

/** Rebuild from the complete ledger; never recover eligibility from an expired negative marker. */
export function currentPreference(snapshot: Snapshot, readiness: Readiness, now: string): Decision {
  const deny = (reason: string): Decision => ({ eligible: false, reason, revision: snapshot.revision, expiresAt: null });
  if (!instant.safeParse(now).success || !validReadiness(readiness, now)) return deny('POLICY_OR_RECONCILIATION_UNAVAILABLE');
  if (snapshot.epoch !== readiness.epoch || snapshot.quarantined) return deny('STATE_UNCERTAIN');
  if (!contactKeySchema.safeParse(snapshot.contactKey).success
    || !Number.isSafeInteger(snapshot.revision) || snapshot.revision !== snapshot.events.length) return deny('LEDGER_INCOMPLETE');
  const ids = new Set<string>();
  for (const event of snapshot.events) {
    if (!eventSchema.safeParse(stripStoredFields(event)).success || event.contactKey !== snapshot.contactKey
      || eventHash(stripStoredFields(event)) !== event.eventHash || ids.has(event.eventId)
      || !instant.safeParse(event.recordedAt).success || event.occurredAt > event.recordedAt
      || event.recordedAt > now) return deny('LEDGER_INVALID');
    ids.add(event.eventId);
  }
  // Closing the purpose cannot be undone by a replay or a new grant in the same scope.
  if (snapshot.events.some(event => event.kind === 'PURPOSE_CLOSED')) return deny('PURPOSE_CLOSED');
  const latest = orderedEvents(snapshot.events).at(-1);
  if (!latest) return deny('NO_CURRENT_CONSENT');
  if (latest.kind !== 'GRANTED') return deny(latest.kind);
  if (!readiness.approvedEmailNotices.some(notice => notice.noticeVersionId === latest.noticeVersionId
    && notice.contentHash === latest.noticeHash)) return deny('EMAIL_NOTICE_UNQUALIFIED');
  const expiresAt = addCalendarMonths(latest.occurredAt, PROPOSED_POLICY.grantMonths);
  return now < expiresAt ? { eligible: true, reason: 'CURRENT_EXPLICIT_CONSENT', revision: snapshot.revision, expiresAt }
    : { ...deny('CONSENT_EXPIRED'), expiresAt };
}

export function stripStoredFields(event: StoredEvent): PreferenceEvent {
  const { eventHash: _hash, recordedAt: _recordedAt, ...payload } = event;
  void _hash; void _recordedAt;
  return payload;
}

function orderedEvents(events: readonly PreferenceEvent[]) {
  return [...events].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt)
    || Number(a.kind !== 'GRANTED') - Number(b.kind !== 'GRANTED') || a.eventId.localeCompare(b.eventId));
}

export type EvidenceHold = Readonly<{
  eventIds: readonly string[]; caseReference: string; reason: string; responsibleRole: string;
  reviewAt: string; releaseCondition: string; releasedAt: string | null;
}>;

/** A review plan only: no deletion, anonymisation, scheduler or change to send eligibility. */
export function retentionPlan(events: readonly PreferenceEvent[], holds: readonly EvidenceHold[], now: string) {
  instant.parse(now);
  const ordered = orderedEvents(events.map(event => eventSchema.parse(event)));
  if (new Set(ordered.map(event => event.eventId)).size !== ordered.length
    || new Set(ordered.map(event => event.contactKey)).size > 1
    || ordered.some(event => event.occurredAt > now)) throw new Error('RETENTION_LEDGER_INVALID');
  for (const hold of holds) {
    if (![hold.caseReference, hold.reason, hold.responsibleRole, hold.releaseCondition].every(value => value.trim())
      || !hold.eventIds.length || hold.eventIds.some(id => !ordered.some(event => event.eventId === id))
      || !instant.safeParse(hold.reviewAt).success
      || (hold.releasedAt !== null && (!instant.safeParse(hold.releasedAt).success || hold.releasedAt > now))) {
      throw new Error('RETENTION_HOLD_INVALID');
    }
  }
  return ordered.map((event, index) => {
    let cycleEnd = event.occurredAt;
    if (event.kind === 'GRANTED') {
      const expiry = addCalendarMonths(event.occurredAt, PROPOSED_POLICY.grantMonths);
      const next = ordered[index + 1]?.occurredAt;
      cycleEnd = next && next < expiry ? next : expiry;
      if (ordered.some(row => row.kind === 'PURPOSE_CLOSED' && row.occurredAt <= event.occurredAt)) cycleEnd = event.occurredAt;
    }
    const ordinaryEligibleAt = addCalendarMonths(cycleEnd, event.kind === 'GRANTED'
      ? PROPOSED_POLICY.evidenceMonthsAfterEnd : PROPOSED_POLICY.negativeMonths);
    const active = holds.filter(hold => hold.eventIds.includes(event.eventId) && hold.releasedAt === null);
    return {
      eventId: event.eventId, cycleEnd, ordinaryEligibleAt,
      disposition: active.length ? (active.some(hold => hold.reviewAt <= now) ? 'HOLD_REVIEW_DUE' : 'HELD')
        : now >= ordinaryEligibleAt ? 'ELIGIBLE_FOR_CONTROLLED_REVIEW' : 'RETAIN',
      executable: false as const,
    };
  });
}
