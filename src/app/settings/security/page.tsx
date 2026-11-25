import { IdentityConfirmationForm } from '@/components/identity-confirmation-form';
import { withTechnicalPage } from '@/lib/technical-surface-guards';
export const dynamic = 'force-dynamic';

import { ordinaryWindowEnabled } from '@/lib/admin-ordinary-policy';
import { Badge, Card, PageHeader, formatDateTime } from '@/components/ui';
import { requireAnyPermission } from '@/lib/auth';
import {
  clearPrivilegedStepUpAction,
} from '@/lib/privileged-access-actions';
import { privilegedAccessReadiness } from '@/lib/privileged-access';
import { privilegedAccessPermissions } from '@/lib/privileged-access-contract';
import { securityReturnPath } from '@/lib/security-return-path';
import { SecondaryLink } from '@/components/actions';
import { privilegedStepUpTtlSeconds } from '@/lib/privileged-step-up-policy';

const messages: Record<string, string> = {
  active: 'Conferma privilegiata attiva e vincolata alla sessione corrente.',
  cleared: 'Conferma privilegiata rimossa.',
  denied: 'Conferma non riuscita. Le credenziali non sono state accettate.',
  required: 'Per completare la mutazione è necessaria una nuova conferma della password.',
  unavailable: 'Protezione privilegiata non disponibile: configurazione o registro chiavi non conformi.',
  disabled: 'Protezione privilegiata esplicitamente disabilitata per il deploy dormiente.',
};

  async function SecurityPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; returnTo?: string }>;
}) {
  const session = await requireAnyPermission([...privilegedAccessPermissions]);
  const showOrdinaryPolicy = session.role === 'admin' && ordinaryWindowEnabled();
  const [readiness, ordinary] = await Promise.all([privilegedAccessReadiness(session),
    showOrdinaryPolicy ? privilegedAccessReadiness(session, 'N14_LEAD_INBOX_ASSIGN') : null]);
  const { status, returnTo } = await searchParams;
  const returnPath = securityReturnPath(returnTo);
  const minutes = privilegedStepUpTtlSeconds(session.role) / 60;

  return (
    <div className="crm-space-y-6">
      <PageHeader
        title="Sicurezza operazioni privilegiate"
        description={`Conferma la password per le operazioni amministrative. La conferma dura ${minutes} minuti nella sessione corrente; le anteprime dei singoli comandi mantengono la propria scadenza.`}
      />
      {returnPath && <SecondaryLink href={returnPath}>Torna alla coda lead</SecondaryLink>}

      {status && messages[status] ? (
        <p className="rounded-2xl border border-slate-200 bg-white p-4 text-sm font-semibold text-slate-700">
          {messages[status]}
        </p>
      ) : null}

      {showOrdinaryPolicy && <Card title="Assegnazioni ordinarie">
        <p>{ordinary?.ordinaryExpiresAt ? `Conferma ordinaria attiva. Scadenza massima ${formatDateTime(new Date(ordinary.ordinaryExpiresAt))}.` : 'Conferma ordinaria non attiva.'}</p>
        <p>La conferma abilita per 24 ore assegnazione, riassegnazione e rilascio del referente e le decisioni nominative di responsabilità. La sessione termina dopo 60 minuti senza uno di questi comandi. Uscita, revoca e cambio ruolo chiudono l’accesso.</p>
        <p>Per permessi, credenziali, fascicoli e altre operazioni sensibili la conferma personale vale 30 minuti.</p>
      </Card>}
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
          <IdentityConfirmationForm returnToInbox={!!returnPath}>
            {returnPath && <p>La conferma ti riporta alla coda lead. Poi scegli personalmente il referente e premi Assegna.</p>}
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
              Conferma per {minutes} minuti
            </button>
          </IdentityConfirmationForm>
          {readiness.active || ordinary?.ordinaryExpiresAt ? (
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

export default withTechnicalPage("/settings/security", SecurityPage);
