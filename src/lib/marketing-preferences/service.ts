import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  contactKeySchema, currentPreference, emailContactKey, eventHash, eventSchema, stripStoredFields,
  type Decision, type PreferenceEvent, type Readiness, type Snapshot, type StoredEvent,
} from './policy';

export type VerifiedChoice = Readonly<{
  receiptId: string; noticeVersionId: string; noticeHash: string; canonicalNoticeText: string;
  email: string; occurredAt: string; kind: 'GRANTED' | 'DENIED';
}>;
export interface PreferenceTransaction {
  now(): Promise<string>;
  snapshot(): Promise<Snapshot>;
  append(event: PreferenceEvent): Promise<void>;
  quarantine(): Promise<void>;
}
export interface PreferenceStore {
  // Must verify the immutable source envelope, receipt and notice before returning a choice.
  verifiedChoice(receiptId: string, canonicalNoticeText: string): Promise<VerifiedChoice>;
  // Lock this contact across the full callback, including a final handoff. No automatic retries.
  withContact<T>(contactKey: string, operation: (tx: PreferenceTransaction) => Promise<T>): Promise<T>;
}
export type SelectionTicket = Readonly<{
  contactKey: string; revision: number; epoch: string; policyVersion: string;
  selectedAt: string; expiresAt: string;
}>;
export type AppendResult = 'RECORDED' | 'REPLAY' | 'CONFLICT';

export class MarketingPreferences {
  private readonly key: Buffer;
  constructor(
    private readonly store: PreferenceStore,
    key: Uint8Array,
    // Fresh external attestation of complete intake/withdrawal reconciliation at both
    // boundaries, not a cached DB flag. Restored or unqualified runtimes return null.
    private readonly readiness: () => Promise<Readiness | null>,
  ) {
    if (key.byteLength !== 32) throw new Error('MARKETING_KEY_UNAVAILABLE');
    this.key = Buffer.from(key);
  }

  private async checkedReadiness() {
    const ready = await this.readiness();
    return ready?.keyFingerprint === createHash('sha256').update(this.key).digest('hex') ? ready : null;
  }

  /** No caller-supplied email, decision or time can turn into a consent receipt. */
  async recordChoice(receiptId: string, canonicalNoticeText: string): Promise<AppendResult> {
    z.string().uuid().parse(receiptId);
    z.string().min(1).max(200_000).parse(canonicalNoticeText);
    const choice = await this.store.verifiedChoice(receiptId, canonicalNoticeText);
    if (choice.receiptId !== receiptId || choice.canonicalNoticeText !== canonicalNoticeText) {
      throw new Error('MARKETING_RECEIPT_BINDING_INVALID');
    }
    const contactKey = emailContactKey(choice.email, this.key);
    return this.store.withContact(contactKey, async tx => this.append(tx, {
      contactKey, eventId: receiptId, kind: choice.kind, occurredAt: choice.occurredAt,
      source: 'Q05_RECEIPT', operatorRef: null,
      outcome: choice.kind === 'GRANTED' ? 'CONSENT_RECORDED' : 'PROMOTIONAL_BLOCKED',
      receiptId, noticeVersionId: choice.noticeVersionId, noticeHash: choice.noticeHash, canonicalNoticeText,
    }));
  }

  /** An anonymous request is a precautionary block, never an authenticated identity claim. */
  async suppressPublic(email: string, eventId: string): Promise<AppendResult> {
    z.string().uuid().parse(eventId);
    const contactKey = emailContactKey(email, this.key);
    return this.store.withContact(contactKey, async tx => {
      const existing = (await tx.snapshot()).events.find(event => event.eventId === eventId);
      // A retry retains the original server time and cannot renew its retention period.
      const occurredAt = existing?.kind === 'SUPPRESSED' ? existing.occurredAt : await tx.now();
      return this.append(tx, {
        contactKey, eventId, kind: 'SUPPRESSED', occurredAt, source: 'PUBLIC_REQUEST', operatorRef: null,
        outcome: 'PROMOTIONAL_BLOCKED', receiptId: null, noticeVersionId: null,
        noticeHash: null, canonicalNoticeText: null,
      });
    });
  }

