/** These errors are raised by the pure preparation routines, before persistence.
 * Never infer them from a transport error's text or an absent decision receipt. */
export class TechnicalAssignmentPreparationError extends Error {
  constructor(readonly code: 'STALE' | 'SCOPE' | 'EXPIRED' | 'SIZE' | 'HISTORY_UNAVAILABLE' | 'ALREADY_REVOKED') {
    super(`TECHNICAL_ASSIGNMENT_PREPARATION_${code}`);
    this.name = 'TechnicalAssignmentPreparationError';
  }
}

export class TechnicalAssignmentError extends Error {
  constructor(readonly code: 'DENIED' | 'STALE' | 'UNAVAILABLE') {
    super(`TECHNICAL_ASSIGNMENT_${code}`);
    this.name = 'TechnicalAssignmentError';
  }
}
