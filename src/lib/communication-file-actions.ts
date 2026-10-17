'use server';

import { headers } from 'next/headers';
import { unstable_rethrow } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { requireSession } from './auth';
import { prisma } from './prisma';
import { assertOrdinaryEmailRequestOrigin } from './ordinary-email-request-contract';
import { storeCommunicationFile, revokeCommunicationFile } from './communication-files';

async function admission() {
  const session = await requireSession(), h = await headers();
  assertOrdinaryEmailRequestOrigin({ origin: h.get('origin'), secFetchSite: h.get('sec-fetch-site') }, process.env);
  return session;
}

export async function uploadCommunicationFileAction(form: FormData): Promise<'RECORDED' | 'CHECK_CURRENT'> {
  try {
    const session = await admission(), file = form.get('file');
    if (!(file instanceof File)) return 'CHECK_CURRENT';
    await storeCommunicationFile(prisma, session, { id: form.get('id'),
      context: { kind: form.get('kind'), id: form.get('contextId') }, classification: form.get('classification') }, file);
    revalidatePath('/communications');
    return 'RECORDED';
  } catch (error) { unstable_rethrow(error); return 'CHECK_CURRENT'; }
}

export async function revokeCommunicationFileAction(raw: unknown): Promise<'RECORDED' | 'CHECK_CURRENT'> {
  try {
    await revokeCommunicationFile(prisma, await admission(), raw);
    revalidatePath('/communications');
    return 'RECORDED';
  } catch (error) { unstable_rethrow(error); return 'CHECK_CURRENT'; }
}
