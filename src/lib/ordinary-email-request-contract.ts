import { z } from 'zod';
import { isAllowedMutationOrigin, privilegedAccessMode } from './application-security-policy';
import { internalSessionMode } from './session';

export const ordinaryEmailPreviewInput = z.object({ messageId: z.string().uuid() }).strict();
export const ordinaryEmailConfirmationInput = ordinaryEmailPreviewInput.extend({
  requestId: z.string().uuid(), previewToken: z.string().min(1).max(4096),
  personalConfirmation: z.literal('APPROVO_E_INVIO_IL_MESSAGGIO_ESATTO'),
}).strict();
export const ordinaryEmailRejectionInput = ordinaryEmailPreviewInput.extend({
  expectedRevision: z.number().int().positive().max(2_147_483_646), snapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
  personalConfirmation: z.literal('RIFIUTO_QUESTA_VERSIONE'),
}).strict();

/** Origin and modes come only from the server request/configuration. The
 * serialized action input cannot supply identity, cookies, keys or transport. */
export function assertOrdinaryEmailRequestOrigin(request: { origin: string | null; secFetchSite: string | null },
  environment: Readonly<Record<string, string | undefined>>) {
  // An explicit missing setting must not trigger the native parser's default
  // process.env argument when a supplied configuration is being qualified.
  if (internalSessionMode(environment.INTERNAL_SESSION_MODE ?? '') !== 'registry'
    || privilegedAccessMode(environment.PRIVILEGED_ACCESS_MODE ?? '') !== 'enforced'
    || !isAllowedMutationOrigin({ ...request, configuredOrigin: environment.APP_ORIGIN ?? environment.NEXT_PUBLIC_APP_URL })) {
    throw new Error('ORDINARY_EMAIL_REQUEST_DENIED');
  }
}