  /** Internal adapter only: its caller must authenticate and authorize the actual operator. */
  async recordOperatorBlock(input: Readonly<{
    email: string; eventId: string; kind: 'WITHDRAWN' | 'PURPOSE_CLOSED'; operatorRef: string;
  }>): Promise<AppendResult> {
    const contactKey = emailContactKey(input.email, this.key);
    return this.store.withContact(contactKey, async tx => {
      const existing = (await tx.snapshot()).events.find(event => event.eventId === input.eventId);
      return this.append(tx, {
        contactKey, eventId: input.eventId, kind: input.kind,
        occurredAt: existing?.kind === input.kind ? existing.occurredAt : await tx.now(),
        source: input.kind === 'WITHDRAWN' ? 'AUTHORIZED_OPERATOR' : 'PURPOSE_POLICY',
        operatorRef: input.operatorRef, outcome: 'PROMOTIONAL_BLOCKED',
        receiptId: null, noticeVersionId: null, noticeHash: null, canonicalNoticeText: null,
      });
    });
  }

  private async append(tx: PreferenceTransaction, input: PreferenceEvent): Promise<AppendResult> {
    const event = eventSchema.parse(input);
    const now = await tx.now();
    const snapshot = await tx.snapshot();
    if (snapshot.contactKey !== event.contactKey) throw new Error('MARKETING_CONTACT_MISMATCH');
    const previous = snapshot.events.find(row => row.eventId === event.eventId);
    if (previous) {
      if (previous.eventHash === eventHash(event) && eventHash(stripStoredFields(previous)) === previous.eventHash) return 'REPLAY';
      // Commit the quarantine; throwing here would roll it back and leave old consent eligible.
      await tx.quarantine();
      return 'CONFLICT';
    }
    if (event.occurredAt > now) {
      await tx.quarantine();
      return 'CONFLICT';
    }
    await tx.append(event);
    return 'RECORDED';
  }

  async select(email: string): Promise<{ decision: Decision; ticket: SelectionTicket | null }> {
    const contactKey = emailContactKey(email, this.key);
    try {
      return await this.store.withContact(contactKey, async tx => {
        const ready = await this.checkedReadiness();
        const snapshot = await tx.snapshot();
        const now = await tx.now();
        const decision = ready ? currentPreference(snapshot, ready, now)
          : { eligible: false, reason: 'RUNTIME_UNQUALIFIED', revision: snapshot.revision, expiresAt: null };
        return { decision, ticket: ready && decision.eligible && decision.expiresAt ? {
          contactKey, revision: snapshot.revision, epoch: ready.epoch, policyVersion: ready.policyVersion,
          selectedAt: now, expiresAt: decision.expiresAt,
        } : null };
      });
    } catch {
      return { decision: { eligible: false, reason: 'STATE_UNAVAILABLE', revision: 0, expiresAt: null }, ticket: null };
    }
  }

  /**
   * The final boundary for a FUTURE qualified sender, including queued messages.
   * No provider is composed here. Hold the contact lock until handoff completes;
   * never retry this callback automatically after an ambiguous transport outcome.
   */
  async atFinalHandoff<T>(email: string, ticket: SelectionTicket, handoff: () => Promise<T>): Promise<
    { admitted: true; value: T } | { admitted: false; reason: string }
  > {
    if (!contactKeySchema.safeParse(ticket.contactKey).success) return { admitted: false, reason: 'TICKET_INVALID' };
    let handoffStarted = false;
    try {
      if (emailContactKey(email, this.key) !== ticket.contactKey) return { admitted: false, reason: 'RECIPIENT_MISMATCH' };
      return await this.store.withContact(ticket.contactKey, async tx => {
        const ready = await this.checkedReadiness();
        const snapshot = await tx.snapshot();
        const now = await tx.now();
        const age = new Date(now).getTime() - new Date(ticket.selectedAt).getTime();
        if (!ready || !Number.isFinite(age) || age < 0 || age >= ready.maxTicketAgeMs
          || ticket.epoch !== ready.epoch || ticket.policyVersion !== ready.policyVersion
          || ticket.revision !== snapshot.revision) return { admitted: false as const, reason: 'STALE_SELECTION' };
        const decision = currentPreference(snapshot, ready, now);
        if (!decision.eligible || decision.expiresAt !== ticket.expiresAt) {
          return { admitted: false as const, reason: decision.reason };
        }
        handoffStarted = true;
        return { admitted: true as const, value: await handoff() };
      });
    } catch {
      if (handoffStarted) throw new Error('MARKETING_HANDOFF_OUTCOME_UNCERTAIN_DO_NOT_RETRY');
      return { admitted: false, reason: 'STATE_UNAVAILABLE' };
    }
  }
}

export type { StoredEvent };
