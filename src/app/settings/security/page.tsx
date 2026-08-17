export const dynamic = 'force-dynamic';

import { Badge, Card, PageHeader } from '@/components/ui';
import { requireAnyPermission } from '@/lib/auth';
import {
  clearPrivilegedStepUpAction,
  establishPrivilegedStepUpAction,
} from '@/lib/privileged-access-actions';
import { privilegedAccessReadiness } from '@/lib/privileged-access';
import { privilegedAccessPermissions } from '@/lib/privileged-access-contract';

const messages: Record<string, string> = {
  active: 'Conferma privilegiata attiva per cinque minuti e vincolata alla sessione corrente.',
  cleared: 'Conferma privilegiata rimossa.',
  denied: 'Conferma non riuscita. Le credenziali non sono state accettate.',
  required: 'Per completare la mutazione è necessaria una nuova conferma della password.',
  unavailable: 'Protezione privilegiata non disponibile: configurazione o registro chiavi non conformi.',
  disabled: 'Protezione privilegiata esplicitamente disabilitata per il deploy dormiente.',
};

export default async function SecurityPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const session = await requireAnyPermission([...privilegedAccessPermissions]);
  const readiness = await privilegedAccessReadiness(session);
  const { status } = await searchParams;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Sicurezza operazioni privilegiate"
        description="Conferma breve della password per operazioni amministrative su utenti, permessi e controlli AI. Il token è HttpOnly, dura cinque minuti ed è valido soltanto con la sessione corrente."
      />

      {status && messages[status] ? (
        <p className="rounded-2xl border border-slate-200 bg-white p-4 text-sm font-semibold text-slate-700">
          {messages[status]}
        </p>
      ) : null}

      <Card
        title="Stato della protezione"
        action={<Badge tone={readiness.active ? 'green' : readiness.mode === 'enforced' ? 'orange' : 'gray'}>{readiness.mode}</Badge>}
      >
        <div className="grid gap-3 text-sm md:grid-cols-3">
          <p><b>Modalità:</b><br />{readiness.mode}</p>
          <p><b>Chiave registrata:</b><br />{readiness.keyReady ? 'conforme' : 'non disponibile'}</p>
          <p><b>Conferma corrente:</b><br />{readiness.active ? 'attiva' : 'non attiva'}</p>
        </div>
        <p className="mt-4 text-xs leading-5 text-slate-500">
          Nessun valore di chiave, cookie, digest o segreto viene mostrato o salvato nei log applicativi.
        </p>
      </Card>

      {readiness.mode === 'enforced' && readiness.keyReady ? (
        <Card title="Conferma identità amministrativa">
          <form action={establishPrivilegedStepUpAction} className="max-w-lg space-y-4">
            <label className="block text-sm font-bold text-fai-navy">
              Password corrente
              <input
                className="mt-2 w-full rounded-xl border border-slate-300 px-3 py-2"
                name="password"
                type="password"
                autoComplete="current-password"
                required
                maxLength={1024}
              />
            </label>
            <button className="rounded-xl bg-fai-green px-4 py-3 font-black text-white">
              Conferma per cinque minuti
            </button>
          </form>
          {readiness.active ? (
            <form action={clearPrivilegedStepUpAction} className="mt-4">
              <button className="rounded-xl bg-fai-orange px-4 py-3 font-black text-white">
                Rimuovi conferma
              </button>
            </form>
          ) : null}
        </Card>
      ) : (
        <Card title="Fondazione dormiente">
          <p className="text-sm leading-6 text-slate-700">
            Nessuna chiave viene attivata e nessun gate viene aperto da questa pagina. L&apos;enforcement richiede configurazione ambiente e versione ACTIVE nel registro PostgreSQL, in un&apos;attivazione separata.
          </p>
        </Card>
      )}
    </div>
  );
}
