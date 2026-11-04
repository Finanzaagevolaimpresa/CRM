'use server';
import { assertTechnicalServerAction } from '@/lib/technical-server-guards';

import { revalidatePath } from 'next/cache';
import { unstable_rethrow } from 'next/navigation';
import { ApprovedCommunicationError } from './approved-communication-contract';
import { confirmOrdinaryEmailFromRequest, previewOrdinaryEmailFromRequest, rejectOrdinaryEmailFromRequest } from './ordinary-email-server-candidate';
import type { OrdinaryEmailPreviewResult, OrdinaryEmailRefusalResult, OrdinaryEmailSendResult } from './ordinary-email-ui-contract';

// No action creates authority or qualifies transport. M4 and preview do not send.
export async function previewOrdinaryEmailAction(input: unknown): Promise<OrdinaryEmailPreviewResult> {
  await assertTechnicalServerAction("ordinary-email-actions:previewOrdinaryEmailAction");
  try { return { status: 'READY', preview: await previewOrdinaryEmailFromRequest(input) }; }
  catch (error) {
    unstable_rethrow(error);
    const message = error instanceof ApprovedCommunicationError && error.code === 'CONTENT_REVIEW_REQUIRED'
      ? 'Destinatari tecnici selezionati: nella bozza interna conferma il testo condivisibile senza allegati, salva e approva la versione esatta.'
      : error instanceof ApprovedCommunicationError && error.code === 'CONTENT_APPROVAL_REQUIRED'
        ? 'Prima dell’invio, richiedi l’approvazione Admin e approva la versione esatta per pubblicare il testo ai partecipanti selezionati.'
      : error instanceof ApprovedCommunicationError && error.code === 'RECIPIENT_PERMISSION_REQUIRED'
        ? 'Un partecipante non ha il permesso Leggere comunicazioni interne. Verifica la sua scheda in Impostazioni → Utenti e salva una nuova versione.'
        : error instanceof ApprovedCommunicationError && error.code === 'SHARING_EXPIRED'
          ? 'La lettura selezionata è scaduta. Aggiorna la scadenza nella bozza e approva la nuova versione.' : undefined;
    return { status: 'UNAVAILABLE', ...(message ? { message } : {}) };
  }
}

export async function rejectOrdinaryEmailAction(input: unknown): Promise<OrdinaryEmailRefusalResult> {
  await assertTechnicalServerAction("ordinary-email-actions:rejectOrdinaryEmailAction");
  try {
    const result = await rejectOrdinaryEmailFromRequest(input);
    revalidatePath('/communications');
    return { status: 'REJECTED', revision: result.revision };
  } catch (error) {
    unstable_rethrow(error);
    // A lost transaction result must not cause a second refusal/version. The
    // client discards its preview and reloads persisted state, never retries.
    return { status: 'CHECK_CURRENT' };
  }
}

export async function confirmOrdinaryEmailAction(input: unknown): Promise<OrdinaryEmailSendResult> {
  await assertTechnicalServerAction("ordinary-email-actions:confirmOrdinaryEmailAction");
  try {
    const result = await confirmOrdinaryEmailFromRequest(input);
    revalidatePath('/communications');
    return result.status === 'RECORDED' ? { status: 'RECORDED', outcome: result.outcome } : { status: 'CHECK_CURRENT' };
  } catch (error) {
    unstable_rethrow(error);
    // Never infer rollback from a lost result. No client retry or transport
    // detail is returned; the persisted receipt/current state is authoritative.
    return { status: 'CHECK_CURRENT' };
  }
}
