'use client';
import { useActionState } from 'react';
import { PrimaryButton } from './actions';
import { declareContractSignatureAction } from '@/lib/contract-signature-actions';
import { InteractiveReadyMarker } from './interactive-ready-marker';

export function ContractSignatureDeclarationForm({ contractId, expectedVersion, expectedDeclarationId, today }: {
  contractId: string; expectedVersion: string; expectedDeclarationId: string | null; today: string;
}) {
  const [state, action, pending] = useActionState(declareContractSignatureAction, { error: null });
  return <form action={action} className="space-y-3">
    <InteractiveReadyMarker />
    <input type="hidden" name="contractId" value={contractId} /><input type="hidden" name="expectedVersion" value={expectedVersion} />
    <input type="hidden" name="expectedDeclarationId" value={expectedDeclarationId ?? ''} />
    <p>Usa questa dichiarazione se hai notizia della firma ma devi ancora acquisire o verificare il documento. Non registra la firma e non avvia il servizio.</p>
    <label className="block font-semibold">Data della firma dichiarata<input type="date" name="signedOn" required max={today} className="block rounded-xl border p-3" /></label>
    <label className="block font-semibold">Fonte della dichiarazione<textarea name="source" required minLength={3} maxLength={500} className="block w-full rounded-xl border p-3" placeholder="Chi ha comunicato la firma e riferimento alla comunicazione" /></label>
    <label className="flex items-start gap-2"><input type="checkbox" name="confirmed" required />Confermo di registrare una dichiarazione da verificare sul documento.</label>
    {state.error ? <p role="alert">{state.error}</p> : null}
    <PrimaryButton type="submit" disabled={pending}>{pending ? 'Salvataggio…' : 'Salva dichiarazione da verificare'}</PrimaryButton>
  </form>;
}
