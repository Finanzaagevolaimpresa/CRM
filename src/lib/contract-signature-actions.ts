'use server';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { ZodError } from 'zod';
import { requireSession } from './auth';
import { prisma } from './prisma';
import { recordContractSignature } from './contract-signature';
import { ContractSignatureError } from './contract-signature-policy';

export async function recordContractSignatureAction(_previous: { error: string | null }, form: FormData): Promise<{ error: string | null }> {
  const actor = await requireSession();
  let result;
  try {
    result = await recordContractSignature(prisma, actor, { contractId: form.get('contractId'), expectedVersion: form.get('expectedVersion'),
      signedDocumentVersionId: form.get('signedDocumentVersionId'), signedOn: form.get('signedOn'), confirmed: form.get('confirmed') === 'on' });
  } catch (error) {
    if (error instanceof ZodError) return { error: 'Seleziona il documento, indica una data valida e conferma la firma già acquisita.' };
    if (error instanceof ContractSignatureError) return { error: {
      DENIED: 'Registrazione non autorizzata: verifica i permessi e la sessione.',
      STALE: 'Il contratto è stato modificato nel frattempo. Ricarica la scheda prima di proseguire.',
      CLOSED: 'La firma è già registrata oppure lo stato del contratto non consente questa operazione.',
      DOCUMENT_CHANGED: 'Il documento non è disponibile o la sua versione è cambiata. Ricarica e seleziona il contratto firmato dal fascicolo corretto.',
      INVALID_DATE: 'La data di firma non può essere futura.',
    }[error.code] };
    throw error;
  }
  revalidatePath('/contracts'); revalidatePath(`/contracts/${result.contractId}`);
  revalidatePath(`/clients/${result.clientId}`); revalidatePath('/practice-readiness'); revalidatePath('/dashboard');
  redirect(`/contracts/${result.contractId}`);
}
