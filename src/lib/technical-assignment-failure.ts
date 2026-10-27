import { ZodError } from 'zod';
import { TechnicalAssignmentError, TechnicalAssignmentPreparationError } from './technical-assignment-errors';

type Failure = { ok: false; message: string; uncertain?: true; rejectedBeforeWrite?: true };

/** A read-only preview cannot have changed an assignment. A decision with an
 * unknown error remains uncertain; no message/code-string matching is allowed. */
export function technicalAssignmentFailure(error: unknown, readOnly = false): Failure {
  if (error instanceof TechnicalAssignmentPreparationError) {
    return { ok: false, rejectedBeforeWrite: true,
      message: ['STALE', 'SCOPE', 'EXPIRED'].includes(error.code)
        ? 'Riepilogo scaduto o non più valido. Nessun incarico modificato da questo tentativo. Ricarica e prepara un nuovo riepilogo.'
        : 'Preparazione non valida o storico non disponibile. Nessun incarico modificato da questo tentativo. Ricarica e verifica lo stato corrente.' };
  }
  if (error instanceof ZodError || error instanceof SyntaxError) return { ok: false,
    message: 'Dati non validi. Ricarica e prepara un nuovo riepilogo.' };
  if (error instanceof TechnicalAssignmentError) return { ok: false, message: error.code === 'STALE'
    ? 'Stato o permessi cambiati. Ricarica e prepara un nuovo riepilogo.'
    : 'Operazione non consentita con la sessione e l’abilitazione correnti.' };
  return readOnly
    ? { ok: false, message: 'Riepilogo non disponibile. Nessun incarico è stato modificato. Ricarica prima di riprovare.' }
    : { ok: false, uncertain: true, message: 'Esito non confermato. Verifica la decisione prima di ripetere un’operazione.' };
}
