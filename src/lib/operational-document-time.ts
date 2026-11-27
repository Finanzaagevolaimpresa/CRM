import { resolveRomeDateTime } from './rome-date-time';

export class OperationalArchiveTimeError extends Error {
  constructor(readonly code: 'INVALID' | 'AMBIGUOUS') {
    super(code === 'AMBIGUOUS'
      ? 'L’ora si ripete al cambio dell’ora legale: scegli l’occorrenza effettiva in Europe/Rome.'
      : 'Verifica data e ora in Europe/Rome: l’orario indicato non esiste o non è valido.');
  }
}

/** A local form value is never interpreted using the process/browser timezone. */
export function resolveProformaArchiveTime(local: unknown, timeZone: unknown, chosenInstant: unknown): string {
  if (typeof local !== 'string' || timeZone !== 'Europe/Rome'
    || chosenInstant !== null && typeof chosenInstant !== 'string') throw new OperationalArchiveTimeError('INVALID');
  const resolved = resolveRomeDateTime(local);
  if (resolved.kind === 'empty' || resolved.kind === 'invalid') throw new OperationalArchiveTimeError('INVALID');
  if (resolved.kind === 'ambiguous') {
    if (!chosenInstant || !resolved.instants.includes(chosenInstant)) throw new OperationalArchiveTimeError('AMBIGUOUS');
    return chosenInstant;
  }
  if (resolved.kind === 'unique') {
    if (chosenInstant && chosenInstant !== resolved.instants[0]) throw new OperationalArchiveTimeError('INVALID');
    return resolved.instants[0];
  }
  throw new OperationalArchiveTimeError('INVALID');
}

export function formatProformaArchiveTime(instant: string): string {
  return new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'shortOffset' }).format(new Date(instant)) + ' (Europe/Rome)';
}
