/** Render an already persisted instant. Never reinterpret it as a local input. */
export function operationalRomeTime(value: Date | string | null | undefined) {
  if (!value) return 'Non disponibile';
  const instant = value instanceof Date ? value : new Date(value);
  return Number.isFinite(instant.getTime()) ? new Intl.DateTimeFormat('it-IT', {
    timeZone: 'Europe/Rome', dateStyle: 'short', timeStyle: 'short',
  }).format(instant) + ' · Europe/Rome' : 'Non disponibile';
}
