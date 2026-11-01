import { createHash } from 'node:crypto';
import type { AuthSession } from './auth';
/** A tab-local recovery reference is scoped to the current user/session.
 * This opaque digest grants no authority; the outcome endpoint re-admits the
 * actor and original registry session. No cookie, token or request text is kept. */
export function adminRequestRecoveryScope(session: AuthSession) {
  return createHash('sha256').update(session.userId + ':' + (session.sessionId ?? 'legacy')).digest('hex');
}
