'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requirePermission } from './auth';
import {
  createControlledIntake,
  decideControlledIntakeDuplicate,
  linkAuthenticated1265Projection,
} from './controlled-intake';
import { prisma } from './prisma';

export async function recordControlledIntake(form: FormData) {
  const actor = await requirePermission('lead.write');
  const raw = Object.fromEntries(form.entries());
  const date = new Date(String(raw.sourceOccurredAt));
  const intake = await createControlledIntake(prisma, actor, {
    ...raw,
    sourceOccurredAt: Number.isNaN(date.getTime()) ? raw.sourceOccurredAt : date.toISOString(),
  });
  if ('queued' in intake) redirect('/controlled-intakes?queued=1');
  redirect(`/controlled-intakes?created=${intake.id}#intake-${intake.id}`);
}

export async function decideControlledDuplicate(form: FormData) {
  const actor = await requirePermission('lead.write');
  await decideControlledIntakeDuplicate(prisma, actor, Object.fromEntries(form.entries()));
  revalidatePath('/controlled-intakes');
}

export async function classifyAuthenticated1265(form: FormData) {
  const actor = await requirePermission('lead.write');
  const intake = await linkAuthenticated1265Projection(prisma, actor, Object.fromEntries(form.entries()));
  redirect(`/controlled-intakes?created=${intake.id}#intake-${intake.id}`);
}
