import type { SelectivePracticeScope } from './selective-practice-policy';
import type { AuthSession } from './auth';
import type { ClientReadScope } from './client-read-perimeter-policy';
import type { SelectiveProjectScope } from './selective-project-policy';
import type { SelectiveLeadScope } from './selective-lead-policy';

// A locked current permission principal, not a login or an impersonated session.
// Callers authenticate the requesting session separately before using it.
export type CommunicationPrincipal = Pick<AuthSession, 'userId' | 'role' | 'active' | 'permissionOverrides'>
  & ClientReadScope & SelectiveProjectScope & SelectiveLeadScope & SelectivePracticeScope;
