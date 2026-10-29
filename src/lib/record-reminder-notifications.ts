import type { PrismaClient } from '@prisma/client';
import type { AuthSession } from './auth';
import type { PrivilegedStepUpKey } from './privileged-step-up-token';
import { RecordUpdateError } from './record-update-contract';
import { listRecordUpdates, readRecordUpdate } from './record-update-delivery';
import { listRecordReminderNotices, readRecordReminderNotice } from './record-reminder-delivery';

export type SelectedRecordNotice =
  | (NonNullable<Awaited<ReturnType<typeof readRecordUpdate>>> & { noticeKind: 'UPDATE' })
  | (NonNullable<Awaited<ReturnType<typeof readRecordReminderNotice>>> & { noticeKind: 'REMINDER' });

/** One notification surface over the existing delivery queue, retaining the
 * native admission of ordinary updates and the stricter scheduled admission.
 * A missing registered key cannot make a scheduled notice ordinary. */
export async function listSelectedRecordNotices(db: PrismaClient, claimed: AuthSession,
  key: PrivilegedStepUpKey | null, limit = 100, unreadOnly = true) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new RecordUpdateError('INVALID');
  const ordinary = await listRecordUpdates(db, claimed, limit, unreadOnly);
  const reminders = key ? await listRecordReminderNotices(db, claimed, key, limit, unreadOnly) : [];
  const combined: SelectedRecordNotice[] = [...ordinary.map(row => ({ ...row, noticeKind: 'UPDATE' as const })),
    ...reminders.map(row => ({ ...row, noticeKind: 'REMINDER' as const }))];
  return combined.sort((a, b) => b.date.getTime() - a.date.getTime() || b.id.localeCompare(a.id)).slice(0, limit);
}

export async function readSelectedRecordNotice(db: PrismaClient, claimed: AuthSession,
  key: PrivilegedStepUpKey | null, id: string, markRead = false): Promise<SelectedRecordNotice | null> {
  const ordinary = await readRecordUpdate(db, claimed, id, markRead);
  if (ordinary) return { ...ordinary, noticeKind: 'UPDATE' };
  const reminder = key ? await readRecordReminderNotice(db, claimed, key, id, markRead) : null;
  return reminder ? { ...reminder, noticeKind: 'REMINDER' } : null;
}
