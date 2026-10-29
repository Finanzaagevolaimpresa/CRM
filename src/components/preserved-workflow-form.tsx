'use client';
import { useState, useSyncExternalStore, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { InlinePrivilegedConfirmation } from './inline-privileged-confirmation';

export type WorkflowFormState = { ok: boolean; message: string; stepUpRequired?: boolean; uncertain?: boolean; href?: string };
const subscribe = () => () => {}, client = () => true, server = () => false;
export function PreservedWorkflowForm({ action, children, className, ...attributes }: {
  action: (form: FormData) => Promise<WorkflowFormState>; children: ReactNode; className?: string;
  'data-message-draft'?: string; 'data-reply-draft'?: string;
}) {
  const ready = useSyncExternalStore(subscribe, client, server), router = useRouter();
  const [state, setState] = useState<WorkflowFormState | null>(null), [busy, setBusy] = useState(false), [recovery, setRecovery] = useState('');
  return <div><form {...attributes} onReset={event => event.preventDefault()} onSubmit={async event => {
    event.preventDefault(); if (!ready || busy || state?.ok || state?.uncertain) return;
    const data = new FormData(event.currentTarget);
    const target = '/communications?' + new URLSearchParams({ kind: String(data.get('contextKind') ?? ''), practice: String(data.get('contextId') ?? ''), focus: String(data.get('messageId') ?? '') });
    setRecovery(target); setBusy(true);
    try {
      const result = await action(data); setState(result);
      if (result.ok && result.href) { router.push(result.href); router.refresh(); }
    } catch { setState({ ok: false, uncertain: true, message: 'Risposta interrotta. Apri il messaggio conservato e verifica versione e timeline prima di proseguire. Nessun comando viene ripetuto.' }); }
    finally { setBusy(false); }
  }}><fieldset disabled={!ready || busy || Boolean(state?.ok || state?.uncertain)} className={className}>{children}</fieldset></form>
    {state && <p role="status">{state.message}</p>}
    {state?.stepUpRequired && <InlinePrivilegedConfirmation />}
    {state?.uncertain && recovery && <a className="font-semibold underline" href={recovery}>Apri il messaggio e verifica l’esito</a>}
  </div>;
}
