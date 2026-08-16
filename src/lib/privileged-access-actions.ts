'use server';

import { redirect } from 'next/navigation';
import { requireAnyPermission } from './auth';
import { privilegedAccessPermissions } from './privileged-access-contract';
import {
  clearPrivilegedStepUpCookie,
  establishPrivilegedStepUp,
} from './privileged-access';

export async function establishPrivilegedStepUpAction(formData: FormData) {
  const session = await requireAnyPermission([...privilegedAccessPermissions]);
  const password = String(formData.get('password') ?? '');
  let result: 'DISABLED' | 'DENIED' | 'UNAVAILABLE' | 'ESTABLISHED' = 'UNAVAILABLE';
  try { result = await establishPrivilegedStepUp(session, password); } catch { result = 'UNAVAILABLE'; }
  if (result === 'ESTABLISHED') redirect('/settings/security?status=active');
  if (result === 'DISABLED') redirect('/settings/security?status=disabled');
  if (result === 'DENIED') redirect('/settings/security?status=denied');
  redirect('/settings/security?status=unavailable');
}

export async function clearPrivilegedStepUpAction() {
  await requireAnyPermission([...privilegedAccessPermissions]);
  await clearPrivilegedStepUpCookie();
  redirect('/settings/security?status=cleared');
}
