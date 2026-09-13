import Link from "next/link";
import type { DashboardCounterGroup } from "@/lib/dashboard-counter-groups";

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
  blue: {
    badge: "bg-blue-50 text-fai-blue ring-blue-100",
    hero: "from-[#052E70] via-[#043E8B] to-[#0b547f]",
    surface: "from-blue-50/80 to-white",
    ink: "text-fai-blue",
    bar: "from-[#043E8B] to-[#367abb]",
  },
  green: {
    badge: "bg-emerald-50 text-fai-green ring-emerald-100",
    hero: "from-[#064c36] via-[#00693F] to-[#397d36]",
    surface: "from-emerald-50/80 to-white",
    ink: "text-fai-green",
    bar: "from-[#00693F] to-[#81CC2A]",
  },
  orange: {
    badge: "bg-orange-50 text-fai-orange ring-orange-100",
    hero: "from-[#743510] via-[#95400c] to-[#aa4c0e]",
    surface: "from-orange-50/80 to-white",
    ink: "text-[#a7460b]",
    bar: "from-[#b55013] to-[#F68712]",
  },
  purple: {
    badge: "bg-violet-50 text-fai-purple ring-violet-100",
    hero: "from-[#2c2055] via-[#3D2974] to-[#63418c]",
    surface: "from-violet-50/80 to-white",
    ink: "text-fai-purple",
    bar: "from-[#3D2974] to-[#8666b4]",
  },
};

// One distinct swatch for each of the fourteen service states, including zero states.
const pipelineColors = [
  "#043E8B", "#00693F", "#81CC2A", "#F68712", "#3D2974", "#62778F", "#C2416B",
  "#0891B2", "#A16207", "#7C3AED", "#DC2626", "#0F766E", "#B45309", "#475569",
];

function KpiIcon({ tone, className = "h-6 w-6" }: { tone: DashboardKpi["tone"]; className?: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className={className}>
      {tone === "blue" && <><circle cx="9" cy="8" r="3" /><path d="M3 20c0-4 2-7 6-7s6 3 6 7M16 6a3 3 0 0 1 0 6M17 14c2.5.5 4 2.5 4 5" /></>}
      {tone === "green" && <><path d="M7 3h8l4 4v14H7z" /><path d="M15 3v5h5M10 12h6M10 16h6" /></>}
      {tone === "orange" && <><circle cx="12" cy="12" r="9" /><path d="M12 7v6l4 2" /></>}
      {tone === "purple" && <><path d="M5 12.5 10 17l9-10" /><circle cx="12" cy="12" r="9" /></>}
    </svg>
  );
}

