import Link from "next/link";

export type DashboardKpi = {
  label: string;
  value: number;
  description: string;
  href: string;
  tone: "blue" | "green" | "orange" | "purple";
};

export type DashboardPriority = {
  id: string;
  title: string;
  related: string;
  type: string;
  date: string;
  href: string;
};

const toneStyles = {
  blue: "bg-blue-50 text-fai-blue ring-blue-100",
  green: "bg-emerald-50 text-fai-green ring-emerald-100",
  orange: "bg-orange-50 text-fai-orange ring-orange-100",
  purple: "bg-violet-50 text-fai-purple ring-violet-100",
};

function KpiIcon({ tone }: { tone: DashboardKpi["tone"] }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-5 w-5">
      {tone === "blue" && <><circle cx="9" cy="8" r="3" /><path d="M3 20c0-4 2-7 6-7s6 3 6 7M16 6a3 3 0 0 1 0 6M17 14c2.5.5 4 2.5 4 5" /></>}
      {tone === "green" && <><path d="M7 3h8l4 4v14H7z" /><path d="M15 3v5h5M10 12h6M10 16h6" /></>}
      {tone === "orange" && <><circle cx="12" cy="12" r="9" /><path d="M12 7v6l4 2" /></>}
      {tone === "purple" && <><path d="M5 12.5 10 17l9-10" /><circle cx="12" cy="12" r="9" /></>}
    </svg>
  );
}

export function DashboardOverview({
  greeting,
  summary,
  kpis,
  priorities,
  pipeline,
  shortcuts,
}: {
  greeting: string;
  summary: string;
  kpis: DashboardKpi[];
  priorities: DashboardPriority[];
  pipeline: Array<{ label: string; value: number }>;
  shortcuts: Array<{ label: string; description: string; href: string }>;
}) {
  const pipelineTotal = pipeline.reduce((total, item) => total + item.value, 0);
  return (
    <section aria-labelledby="dashboard-heading" className="space-y-5">
      <div className="flex flex-col gap-4 border-b border-slate-200 pb-5 xl:flex-row xl:items-end xl:justify-between">
        <div className="min-w-0">
          <p className="text-xs font-black uppercase tracking-[0.18em] text-fai-green">Panoramica operativa</p>
          <h1 id="dashboard-heading" className="mt-2 text-3xl font-black tracking-tight text-fai-navy sm:text-4xl">{greeting}</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">{summary}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href="/search" className="inline-flex min-h-11 items-center rounded-xl border border-slate-200 bg-white px-4 text-sm font-bold text-fai-navy shadow-sm focus:outline-none focus:ring-2 focus:ring-fai-lime">Cerca nel CRM</Link>
          <Link href="/notifications" className="inline-flex min-h-11 items-center rounded-xl border border-slate-200 bg-white px-4 text-sm font-bold text-fai-navy shadow-sm focus:outline-none focus:ring-2 focus:ring-fai-lime">Notifiche</Link>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {kpis.map((kpi) => (
          <Link key={kpi.label} href={kpi.href} className="group rounded-2xl border border-slate-200 bg-white p-4 shadow-sm transition hover:border-fai-green/30 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-fai-lime">
            <div className={`mb-4 flex h-10 w-10 items-center justify-center rounded-xl ring-1 ${toneStyles[kpi.tone]}`}><KpiIcon tone={kpi.tone} /></div>
            <p className="text-sm font-bold text-slate-600">{kpi.label}</p>
            <p className="mt-1 text-3xl font-black text-fai-navy">{kpi.value}</p>
            <p className="mt-1 text-xs leading-5 text-slate-500">{kpi.description}</p>
          </Link>
        ))}
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.35fr)_minmax(20rem,0.85fr)]">
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex items-start justify-between gap-4">
            <div><h2 className="text-xl font-black text-fai-navy">Pipeline pratiche</h2><p className="mt-1 text-sm text-slate-500">Distribuzione corrente dei servizi accessibili.</p></div>
            <span className="rounded-full bg-fai-green/10 px-3 py-1 text-xs font-black text-fai-green">{pipelineTotal} totali</span>
          </div>
          {pipelineTotal === 0 ? (
            <p className="mt-6 rounded-xl bg-slate-50 p-5 text-sm text-slate-500">Nessun servizio visibile nella pipeline corrente.</p>
          ) : (
            <div className="mt-5 space-y-3">
              {pipeline.filter((item) => item.value > 0).map((item) => (
                <div key={item.label} className="grid grid-cols-[minmax(7rem,1fr)_2fr_auto] items-center gap-3 text-xs">
                  <span className="truncate font-bold capitalize text-slate-600">{item.label}</span>
                  <span className="h-2 overflow-hidden rounded-full bg-slate-100"><span className="block h-full rounded-full bg-gradient-to-r from-fai-blue to-fai-green" style={{ width: `${Math.max(6, item.value / pipelineTotal * 100)}%` }} /></span>
                  <span className="font-black text-fai-navy">{item.value}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex items-start justify-between gap-4"><div><h2 className="text-xl font-black text-fai-navy">Priorità</h2><p className="mt-1 text-sm text-slate-500">Le prossime attività autorizzate per urgenza.</p></div><span className="rounded-full bg-fai-lime/20 px-3 py-1 text-xs font-black text-fai-green">{priorities.length}</span></div>
          {priorities.length === 0 ? <p className="mt-6 rounded-xl bg-slate-50 p-5 text-sm text-slate-500">Nessuna priorità operativa al momento.</p> : (
            <ol className="mt-4 divide-y divide-slate-100">
              {priorities.map((item) => <li key={item.id} className="py-3"><Link href={item.href} className="block rounded-lg focus:outline-none focus:ring-2 focus:ring-fai-lime"><span className="text-[0.65rem] font-black uppercase tracking-wide text-fai-green">{item.type}</span><span className="mt-1 block font-bold text-fai-navy">{item.title}</span><span className="mt-1 flex flex-wrap justify-between gap-2 text-xs text-slate-500"><span>{item.related}</span><span>{item.date}</span></span></Link></li>)}
            </ol>
          )}
        </div>
      </div>

      {shortcuts.length > 0 && <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{shortcuts.map((shortcut) => <Link key={shortcut.href} href={shortcut.href} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm focus:outline-none focus:ring-2 focus:ring-fai-lime"><span className="font-black text-fai-navy">{shortcut.label}</span><span className="mt-1 block text-xs leading-5 text-slate-500">{shortcut.description}</span><span className="mt-3 block text-xs font-black uppercase tracking-wide text-fai-green">Apri area →</span></Link>)}</div>}
    </section>
  );
}
