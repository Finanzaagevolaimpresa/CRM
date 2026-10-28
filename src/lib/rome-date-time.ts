const zone = 'Europe/Rome';
const parts = new Intl.DateTimeFormat('en-GB', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });

/** A wall-clock representation, not a change to the persisted instant. */
export function romeDateTimeInput(value: Date | string | null | undefined): string {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const p = Object.fromEntries(parts.formatToParts(date).map(part => [part.type, part.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}

export type RomeDateTimeResolution = { kind: 'empty' | 'invalid'; instants: [] }
  | { kind: 'unique'; instants: [string] } | { kind: 'ambiguous'; instants: string[] };

/** Resolve all real instants for a Rome wall time. Gaps and overlaps are never guessed. */
export function resolveRomeDateTime(value: string): RomeDateTimeResolution {
  if (!value) return { kind: 'empty', instants: [] };
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!match) return { kind: 'invalid', instants: [] };
  const [year, month, day, hour, minute, second] = match.slice(1).map(part => Number(part ?? 0));
  if (year < 1900 || year > 9999 || month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59)
    return { kind: 'invalid', instants: [] };
  const wall = Date.UTC(year, month - 1, day, hour, minute, second);
  const normalized = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6] ?? '00'}`;
  if (new Date(wall).toISOString().slice(0, 19) !== normalized) return { kind: 'invalid', instants: [] };
  const offsets = new Set<number>();
  for (const delta of [-36, 0, 36]) {
    const probe = wall + delta * 3_600_000;
    const local = romeDateTimeInput(new Date(probe));
    offsets.add(new Date(local + 'Z').getTime() - probe);
  }
  const instants = [...offsets].map(offset => new Date(wall - offset).toISOString())
    .filter(instant => romeDateTimeInput(instant) === normalized).sort();
  if (!instants.length) return { kind: 'invalid', instants: [] };
  if (instants.length === 1) return { kind: 'unique', instants: [instants[0]] };
  return { kind: 'ambiguous', instants };
}

export function romeOffsetLabel(instant: string): string {
  return new Intl.DateTimeFormat('it-IT', { timeZone: zone, hour: '2-digit', minute: '2-digit',
    timeZoneName: 'longOffset' }).format(new Date(instant));
}
