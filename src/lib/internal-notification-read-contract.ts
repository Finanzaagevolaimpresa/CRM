import { z } from 'zod';
import { createHash } from 'node:crypto';

export const notificationSnapshot = z.object({
  id: z.string().min(1).max(220), title: z.string().max(2000), category: z.string().max(200),
  priority: z.enum(['alta', 'media', 'bassa']), date: z.string().datetime().nullable(),
  related: z.string().max(2000).nullable(), href: z.string().regex(/^\/(?![\/\\])[^\\\r\n]*$/).max(1000),
}).strict();

/** A read receipt belongs to a person and an immutable notice identity. Reading
 * one recipient's notice never closes the underlying work or another inbox. */
export function unreadNotifications<T extends { id: string }>(rows: readonly T[], readIds: ReadonlySet<string>): T[] {
  return rows.filter(row => !readIds.has(row.id));
}

export function notificationOccurrenceId(source: string, occurrence: Date | null) {
  return source + '~' + createHash('sha256').update(occurrence?.toISOString() ?? 'none').digest('hex').slice(0, 24);
}
export function notificationSourceId(id: string) { return id.split('~')[0]; }
