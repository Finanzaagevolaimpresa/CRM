'use client';
import { useActionState, useSyncExternalStore } from 'react';
import type { TechnicalTargetReference } from '@/lib/technical-assignment-display';
import type { TechnicalAssignmentReference } from '@/lib/technical-assignment-decision';
import type { TechnicalUploadState, TechnicalUploadAction } from '@/lib/technical-upload-ui-state';
export const technicalUploadInitial: TechnicalUploadState = { ok: false, message: '' };
export const uploadButton = 'rounded-xl bg-blue-900 px-4 py-3 font-semibold text-white disabled:opacity-50';
export const uploadControl = 'block w-full min-w-0 rounded-xl border border-slate-300 bg-white p-3';
const subscribe = () => () => {}, client = () => true, server = () => false;
export function useUploadReady() { return useSyncExternalStore(subscribe, client, server); }
export function rememberUpload(name: 'uploadDecision' | 'reviewDecision' | 'acquisitionDecision', commandId: string) {
  const url = new URL(window.location.href); if (commandId) url.searchParams.set(name, commandId); else url.searchParams.delete(name); window.history.replaceState(window.history.state, '', url);
}
export function TechnicalUploadRecovery({ target, reference, commandId, action, returnPath }: { target?: TechnicalTargetReference;
  reference?: TechnicalAssignmentReference; commandId: string; action: TechnicalUploadAction; returnPath: string }) {
  const ready = useUploadReady(), [state, submit, pending] = useActionState(action, technicalUploadInitial);
  return <section className="space-y-3 rounded-xl border border-amber-400 bg-amber-50 p-4" aria-label="Verifica ricevuta documento">
    <p>Questa verifica consulta soltanto la ricevuta del comando originale. Un esito non osservato richiede riconciliazione prima di ripetere l’operazione.</p>
    <form action={submit}><input type="hidden" name={reference ? 'reference' : 'target'} value={JSON.stringify(reference ?? target)} />
      <input type="hidden" name="commandId" value={commandId} /><button className={uploadButton} disabled={!ready || pending}>Verifica ricevuta</button></form>
    <p role="status">{state.message}</p>{state.recorded && <a className="font-semibold underline" href={returnPath}>Ricarica il deposito corrente</a>}
  </section>;
}
