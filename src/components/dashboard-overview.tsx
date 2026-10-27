import Link from "next/link";
import { DashboardIcon } from "./dashboard-icon";
import { DashboardSelectionFocus } from "./dashboard-selection-focus";
import { DashboardPreviewLink } from "./dashboard-preview-link";
import type { DashboardDetailItem } from "@/lib/dashboard-selection";
import { AnimatedCounter } from './animated-counter';
import type { DashboardCounterGroup } from "@/lib/dashboard-counter-groups";

export type DashboardKpi = {
  id?: string;
  selectionHref?: string;
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

// One distinct swatch for each of the fourteen service states, including zero states.
const pipelineColors = [
  "#043E8B", "#00693F", "#81CC2A", "#F68712", "#3D2974", "#62778F", "#C2416B",
  "#0891B2", "#A16207", "#7C3AED", "#DC2626", "#0F766E", "#B45309", "#475569",
];

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
        <div className="pointer-events-none absolute inset-0 flex min-w-0 flex-col items-center justify-center px-9 text-center"><span className="crm-counter-pipeline w-full"><AnimatedCounter value={total} /></span><span className="mt-2 text-[0.65rem] font-bold uppercase tracking-[0.14em] text-slate-500">Servizi totali</span></div>
      </div>
      {total === 0 ? <p className="rounded-xl bg-slate-50 p-4 text-xs leading-5 text-slate-500">Nessun servizio visibile nella pipeline corrente.</p> : <ul className="crm-space-y-2">{visibleSegments.map((item) => <li key={item.label} data-pipeline-legend-label={item.label} className="flex min-w-0 items-center gap-2 text-xs"><span aria-hidden="true" data-pipeline-legend-color={item.color} className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: item.color }} /><span className="min-w-0 flex-1 break-words font-semibold capitalize text-slate-600">{item.label}</span><span className="shrink-0 font-black tabular-nums text-fai-navy">{formatCount(item.value)}</span></li>)}</ul>}
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
  selectedKpiId,
  detailItems = [],
  userName,
  priorityLinks = [],
  focusSelection,
  showPipeline = true,
  perimeterLinks = [{ label: "Le mie assegnazioni", href: "/assignments" }, { label: "Progetti condivisi", href: "/shared-projects" }],
}: {
  greeting: string;
  summary: string;
  kpis: DashboardKpi[];
  priorities: DashboardPriority[];
  pipeline: Array<{ label: string; value: number }>;
  shortcuts: Array<{ label: string; description: string; href: string; icon?: string; tone?: string }>;
  counterGroups?: DashboardCounterGroup[];
  selectedKpiId?: string | null;
  detailItems?: DashboardDetailItem[];
  userName?: string;
  focusSelection?: string | null;
  priorityLinks?: Array<{ label: string; href: string; icon: string; tone: string }>;
  showPipeline?: boolean;
  perimeterLinks?: Array<{ label: string; href: string }>;
}) {
  const selected = kpis.find(item => item.id === selectedKpiId) ?? kpis.find(item => item.tone === "green") ?? kpis[0];
  const icons = { blue: "people", green: "folder", purple: "document", orange: "calendar" };
  const areaIcons = ["chart", "gear", "people", "calendar", "document", "search"];
  const areaTones = ["blue", "green", "teal", "orange", "blue", "purple"];
  return (
    <section aria-labelledby="dashboard-heading" className="crm-dashboard crm-space-y-6">
      <DashboardSelectionFocus selection={focusSelection}/>
      <header className="crm-dashboard-header">
        <div><h1 id="dashboard-heading">Dashboard</h1><p>Panoramica operativa</p><span className="sr-only">{greeting} {summary}</span></div>
        <div className="crm-dashboard-account">
          <details className="crm-perimeter-menu"><summary>Il mio perimetro <span aria-hidden="true">⌄</span></summary><div><strong>Dati accessibili al tuo profilo</strong><p>Contatori ed elenchi rispettano i tuoi permessi correnti.</p>{perimeterLinks.map(link => <Link key={link.href} href={link.href}>{link.label}</Link>)}</div></details>
          <Link href="/settings/account" className="crm-dashboard-user"><span className="crm-user-avatar"><DashboardIcon name="user"/></span><span>{userName ?? "Il mio account"}</span><span aria-hidden="true">⌄</span></Link>
        </div>
      </header>
      <div className="crm-dashboard-kpis" aria-label="Contatori operativi">
        {kpis.map(kpi => {
          const active = selected === kpi;
          return <article key={kpi.id ?? kpi.label} data-selected={active ? "true" : undefined} data-kpi={kpi.id ?? kpi.tone} data-tone={kpi.tone} className="crm-counter-hero crm-dashboard-kpi">
            <Link href={kpi.href} prefetch={false} className="crm-kpi-list-link" aria-label={`${kpi.label}: ${formatCount(kpi.value)}. Apri elenco`}>
            <div className="crm-kpi-heading"><span className="crm-kpi-icon"><DashboardIcon name={icons[kpi.tone]}/></span><h2>{kpi.label}</h2><span aria-hidden="true" className="crm-kpi-chevron">›</span></div>
            {active && <span className="crm-kpi-selected" aria-hidden="true">✓</span>}
            <div className="crm-kpi-ring">
              <svg aria-hidden="true" focusable="false" viewBox="0 0 240 240" className="crm-ring-art">
                <circle className="crm-ring-dots" cx="120" cy="120" r="113"/>
                <circle className="crm-ring-edge" cx="120" cy="120" r="104"/>
                <circle className="crm-ring-base" cx="120" cy="120" r="96"/>
                <circle className="crm-ring-light" cx="120" cy="120" r="96"/>
                <circle className="crm-ring-inner" cx="120" cy="120" r="82"/>
              </svg>
              <AnimatedCounter value={kpi.value} variant="plain"/>
            </div>
            <span className="sr-only">{kpi.description}{active ? " · Selezionato" : ""}</span>
            <span className="crm-kpi-footer">Apri elenco <span aria-hidden="true">→</span></span>
            </Link>
            {kpi.selectionHref && <DashboardPreviewLink href={kpi.selectionHref} label={kpi.label} active={active}>Anteprima</DashboardPreviewLink>}
          </article>;
        })}
      </div>

      <div className="crm-dashboard-workspace">
        <section className="crm-dashboard-areas" aria-labelledby="dashboard-areas-heading">
          <h2 id="dashboard-areas-heading">Aree operative</h2>
          <div className="crm-area-grid">{shortcuts.map((area, index) => <Link key={area.href} href={area.href} data-tone={area.tone ?? areaTones[index % areaTones.length]} className="crm-area-tile"><span className="crm-area-icon"><DashboardIcon name={area.icon ?? areaIcons[index % areaIcons.length]}/></span><span><strong>{area.label}</strong><small>{area.description}</small></span><span aria-hidden="true">›</span></Link>)}</div>
          {shortcuts.length === 0 && <p className="crm-dashboard-empty">Nessuna area operativa disponibile per il tuo profilo.</p>}
        </section>
        <section id="dashboard-detail" tabIndex={-1} className="crm-dashboard-detail" data-tone={selected?.tone ?? "blue"} aria-labelledby="dashboard-detail-heading" aria-live="polite">
          <div className="crm-detail-heading"><span className="crm-area-icon"><DashboardIcon name={selected ? icons[selected.tone] : "folder"}/></span><div><h2 id="dashboard-detail-heading">{selected?.label ?? "Dettaglio operativo"}</h2><p>Dettaglio selezionato</p></div><span aria-hidden="true">›</span></div>
          <p className="crm-detail-description">{selected?.description ?? "Nessun contatore disponibile per il tuo profilo."}</p>
          {detailItems.length > 0 ? <ul className="crm-detail-list">{detailItems.map(item => <li key={item.id}><Link href={item.href} prefetch={false}><strong>{item.title}</strong><span className="crm-detail-status">{item.status.replaceAll("_", " ")}</span><span aria-hidden="true">›</span></Link></li>)}</ul> : <p className="crm-dashboard-empty">{selected?.value ? "Apri l’elenco per consultare i record nel tuo perimetro." : "Nessun elemento nel filtro selezionato."}</p>}
          {selected && <div className="crm-detail-footer"><Link href={selected.href} prefetch={false}>Vedi elenco completo <span aria-hidden="true">→</span></Link></div>}
        </section>
        <section className="crm-dashboard-today" aria-labelledby="dashboard-today-heading"><h2 id="dashboard-today-heading">Priorità di oggi</h2><div>{priorityLinks.map(link => <Link key={link.href} href={link.href} data-tone={link.tone}><span className="crm-priority-icon"><DashboardIcon name={link.icon}/></span><span>{link.label}</span><span aria-hidden="true">›</span></Link>)}</div>{priorityLinks.length === 0 && <p className="crm-dashboard-empty">Le attività disponibili sono riportate nel riepilogo seguente.</p>}</section>
      </div>
      <p className="crm-dashboard-data-note">{summary}</p>

      {counterGroups.length > 0 && <section aria-labelledby="counter-areas-heading" className="crm-space-y-4">
        <div className="flex items-center gap-3"><span aria-hidden="true" className="h-7 w-1.5 rounded-full bg-fai-lime" /><h2 id="counter-areas-heading" className="text-xl font-black tracking-tight text-fai-navy">Contatori per area</h2></div>
        <div className="grid items-start gap-4 md:grid-cols-2 xl:grid-cols-3">
          {counterGroups.map((group) => {
            const maximum = Math.max(0, ...group.counters.map((counter) => counter.value));
            const showComparison = group.counters.length > 1;
            return <section key={group.id} data-tone={group.tone} aria-labelledby={`counter-area-${group.id}`} className="crm-counter-panel min-w-0 rounded-2xl p-4">
              <div className="flex items-center gap-3"><span className="crm-counter-icon flex h-12 w-12 shrink-0 items-center justify-center rounded-xl"><AreaIcon id={group.id} /></span><h3 id={`counter-area-${group.id}`} className="min-w-0 text-base font-black leading-5 text-fai-navy">{group.title}</h3></div>
              <p className="mt-3 text-xs leading-5 text-slate-600">{group.description}</p>
              {showComparison && <p className="mt-1 text-[0.65rem] leading-5 text-slate-600">Scala dei conteggi: 0–{formatCount(maximum)} · confronto, non avanzamento</p>}
              <div className="mt-3 grid grid-cols-[repeat(auto-fit,minmax(min(100%,8.5rem),1fr))] gap-3">
                {group.counters.map((counter) => {
                  const width = maximum > 0 ? counter.value / maximum * 100 : 0;
                  const content = <>
                    <span className="min-w-0 break-words text-xs font-bold leading-5 text-fai-navy">{counter.label}<span className="sr-only"> — {counter.description}</span></span>
                    <AnimatedCounter value={counter.value} />
                    {showComparison && <span aria-hidden="true" className="crm-counter-scale mt-4 block h-2 w-full overflow-hidden"><span data-counter-value={counter.value} data-counter-max={maximum} data-counter-width={width} className="crm-counter-bar block h-full" style={{ width: `${width}%` }} /></span>}
                  </>;
                  const cardClass = "crm-counter-cell flex min-h-36 min-w-0 flex-col justify-between rounded-xl p-3";
                  return counter.href ? <Link key={counter.label} href={counter.href} className={cardClass}>{content}</Link> : <div key={counter.label} className={cardClass}>{content}</div>;
                })}
              </div>
            </section>;
          })}
        </div>
      </section>}

      {showPipeline && <PipelineChart pipeline={pipeline} />}

      <section aria-labelledby="dashboard-priorities-heading" className="rounded-3xl border border-slate-200 bg-white p-5 shadow-xs">
        <div className="flex items-start justify-between gap-4"><div><h2 id="dashboard-priorities-heading" className="text-xl font-black text-fai-navy">Priorità</h2><p className="mt-1 text-sm text-slate-500">Le prossime attività autorizzate per urgenza.</p></div><span className="rounded-full bg-fai-lime/20 px-3 py-1 text-xs font-black tabular-nums text-fai-green">{priorities.length}</span></div>
        {priorities.length === 0 ? <p className="mt-6 rounded-xl bg-slate-50 p-5 text-sm text-slate-500">Nessuna priorità operativa al momento.</p> : (
          <ol className="mt-4 crm-divide-y crm-divide-slate-100">
            {priorities.map((item) => <li key={item.id} className="py-3"><Link href={item.href} className="block min-h-11 rounded-lg focus:outline-compat focus:ring-2 focus:ring-fai-lime"><span className="text-[0.65rem] font-black uppercase tracking-wide text-fai-green">{item.type}</span><span className="mt-1 block font-bold text-fai-navy">{item.title}</span><span className="mt-1 flex flex-wrap justify-between gap-2 text-xs text-slate-500"><span>{item.related}</span><span>{item.date}</span></span></Link></li>)}
          </ol>
        )}
      </section>


    </section>
  );
}
