'use server';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requireSession } from './auth';
import { markInternalNotificationRead } from './internal-notifications';
import { assertTechnicalServerAction } from './technical-server-guards';

export async function openInternalNotification(form: FormData) {
  await assertTechnicalServerAction('internal-notification-actions:openInternalNotification');
  const actor = await requireSession();
  const id = z.string().min(1).max(220).parse(form.get('id'));
  const notice = await markInternalNotificationRead(actor, id);
  if (!notice) redirect('/notifications');
  revalidatePath('/notifications');
  revalidatePath('/dashboard');
  redirect(notice.href);
}
