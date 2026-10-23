'use client';
import { useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { mutateAdminRequest } from '@/lib/admin-request-actions';
const subscribeReady = () => () => {};
const browserReady = () => true;
const serverReady = () => false;
export function AdminRequestForm({ children, className }: { children: ReactNode; className?: string }) {
  const ready = useSyncExternalStore(subscribeReady, browserReady, serverReady);
  const sent = useRef(false), [pending, setPending] = useState(false);
  return <form action={mutateAdminRequest} className={className} data-interactive-ready={ready} aria-busy={pending} onSubmit={event => {
    if (sent.current) { event.preventDefault(); return; }
    const command = new FormData(event.currentTarget).get('commandId');
    if (typeof command === 'string') window.history.replaceState(window.history.state, '', `/admin-requests?recover=${encodeURIComponent(command)}`);
    sent.current = true; setPending(true);
  }}><fieldset disabled={!ready} className="contents">{children}</fieldset>{pending && <p role="status">Registrazione in corso. Se la risposta si interrompe, ricarica per verificare l’esito prima di ripetere.</p>}</form>;
}
export function AdminRequestRecovery({ commandId }: { commandId: string }) {
  const [state, setState] = useState('Verifica l’esito prima di ripetere la richiesta.'), [href, setHref] = useState<string | null>(null), [pending, setPending] = useState(false);
  return <section className="space-y-3 rounded-xl border p-4"><h2 className="font-bold">Verifica esito della richiesta</h2><p role="status">{state}</p>
    <button className="rounded-xl border p-3" disabled={pending} onClick={async () => {
      setPending(true);
      try {
        const result = await fetch(`/api/admin-requests/outcome?commandId=${encodeURIComponent(commandId)}`, { cache: 'no-store' });
        if (!result.ok) throw new Error('UNAVAILABLE');
        const body = await result.json();
        if (body.status === 'RECORDED') { setState('Operazione registrata nello storico. Nessuna email inviata.'); setHref(`/admin-requests/${body.requestId}`); }
        else setState('Nessuna operazione registrata per questo comando. Riapri il record prima di preparare una nuova richiesta.');
      } catch { setState('Esito non disponibile: non ripetere finché la sessione e il perimetro non sono stati verificati.'); }
      finally { setPending(false); }
    }}>Verifica esito</button>{href && <a className="ml-3 font-bold underline" href={href}>Apri richiesta registrata</a>}
  </section>;
}
