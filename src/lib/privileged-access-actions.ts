'use server';

import { redirect } from 'next/navigation';
import { requireAnyPermission } from './auth';
import { privilegedAccessPermissions } from './privileged-access-contract';
import { securityReturnPath } from './security-return-path';
import {
  clearPrivilegedStepUpCookie,
  establishPrivilegedStepUp,
} from './privileged-access';

export async function establishPrivilegedStepUpAction(formData: FormData) {
  const session = await requireAnyPermission([...privilegedAccessPermissions]);
  const password = String(formData.get('password') ?? '');
  const returnPath = securityReturnPath(formData.get('returnTo'));
  const returnQuery = returnPath ? '&returnTo=lead-inbox' : '';
  let result: 'DISABLED' | 'DENIED' | 'UNAVAILABLE' | 'ESTABLISHED' = 'UNAVAILABLE';
  try { result = await establishPrivilegedStepUp(session, password); } catch { result = 'UNAVAILABLE'; }
  if (result === 'ESTABLISHED') redirect(returnPath ?? '/settings/security?status=active');
  if (result === 'DISABLED') redirect(`/settings/security?status=disabled${returnQuery}`);
  if (result === 'DENIED') redirect(`/settings/security?status=denied${returnQuery}`);
  redirect(`/settings/security?status=unavailable${returnQuery}`);
}

export async function clearPrivilegedStepUpAction() {
  await requireAnyPermission([...privilegedAccessPermissions]);
  await clearPrivilegedStepUpCookie();
  redirect('/settings/security?status=cleared');
}
