'use server';

import { redirect } from 'next/navigation';
import { requirePermission } from './auth';
import { requireEnforcedPrivilegedMutation } from './privileged-access';
import { prisma } from './prisma';
import { DirectTestError, readDirectTestConfig } from './direct-email-test';
import { sendApprovedDirectEmailTest } from './direct-email-test-service';
import { sendDirectTestSmtp } from './direct-email-test-smtp';

export async function sendDirectEmailTestAction(form: FormData) {
  const session = await requirePermission('settings.manage');
  if (session.role !== 'admin' || !readDirectTestConfig()) redirect('/settings/communications/test?result=UNAVAILABLE');
  await requireEnforcedPrivilegedMutation(session, 'DIRECT_EMAIL_TEST_SEND');
  let result: string;
  try {
    result = await sendApprovedDirectEmailTest(prisma, session, {
      token: String(form.get('previewToken') ?? ''),
      exactApproval: form.get('exactApproval') === 'APPROVO_IL_MESSAGGIO_ESATTO',
    }, true, { config: readDirectTestConfig, send: sendDirectTestSmtp });
  } catch (error) {
    result = error instanceof DirectTestError ? error.code : 'UNCERTAIN';
  }
  redirect(`/settings/communications/test?result=${result}`);
}
