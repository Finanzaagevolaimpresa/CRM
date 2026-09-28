import { createHash } from 'node:crypto';
import { eventHash, PROPOSED_POLICY, type Readiness, type Snapshot } from '../../src/lib/marketing-preferences/policy';
import type { PreferenceStore, PreferenceTransaction, VerifiedChoice } from '../../src/lib/marketing-preferences/service';

export const SYNTHETIC_KEY = Buffer.alloc(32, 13);
export const SYNTHETIC_EMAIL = 'recipient@r13.invalid';
export const SYNTHETIC_NOTICE = 'Informativa sintetica R13. Consenso facoltativo email; revoca gratuita.';
export const EPOCH = '13131313-1313-4131-8131-131313131313';
export function id(number: number) { return `13131313-1313-4131-8131-${String(number).padStart(12, '0')}`; }
export function readiness(): Readiness {
  return { policyVersion: PROPOSED_POLICY.version, approvalReference: 'SYNTHETIC_TEST_APPROVAL_ONLY',
    effectiveFrom: '2024-01-01T00:00:00.000Z', effectiveUntil: '2035-01-01T00:00:00.000Z',
    checkedAt: '2026-09-28T10:00:00.000Z',
    purposeOpen: true, reconciled: true, epoch: EPOCH,
    keyFingerprint: createHash('sha256').update(SYNTHETIC_KEY).digest('hex'), maxTicketAgeMs: 60_000,
    approvedEmailNotices: [{ noticeVersionId: id(900), contentHash: createHash('sha256').update(SYNTHETIC_NOTICE).digest('hex') }] };
}
export function choice(number = 1, at = '2026-09-28T10:00:00.000Z', kind: 'GRANTED' | 'DENIED' = 'GRANTED'): VerifiedChoice {
  return { receiptId: id(number), noticeVersionId: id(900),
    noticeHash: createHash('sha256').update(SYNTHETIC_NOTICE).digest('hex'), canonicalNoticeText: SYNTHETIC_NOTICE,
    email: SYNTHETIC_EMAIL, occurredAt: at, kind };
}

/** Transactional test double, not a database qualification. No DATABASE_URL is read. */
export class MemoryPreferenceStore implements PreferenceStore {
  clock = '2026-09-28T10:00:00.000Z';
  epoch: string | null = EPOCH;
  rows = new Map<string, Snapshot>();
  choices = new Map<string, VerifiedChoice>();
  failRead = false;
  failCommit = false;
  beforeCommit: (() => Promise<void>) | null = null;
  private tail: Promise<void> = Promise.resolve();

  async verifiedChoice(receiptId: string, text: string) {
    const row = this.choices.get(receiptId);
    if (!row || row.canonicalNoticeText !== text) throw new Error('SYNTHETIC_RECEIPT_INVALID');
    return row;
  }
  withContact<T>(contactKey: string, operation: (tx: PreferenceTransaction) => Promise<T>): Promise<T> {
    const run = this.tail.then(async () => {
      let state: Snapshot = structuredClone(this.rows.get(contactKey)
        ?? { contactKey, revision: 0, quarantined: false, epoch: this.epoch, events: [] });
      state = { ...state, epoch: this.epoch };
      const result = await operation({
        now: async () => this.clock,
        snapshot: async () => {
          if (this.failRead) throw new Error('SYNTHETIC_READ_FAILURE');
          return structuredClone(state);
        },
        append: async event => { state = { ...state, revision: state.revision + 1,
          events: [...state.events, { ...event, recordedAt: this.clock, eventHash: eventHash(event) }] }; },
        quarantine: async () => { state = { ...state, quarantined: true }; },
      });
      await this.beforeCommit?.();
      if (this.failCommit) throw new Error('SYNTHETIC_COMMIT_FAILURE');
      this.rows.set(contactKey, state);
      return result;
    });
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }
}