function AreaIcon({ id }: { id: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="h-6 w-6">
      {id === "commerciale" && <><rect x="3" y="7" width="18" height="14" rx="3" /><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 12c5 4 13 4 18 0M10 13h4" /></>}
      {id === "ufficio-tecnico" && <><path d="m4 20 5-1L20 8l-4-4L5 15l-1 5ZM13 7l4 4M4 4h5M4 8h3M16 20h4v-4" /><path d="m16 4 1-1a2 2 0 0 1 3 3l-1 1" /></>}
      {id === "clienti-servizi" && <><circle cx="9" cy="7" r="3" /><path d="M3 20v-3a6 6 0 0 1 12 0v3M16 4a3 3 0 0 1 0 6M18 14v6M15 17h6" /></>}
      {id === "attivita-scadenze" && <><rect x="3" y="5" width="18" height="16" rx="3" /><path d="M7 3v4M17 3v4M3 11h18M8 15h2M14 15h2M8 18h2" /></>}
      {id === "amministrazione" && <><path d="m12 3 9 5H3l9-5ZM4 21h16M5 18h14M6 11v7M12 11v7M18 11v7" /></>}
      {id === "revisioni-autorizzazioni" && <><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z" /><path d="m8 12 3 3 5-6" /></>}
    </svg>
  );
}

function formatCount(value: number) {
  return value.toLocaleString("it-IT");
}

function PipelineChart({ pipeline }: { pipeline: Array<{ label: string; value: number }> }) {
  const total = pipeline.reduce((sum, item) => sum + item.value, 0);
  const segments = pipeline.map((item, index) => {
    const share = total > 0 ? item.value / total * 100 : 0;
    const precedingTotal = pipeline.slice(0, index).reduce((sum, previous) => sum + previous.value, 0);
    const offset = total > 0 ? precedingTotal / total * 100 : 0;
    return { ...item, share, offset, color: pipelineColors[index] ?? `hsl(${index * 137.508} 60% 40%)` };
  });
  const visibleSegments = segments.filter((item) => item.value > 0);
  return (
    <section id="pipeline-pratiche" aria-labelledby="pipeline-heading" className="min-w-0 scroll-mt-4 rounded-3xl border border-slate-200 bg-white p-5 shadow-[0_8px_30px_-20px_rgba(5,46,112,0.4)]">
      <div><p className="text-[0.65rem] font-black uppercase tracking-[0.2em] text-fai-green">Stato dei servizi</p><h2 id="pipeline-heading" className="mt-1 text-xl font-black text-fai-navy">Pipeline pratiche</h2><p className="mt-1 text-xs leading-5 text-slate-500">Distribuzione corrente dei servizi accessibili.</p></div>
      <div className="relative mx-auto my-4 h-44 w-44 max-w-full">
        <svg role="img" aria-label="Distribuzione dei servizi per stato" data-pipeline-total={total} viewBox="0 0 200 200" className="h-full w-full">
          <circle cx="100" cy="100" r="78" fill="none" stroke="#e9eef4" strokeWidth="23" />
          {visibleSegments.map((item) => <circle key={item.label} data-pipeline-label={item.label} data-pipeline-value={item.value} data-pipeline-share={item.share} cx="100" cy="100" r="78" pathLength="100" fill="none" stroke={item.color} strokeWidth="23" strokeDasharray={`${item.share} ${100 - item.share}`} strokeDashoffset={-item.offset} transform="rotate(-90 100 100)"><title>{`${item.label}: ${formatCount(item.value)} servizi`}</title></circle>)}
          {visibleSegments.length > 1 && visibleSegments.map((item) => {
            const angle = (item.offset / 100 * 360 - 90) * Math.PI / 180;
            return <line key={item.label} aria-hidden="true" data-pipeline-boundary={item.label} x1={100 + 90.5 * Math.cos(angle)} y1={100 + 90.5 * Math.sin(angle)} x2={100 + 95 * Math.cos(angle)} y2={100 + 95 * Math.sin(angle)} stroke="#475569" strokeWidth="1.25" />;
          })}
        </svg>
        <div className="pointer-events-none absolute inset-0 flex min-w-0 flex-col items-center justify-center px-9 text-center"><span className={`max-w-full break-all font-black leading-none tracking-tight tabular-nums text-fai-navy ${formatCount(total).length > 7 ? "text-xl" : formatCount(total).length > 5 ? "text-2xl" : "text-4xl"}`}>{formatCount(total)}</span><span className="mt-2 text-[0.65rem] font-bold uppercase tracking-[0.14em] text-slate-500">Servizi totali</span></div>
      </div>
      {total === 0 ? <p className="rounded-xl bg-slate-50 p-4 text-xs leading-5 text-slate-500">Nessun servizio visibile nella pipeline corrente.</p> : <ul className="space-y-2">{visibleSegments.map((item) => <li key={item.label} data-pipeline-legend-label={item.label} className="flex min-w-0 items-center gap-2 text-xs"><span aria-hidden="true" data-pipeline-legend-color={item.color} className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: item.color }} /><span className="min-w-0 flex-1 break-words font-semibold capitalize text-slate-600">{item.label}</span><span className="shrink-0 font-black tabular-nums text-fai-navy">{formatCount(item.value)}</span></li>)}</ul>}
    </section>
  );
}

