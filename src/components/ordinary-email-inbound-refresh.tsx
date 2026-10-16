'use client';

import { useRef, useState, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import { refreshOrdinaryRepliesAction } from '@/lib/ordinary-email-inbound-actions';

const subscribe = () => () => {};

export function OrdinaryEmailInboundRefresh({ messageId, revision, snapshotHash }: {
  messageId: string; revision: number; snapshotHash: string;
}) {
  const router = useRouter(), busy = useRef(false);
  const ready = useSyncExternalStore(subscribe,() => true,() => false), [state,setState] = useState('');
  async function refresh() {
    if (busy.current) return;
    busy.current = true; setState('BUSY');
    try {
      const result = await refreshOrdinaryRepliesAction({ messageId,revision,snapshotHash });
      setState(result);
      if (result !== 'CHECK_CURRENT') { router.refresh(); busy.current = false; }
    } catch { setState('LOST'); }
  }
  return <div data-inbound-message={messageId} data-inbound-ready={ready} className="my-3 grid gap-2">
    <button type="button" className="rounded-xl border px-4 py-2 font-bold disabled:opacity-50"
      disabled={!ready || state === 'BUSY' || state === 'CHECK_CURRENT' || state === 'LOST'} onClick={refresh}>
      {state === 'BUSY' ? 'Collegamento in corso…' : 'Collega risposte ricevute'}
    </button>
    <p className="text-sm text-slate-600">Collega le risposte già acquisite a questa comunicazione. Non invia messaggi.</p>
    {state && state !== 'BUSY' ? <p role="status" className="text-sm">
      {state === 'UPDATED' ? 'Risposte aggiornate.' : state === 'MORE' ? 'Prime risposte collegate. Puoi continuare con le successive.'
        : state === 'LOST' ? 'Risposta non ricevuta. Ricarica la pagina per verificare i collegamenti.'
        : 'Esito da verificare. Ricarica la pagina e controlla gli accessi correnti.'}
    </p> : null}
  </div>;
}
