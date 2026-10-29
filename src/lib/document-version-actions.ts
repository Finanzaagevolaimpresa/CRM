'use server';
import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { getSession } from './auth';
import { prisma } from './prisma';
import { UserFacingActionError } from './action-errors';
import { ProjectUnavailableError } from './project-lifecycle-lock';
import { appendDocumentVersion, documentVersionOutcome } from './document-version-service';
import { DocumentVersionError, versionErrorResult, type DocumentVersionResult } from './document-version-contract';

const unknown = (): DocumentVersionResult => ({ ok: false, code: 'UNKNOWN', message: 'Esito non confermato. Verifica la ricevuta prima di ripetere il caricamento.' });
function failure(error: unknown): DocumentVersionResult {
  if (error instanceof DocumentVersionError) return versionErrorResult(error.code);
  if (error instanceof UserFacingActionError || error instanceof ProjectUnavailableError) return versionErrorResult('DENIED');
  return unknown();
}
export async function uploadDocumentVersionAction(form: FormData): Promise<DocumentVersionResult> {
  try {
    const actor = await getSession(); if (!actor) return versionErrorResult('DENIED');
    let command: unknown; try { command = JSON.parse(String(form.get('command'))); } catch { return versionErrorResult('INVALID'); }
    if (form.getAll('file').length !== 1) return versionErrorResult('INVALID');
    const result = await appendDocumentVersion(prisma, actor, command, form.get('file') as File);
    revalidatePath('/documents');
    return result;
  } catch (error) { return failure(error); }
}
export async function checkDocumentVersionOutcome(raw: unknown): Promise<DocumentVersionResult> {
  const command = z.object({ documentId: z.string().min(1).max(128), requestId: z.string().uuid() }).strict().safeParse(raw);
  if (!command.success) return versionErrorResult('INVALID');
  try {
    const actor = await getSession(); if (!actor) return versionErrorResult('DENIED');
    const result = await documentVersionOutcome(prisma, actor, command.data);
    return result ?? { ok: false, code: 'NOT_OBSERVED', message: 'Ricevuta non osservata. Non ripetere il caricamento finché l’esito non è riconciliato.' };
  } catch (error) { return failure(error); }
}