export function DashboardOverview({
  greeting,
  summary,
  kpis,
  priorities,
  pipeline,
  shortcuts,
  counterGroups = [],
}: {
  greeting: string;
  summary: string;
  kpis: DashboardKpi[];
  priorities: DashboardPriority[];
  pipeline: Array<{ label: string; value: number }>;
  shortcuts: Array<{ label: string; description: string; href: string }>;
  counterGroups?: DashboardCounterGroup[];
}) {
  return (
    <section aria-labelledby="dashboard-heading" className="space-y-6">
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

      <div className="grid items-stretch gap-4 xl:grid-cols-[minmax(0,1.8fr)_minmax(17rem,1fr)]">
        <div className="grid min-w-0 gap-4 sm:grid-cols-2">
          {kpis.map((kpi) => (
            <Link key={kpi.label} href={kpi.href} className={`group relative isolate flex min-h-48 min-w-0 flex-col justify-between overflow-hidden rounded-3xl bg-gradient-to-br p-5 text-white shadow-[0_12px_32px_-20px_rgba(5,46,112,0.65)] ring-1 ring-black/5 hover:ring-2 hover:ring-fai-lime focus:outline-none focus:ring-2 focus:ring-fai-lime ${toneStyles[kpi.tone].hero}`}>
              <div aria-hidden="true" className="pointer-events-none absolute -right-4 -top-5 h-32 w-32 rounded-full border-[20px] border-white/[0.04]" />
              <div aria-hidden="true" className="pointer-events-none absolute -bottom-4 right-1 -z-10 rotate-[-12deg] text-white/[0.07]"><KpiIcon tone={kpi.tone} className="h-36 w-36" /></div>
              <div className="relative flex items-start justify-between gap-3"><p className="max-w-[14rem] text-sm font-bold leading-5 text-white/95">{kpi.label}</p><span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-white/20 bg-white/10"><KpiIcon tone={kpi.tone} /></span></div>
              <div className="relative mt-4"><p className={`break-all font-black leading-none tracking-[-0.055em] tabular-nums ${formatCount(kpi.value).length > 7 ? "text-4xl" : "text-6xl"}`}>{formatCount(kpi.value)}</p><p className="mt-3 max-w-[18rem] text-xs leading-5 text-white/85">{kpi.description}</p></div>
            </Link>
          ))}
        </div>
        <PipelineChart pipeline={pipeline} />
      </div>

      {counterGroups.length > 0 && <section aria-labelledby="counter-areas-heading" className="space-y-4">
        <div className="flex items-center gap-3"><span aria-hidden="true" className="h-7 w-1.5 rounded-full bg-fai-lime" /><h2 id="counter-areas-heading" className="text-xl font-black tracking-tight text-fai-navy">Contatori per area</h2></div>
        <div className="grid items-start gap-4 md:grid-cols-2 xl:grid-cols-3">
          {counterGroups.map((group) => {
            const maximum = Math.max(0, ...group.counters.map((counter) => counter.value));
            const showComparison = group.counters.length > 1;
            return <section key={group.id} aria-labelledby={`counter-area-${group.id}`} className={`min-w-0 overflow-hidden rounded-3xl border border-slate-200 bg-gradient-to-br p-4 shadow-[0_8px_24px_-20px_rgba(5,46,112,0.4)] ${toneStyles[group.tone].surface}`}>
              <div className="flex items-center gap-3"><span className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-white shadow-sm ring-1 ${toneStyles[group.tone].badge}`}><AreaIcon id={group.id} /></span><h3 id={`counter-area-${group.id}`} className="min-w-0 text-base font-black leading-5 text-fai-navy">{group.title}</h3></div>
              <p className="mt-3 text-xs leading-5 text-slate-600">{group.description}</p>
              {showComparison && <p className="mt-1 text-[0.65rem] leading-5 text-slate-500">Scala dei conteggi: 0–{formatCount(maximum)}</p>}
              <div className="mt-3 grid grid-cols-[repeat(auto-fit,minmax(min(100%,8.5rem),1fr))] gap-3">
                {group.counters.map((counter) => {
                  const width = maximum > 0 ? counter.value / maximum * 100 : 0;
                  const content = <>
                    <span className="min-w-0 break-words text-xs font-bold leading-5 text-slate-600">{counter.label}<span className="sr-only"> — {counter.description}</span></span>
                    <span className={`mt-3 block break-all font-black leading-none tracking-[-0.04em] tabular-nums ${toneStyles[group.tone].ink} ${formatCount(counter.value).length > 7 ? "text-xl" : formatCount(counter.value).length > 5 ? "text-2xl" : "text-4xl"}`}>{formatCount(counter.value)}</span>
                    {showComparison && <span aria-hidden="true" className="mt-4 block h-1.5 w-full overflow-hidden rounded-full bg-slate-100"><span data-counter-value={counter.value} data-counter-max={maximum} data-counter-width={width} className={`block h-full rounded-full bg-gradient-to-r ${toneStyles[group.tone].bar}`} style={{ width: `${width}%` }} /></span>}
                  </>;
                  const cardClass = "flex min-h-32 min-w-0 flex-col justify-between rounded-2xl border border-white bg-white p-3 shadow-[0_2px_12px_-8px_rgba(5,46,112,0.35)]";
                  return counter.href ? <Link key={counter.label} href={counter.href} className={`${cardClass} hover:ring-1 hover:ring-fai-green/30 focus:outline-none focus:ring-2 focus:ring-fai-lime`}>{content}</Link> : <div key={counter.label} className={cardClass}>{content}</div>;
                })}
              </div>
            </section>;
          })}
        </div>
      </section>}

      <section aria-labelledby="dashboard-priorities-heading" className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex items-start justify-between gap-4"><div><h2 id="dashboard-priorities-heading" className="text-xl font-black text-fai-navy">Priorità</h2><p className="mt-1 text-sm text-slate-500">Le prossime attività autorizzate per urgenza.</p></div><span className="rounded-full bg-fai-lime/20 px-3 py-1 text-xs font-black tabular-nums text-fai-green">{priorities.length}</span></div>
        {priorities.length === 0 ? <p className="mt-6 rounded-xl bg-slate-50 p-5 text-sm text-slate-500">Nessuna priorità operativa al momento.</p> : (
          <ol className="mt-4 divide-y divide-slate-100">
            {priorities.map((item) => <li key={item.id} className="py-3"><Link href={item.href} className="block min-h-11 rounded-lg focus:outline-none focus:ring-2 focus:ring-fai-lime"><span className="text-[0.65rem] font-black uppercase tracking-wide text-fai-green">{item.type}</span><span className="mt-1 block font-bold text-fai-navy">{item.title}</span><span className="mt-1 flex flex-wrap justify-between gap-2 text-xs text-slate-500"><span>{item.related}</span><span>{item.date}</span></span></Link></li>)}
          </ol>
        )}
      </section>

      {shortcuts.length > 0 && <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{shortcuts.map((shortcut) => <Link key={shortcut.href} href={shortcut.href} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm focus:outline-none focus:ring-2 focus:ring-fai-lime"><span className="font-black text-fai-navy">{shortcut.label}</span><span className="mt-1 block text-xs leading-5 text-slate-500">{shortcut.description}</span><span className="mt-3 block text-xs font-black uppercase tracking-wide text-fai-green">Apri area →</span></Link>)}</div>}
    </section>
  );
}
