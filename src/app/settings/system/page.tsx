export const dynamic = 'force-dynamic';

import { Badge, Card, PageHeader } from '@/components/ui';
import { requirePermission } from '@/lib/auth';
import { getSystemReadinessChecks, recommendedActions, type ReadinessStatus } from '@/lib/system-readiness';

const statusTone: Record<ReadinessStatus, 'green' | 'orange' | 'gray'> = {
  OK: 'green',
  Attenzione: 'orange',
  Errore: 'orange',
  'Non configurato': 'gray',
};

function StatusBadge({ status }: { status: ReadinessStatus }) {
  return <Badge tone={statusTone[status]}>{status}</Badge>;
}

export default async function Page() {
  await requirePermission('settings.manage');
  const checks = await getSystemReadinessChecks();
  const hasBlockingErrors = checks.some((check) => check.status === 'Errore');
  const hasWarnings = checks.some((check) => check.status === 'Attenzione' || check.status === 'Non configurato');

  return (
    <div className="space-y-6">
      <PageHeader
        title="Diagnostica sistema"
        description="Controlli admin di readiness produzione: verifica configurazione, database, storage, segreti presenti e backup senza esporre valori sensibili o dati cliente."
      />

      <Card
        title="Stato complessivo"
        action={<Badge tone={hasBlockingErrors ? 'orange' : hasWarnings ? 'lime' : 'green'}>{hasBlockingErrors ? 'intervento richiesto' : hasWarnings ? 'da rivedere' : 'pronto'}</Badge>}
      >
        <p className="text-sm leading-6 text-slate-700">
          Questa pagina mostra solo esiti sintetici e presenza/non presenza delle variabili. Non mostra DATABASE_URL, AUTH_SECRET, chiavi AI/S3, dati cliente, documenti o contenuti operativi.
        </p>
      </Card>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {checks.map((check) => (
          <section key={check.title} className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm shadow-slate-200/70">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-base font-black text-fai-navy">{check.title}</h2>
                <p className="mt-2 text-sm font-semibold leading-6 text-slate-700">{check.summary}</p>
              </div>
              <StatusBadge status={check.status} />
            </div>
            {check.details?.length ? (
              <ul className="mt-4 space-y-2 text-xs leading-5 text-slate-600">
                {check.details.map((detail) => (
                  <li key={detail} className="rounded-2xl bg-slate-50 px-3 py-2 ring-1 ring-slate-200">{detail}</li>
                ))}
              </ul>
            ) : null}
          </section>
        ))}
      </div>

      <Card title="Azioni consigliate" action={<Badge tone="purple">readiness</Badge>}>
        <ul className="grid gap-3 text-sm leading-6 text-slate-700 md:grid-cols-2">
          {recommendedActions.map((action) => (
            <li key={action} className="rounded-2xl bg-slate-50 p-4 font-semibold ring-1 ring-slate-200">{action}</li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
