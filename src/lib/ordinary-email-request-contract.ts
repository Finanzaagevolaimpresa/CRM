import { z } from 'zod';
import { isAllowedMutationOrigin, privilegedAccessMode } from './application-security-policy';
import { internalSessionMode } from './session';

export const ordinaryEmailPreviewInput = z.object({ messageId: z.string().uuid() }).strict();
export const ordinaryEmailConfirmationInput = ordinaryEmailPreviewInput.extend({
  requestId: z.string().uuid(), previewToken: z.string().min(1).max(4096),
  personalConfirmation: z.literal('APPROVO_E_INVIO_IL_MESSAGGIO_ESATTO'),
}).strict();

/** Origin and modes come only from the server request/configuration. The
 * serialized action input cannot supply identity, cookies, keys or transport. */
export function assertOrdinaryEmailRequestOrigin(request: { origin: string | null; secFetchSite: string | null },
  environment: Readonly<Record<string, string | undefined>>) {
  if (internalSessionMode(environment.INTERNAL_SESSION_MODE) !== 'registry'
    || privilegedAccessMode(environment.PRIVILEGED_ACCESS_MODE) !== 'enforced'
    || !isAllowedMutationOrigin({ ...request, configuredOrigin: environment.APP_ORIGIN ?? environment.NEXT_PUBLIC_APP_URL })) {
    throw new Error('ORDINARY_EMAIL_REQUEST_DENIED');
  }
}
