'use client';
import { useActionState } from 'react';
import { PrimaryButton } from './actions';
import { recordContractSignatureAction } from '@/lib/contract-signature-actions';

export function ContractSignatureForm({ contractId, expectedVersion, documents, today }: {
  contractId: string; expectedVersion: string; documents: { versionId: string; title: string; version: number }[]; today: string;
}) {
  const [state, action, pending] = useActionState(recordContractSignatureAction, { error: null });
  return <form action={action} className="space-y-4">
    <input type="hidden" name="contractId" value={contractId} /><input type="hidden" name="expectedVersion" value={expectedVersion} />
    <p>Registra una firma già acquisita sul documento. Il pagamento e l’avvio della pratica restano operazioni separate.</p>
    <label className="block font-semibold">Documento firmato *<select name="signedDocumentVersionId" required defaultValue="" className="mt-1 block w-full rounded-xl border p-3">
      <option value="" disabled>Seleziona il contratto firmato</option>
      {documents.map(document => <option key={document.versionId} value={document.versionId}>{document.title} · versione {document.version}</option>)}
    </select></label>
    <label className="block font-semibold">Data della firma *<input type="date" name="signedOn" required max={today} className="mt-1 block rounded-xl border p-3" /></label>
    <label className="flex items-start gap-2"><input type="checkbox" name="confirmed" required className="mt-1" />Confermo che il documento selezionato è il contratto già firmato da collegare a questa scheda.</label>
    {state.error ? <p role="alert" className="rounded-xl border border-red-200 bg-red-50 p-3 text-red-800">{state.error}</p> : null}
    <PrimaryButton type="submit" disabled={pending}>{pending ? 'Registrazione…' : 'Registra firma già acquisita'}</PrimaryButton>
  </form>;
}
