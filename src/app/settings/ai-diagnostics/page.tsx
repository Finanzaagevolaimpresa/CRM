export const dynamic = 'force-dynamic';

import { Badge, Card, PageHeader } from '@/components/ui';
import { runAiProviderDiagnosticTest } from '@/lib/actions';
import { getAiProviderDiagnostics } from '@/lib/ai';
import { requirePermission } from '@/lib/auth';

function yesNo(value: boolean) {
  return value ? 'sì' : 'no';
}

export default async function Page({ searchParams }: { searchParams?: Promise<{ status?: string; message?: string }> }) {
  await requirePermission('ai_agents.read');
  const diagnostics = getAiProviderDiagnostics();
  const params = await searchParams;
  const status = params?.status;
  const message = params?.message;

  return (
    <div className="space-y-6">
      <PageHeader title="Diagnostica provider AI" description="Pannello admin/direzione per verificare configurazione e raggiungibilità del provider AI senza esporre chiavi, prompt sensibili o dati cliente." />

      <Card title="Stato configurazione" action={<Badge tone={diagnostics.configurationStatus === 'ok' ? 'green' : 'orange'}>{diagnostics.configurationStatus}</Badge>}>
        <div className="grid gap-4 text-sm leading-6 text-slate-700 md:grid-cols-2 xl:grid-cols-3">
          <div className="rounded-2xl bg-slate-50 p-4 ring-1 ring-slate-200">
            <p className="text-xs font-black uppercase tracking-wide text-slate-500">AI_PROVIDER attivo</p>
            <p className="mt-1 text-lg font-extrabold text-fai-navy">{diagnostics.configuredProvider}</p>
          </div>
          <div className="rounded-2xl bg-slate-50 p-4 ring-1 ring-slate-200">
            <p className="text-xs font-black uppercase tracking-wide text-slate-500">AI_MODEL configurato</p>
            <p className="mt-1 text-lg font-extrabold text-fai-navy">{diagnostics.model}</p>
          </div>
          <div className="rounded-2xl bg-slate-50 p-4 ring-1 ring-slate-200">
            <p className="text-xs font-black uppercase tracking-wide text-slate-500">AI_API_KEY presente</p>
            <p className="mt-1 text-lg font-extrabold text-fai-navy">{yesNo(diagnostics.hasApiKey)}</p>
            <p className="mt-1 text-xs text-slate-500">La chiave non viene mai mostrata.</p>
          </div>
          <div className="rounded-2xl bg-slate-50 p-4 ring-1 ring-slate-200">
            <p className="text-xs font-black uppercase tracking-wide text-slate-500">Modalità attiva</p>
            <p className="mt-1 text-lg font-extrabold text-fai-navy">{diagnostics.mode}</p>
          </div>
          <div className="rounded-2xl bg-slate-50 p-4 ring-1 ring-slate-200">
            <p className="text-xs font-black uppercase tracking-wide text-slate-500">Provider normalizzato</p>
            <p className="mt-1 text-lg font-extrabold text-fai-navy">{diagnostics.provider}</p>
          </div>
          <div className="rounded-2xl bg-slate-50 p-4 ring-1 ring-slate-200">
            <p className="text-xs font-black uppercase tracking-wide text-slate-500">Output diagnostici</p>
            <p className="mt-1 font-semibold text-slate-600">Non vengono creati AiRun, AiOutput o dossier.</p>
          </div>
        </div>

        <div className="mt-5 grid gap-3 text-sm leading-6">
          {diagnostics.provider === 'openai' ? <p className="rounded-2xl bg-fai-orange/10 p-4 font-bold text-fai-orange ring-1 ring-fai-orange/20">Avviso costi: la modalità OpenAI può generare costi del provider esterno anche per test minimi.</p> : null}
          <p className="rounded-2xl bg-fai-purple/10 p-4 font-bold text-fai-purple ring-1 ring-fai-purple/20">Revisione umana obbligatoria: ogni output AI operativo resta una bozza interna da validare manualmente.</p>
        </div>
      </Card>

      <Card title="Test provider" action={<Badge tone="purple">server-side</Badge>}>
        <div className="space-y-4 text-sm leading-6 text-slate-700">
          <p>Il test usa un prompt tecnico minimale interno, non usa dati cliente reali, non salva AiRun/AiOutput, non crea dossier e registra solo un evento audit sintetico senza API key.</p>
          {message ? <div className={`rounded-2xl p-4 font-bold ring-1 ${status === 'ok' ? 'bg-fai-teal/10 text-fai-green ring-fai-teal/20' : 'bg-fai-orange/10 text-fai-orange ring-fai-orange/20'}`}>{status === 'ok' ? 'ok' : 'errore controllato'} · {message}</div> : null}
          <form action={runAiProviderDiagnosticTest}>
            <button className="rounded-2xl bg-fai-navy px-5 py-3 text-sm font-black text-white transition hover:bg-fai-blue" type="submit">Esegui test provider</button>
          </form>
        </div>
      </Card>
    </div>
  );
}
