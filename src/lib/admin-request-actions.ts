'use server';
import { assertTechnicalServerAction } from '@/lib/technical-surface-guards';
import { headers } from 'next/headers';
import { z } from 'zod';
import { SerializableConflictError } from './serializable';
import { requireSession } from './auth';
import { prisma } from './prisma';
import { isAllowedMutationOrigin } from './application-security-policy';
import { AdminRequestError, requestDenied } from './admin-request-admission';
import { submitAdminRequest, changeAdminRequest, isRequestUnavailable } from './admin-request-service';

const value = (form: FormData, key: string) => String(form.get(key) ?? '');
export async function mutateAdminRequest(form: FormData) {
  await assertTechnicalServerAction("admin-request-actions:mutateAdminRequest");
  const session = await requireSession(), h = await headers();
  if (!isAllowedMutationOrigin({ origin: h.get('origin'), secFetchSite: h.get('sec-fetch-site'),
    configuredOrigin: process.env.APP_ORIGIN ?? process.env.NEXT_PUBLIC_APP_URL })) requestDenied();
  const action = value(form, 'action'); let target = '/admin-requests';
  let result: 'RECORDED' | 'UNAVAILABLE' | 'INVALID' = 'RECORDED';
  try {
    const receipt = action === 'SUBMIT' ? await submitAdminRequest(prisma, session, {
      commandId: value(form, 'commandId'), subject: { kind: value(form, 'subjectKind'), targetId: value(form, 'targetId') },
      expectedContextSha256: value(form, 'expectedContextSha256'), expectedRecipientEpoch: Number(value(form, 'expectedRecipientEpoch')),
      expectedAccessRevision: Number(value(form, 'expectedAccessRevision')), kind: value(form, 'kind'),
      title: value(form, 'title'), details: value(form, 'details'),
    }) : await changeAdminRequest(prisma, session, {
      requestId: value(form, 'requestId'), commandId: value(form, 'commandId'), expectedRevision: Number(value(form, 'expectedRevision')),
      expectedSubmissionSha256: value(form, 'expectedSubmissionSha256'), action,
      ...(['REQUEST_INFORMATION', 'REJECT'].includes(action) ? { requesterReply: value(form, 'requesterReply') }
        : action === 'AMEND' ? { title: value(form, 'title'), details: value(form, 'details') } : {}),
    });
    target += `/${receipt.requestId}`;
  } catch (error) {
    if (isRequestUnavailable(error) || error instanceof AdminRequestError || error instanceof SerializableConflictError) result = 'UNAVAILABLE';
    else if (error instanceof z.ZodError) result = 'INVALID';
    else throw error;
  }
  // Request pages are dynamic. The client opens the returned record with a
  // full GET after this response; a simultaneous action revalidation would
  // race that navigation and may reopen the old submission form.
  return { status: result, target };
}
