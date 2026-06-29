import Link from 'next/link';
import { logoutAction } from '@/lib/login-actions';
import { NavLinks } from '@/components/nav-links';

export function Badge({ children, tone = 'blue' }: { children: React.ReactNode; tone?: 'blue' | 'green' | 'orange' | 'purple' | 'gray' | 'lime' }) {
  const tones = {
    blue: 'bg-fai-blue/10 text-fai-blue ring-fai-blue/20',
    green: 'bg-fai-teal/10 text-fai-green ring-fai-teal/20',
    orange: 'bg-fai-orange/10 text-fai-orange ring-fai-orange/25',
    purple: 'bg-fai-purple/10 text-fai-purple ring-fai-purple/20',
    gray: 'bg-slate-100 text-slate-600 ring-slate-200',
    lime: 'bg-fai-lime/20 text-fai-green ring-fai-lime/35',
  };
  return <span className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-extrabold uppercase tracking-wide ring-1 ${tones[tone]}`}>{children}</span>;
}

export function statusTone(status?: string | null): 'blue' | 'green' | 'orange' | 'purple' | 'gray' | 'lime' {
  const s = (status ?? '').toLowerCase();
  if (s.includes('approv') || s.includes('incassato') || s.includes('firmato') || s.includes('pagato') || s.includes('attivo')) return 'green';
  if (s.includes('review') || s.includes('revision') || s.includes('bozza') || s.includes('prepar')) return 'orange';
  if (s.includes('ai') || s.includes('analisi')) return 'purple';
  if (s.includes('scad') || s.includes('flag') || s.includes('respinto') || s.includes('reject')) return 'orange';
  if (s.includes('chiuso') || s.includes('archivi')) return 'gray';
  return 'blue';
}

export function StatusBadge({ status }: { status?: string | null }) { return <Badge tone={statusTone(status)}>{(status ?? 'non definito').replaceAll('_', ' ')}</Badge>; }

export function formatDateTime(value?: Date | string | null) {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  return new Intl.DateTimeFormat('it-IT', { dateStyle: 'short', timeStyle: 'short' }).format(date);
}

export function TimestampMeta({ createdAt, updatedAt, createdBy, updatedBy }: { createdAt?: Date | string | null; updatedAt?: Date | string | null; createdBy?: string | null; updatedBy?: string | null }) {
  return <div className="mt-4 grid gap-3 rounded-2xl border border-white/70 bg-slate-50/80 p-4 text-xs text-slate-600 shadow-inner shadow-slate-200/60 md:grid-cols-2">
    <div><span className="font-extrabold uppercase tracking-wide text-fai-navy">Creato il</span><br />{formatDateTime(createdAt)}{createdBy ? ` · da ${createdBy}` : ''}</div>
    <div><span className="font-extrabold uppercase tracking-wide text-fai-navy">Aggiornato il</span><br />{formatDateTime(updatedAt ?? createdAt)}{updatedBy ? ` · da ${updatedBy}` : ''}</div>
  </div>;
}

export function MetaCell({ createdAt, updatedAt, owner }: { createdAt?: Date | string | null; updatedAt?: Date | string | null; owner?: string | null }) {
  return <div className="space-y-1 text-xs leading-5 text-slate-500">
    <div><span className="font-black uppercase tracking-wide text-slate-600">Creato il</span> {formatDateTime(createdAt)}</div>
    <div><span className="font-black uppercase tracking-wide text-slate-600">Aggiornato il</span> {formatDateTime(updatedAt ?? createdAt)}</div>
    {owner !== undefined && <div><span className="font-black uppercase tracking-wide text-slate-600">Responsabile</span> {owner || 'Da assegnare'}</div>}
  </div>;
}

export function ActivityTimeline({ events }: { events: Array<{ id: string; date: Date | string; user?: string | null; type: string; entity?: string | null; description: string; beforeAfter?: string | null }> }) {
  if (events.length === 0) return <EmptyState title="Nessun evento storico">La timeline verrà popolata con gli aggiornamenti operativi e gli audit log disponibili.</EmptyState>;
  return <ol className="relative space-y-4 before:absolute before:left-4 before:top-2 before:h-[calc(100%-1rem)] before:w-px before:bg-gradient-to-b before:from-fai-lime before:via-fai-blue/30 before:to-transparent">
    {events.map((event) => <li key={event.id} className="relative pl-11"><span className="absolute left-2 top-5 h-4 w-4 rounded-full border-2 border-white bg-fai-lime shadow-lg shadow-fai-lime/30" /><div className="rounded-2xl border border-slate-200/80 bg-white/90 p-4 shadow-sm shadow-slate-200/70 transition hover:border-fai-blue/25 hover:shadow-md">
      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500"><Badge tone="purple">{event.type}</Badge><span>{formatDateTime(event.date)}</span><span>Owner: {event.user ?? 'Sistema'}</span><span>Entità: {event.entity ?? '—'}</span></div>
      <p className="mt-2 font-semibold leading-6 text-fai-navy">{event.description}</p>
      {event.beforeAfter && <p className="mt-1 text-xs leading-5 text-slate-500">{event.beforeAfter}</p>}
    </div></li>)}
  </ol>;
}

export function Card({ title, children, action, id }: { title: string; children: React.ReactNode; action?: React.ReactNode; id?: string }) { return <section id={id} className="scroll-mt-36 rounded-[1.75rem] border border-white/75 bg-white/90 p-6 shadow-xl shadow-slate-200/60 ring-1 ring-slate-900/5 backdrop-blur"><div className="mb-5 flex items-start justify-between gap-3"><div><p className="mb-1 h-1 w-12 rounded-full bg-gradient-to-r from-fai-lime to-fai-orange" /><h2 className="text-xl font-extrabold tracking-tight text-fai-navy">{title}</h2></div>{action}</div>{children}</section>; }

export function EmptyState({ title = 'Nessun dato disponibile', children }: { title?: string; children?: React.ReactNode }) { return <div className="rounded-2xl border border-dashed border-fai-blue/25 bg-gradient-to-br from-white to-fai-bg p-8 text-center shadow-inner"><p className="font-extrabold text-fai-navy">{title}</p><p className="mx-auto mt-2 max-w-2xl text-sm leading-6 text-slate-500">{children ?? 'Quando saranno presenti dati operativi, verranno mostrati in questa sezione.'}</p></div>; }

export function Stat({ label, value, description, href, tone = 'blue' }: { label: string; value: number | string; description?: string; href?: string; tone?: 'blue' | 'green' | 'orange' | 'purple' | 'lime' }) { const toneClass = { blue: 'from-fai-blue to-fai-navy', green: 'from-fai-green to-fai-teal', orange: 'from-fai-orange to-amber-500', purple: 'from-fai-purple to-fai-blue', lime: 'from-fai-lime to-fai-green' }[tone]; const box = <div className="group relative h-full overflow-hidden rounded-[1.5rem] border border-white/75 bg-white p-5 shadow-lg shadow-slate-200/70 ring-1 ring-slate-900/5 transition duration-300 hover:-translate-y-1 hover:shadow-2xl hover:shadow-fai-blue/10"><div className={`absolute inset-x-0 top-0 h-1.5 bg-gradient-to-r ${toneClass}`} /><div className="absolute -right-8 -top-8 h-24 w-24 rounded-full bg-fai-lime/10 blur-2xl transition group-hover:bg-fai-orange/15" /><div className={`bg-gradient-to-br ${toneClass} bg-clip-text text-4xl font-black tracking-tight text-transparent`}>{value}</div><div className="mt-3 font-extrabold text-fai-navy">{label}</div>{description && <div className="mt-2 text-xs leading-5 text-slate-500">{description}</div>}{href && <div className="mt-4 text-xs font-black uppercase tracking-wide text-fai-green">Apri sezione →</div>}</div>; return href ? <Link href={href}>{box}</Link> : box; }

export function Table({ headers, rows }: { headers: string[]; rows: Array<Array<React.ReactNode>> }) { return <div className="overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-sm"><table className="w-full text-sm"><thead className="bg-gradient-to-r from-slate-50 to-fai-bg text-left text-xs uppercase tracking-wider text-slate-500"><tr>{headers.map((h) => <th className="px-4 py-3.5 font-black" key={h}>{h}</th>)}</tr></thead><tbody>{rows.map((r,i)=><tr className="border-t border-slate-100 transition hover:bg-fai-lime/5" key={i}>{r.map((c,j)=><td className="px-4 py-4 align-top text-slate-700" key={j}>{c}</td>)}</tr>)}</tbody></table></div>; }

export function PageHeader({ title, description }: { title: string; description: string }) { return <header className="relative overflow-hidden rounded-[2rem] bg-fai-navy p-8 text-white shadow-2xl shadow-fai-blue/20"><div className="absolute inset-0 bg-[radial-gradient(circle_at_20%_20%,rgba(128,204,42,.35),transparent_28%),radial-gradient(circle_at_85%_10%,rgba(246,134,18,.24),transparent_24%),linear-gradient(135deg,#052E70,#043E8A_45%,#00683E)]" /><div className="absolute right-6 top-6 h-28 w-28 rounded-full border border-white/15" /><div className="relative"><p className="mb-3 inline-flex rounded-full bg-white/12 px-3 py-1 text-xs font-black uppercase tracking-[0.24em] text-fai-lime ring-1 ring-white/15">Control center FAI</p><h1 className="max-w-5xl text-4xl font-black tracking-tight md:text-5xl">{title}</h1><p className="mt-4 max-w-4xl text-sm leading-7 text-white/86">{description}</p></div></header>; }

export function Nav({ role }: { role?: import('@prisma/client').RoleCode | null }) { return <aside className="sticky top-0 min-h-screen w-72 overflow-hidden bg-fai-navy p-5 text-white shadow-2xl shadow-fai-navy/25"><div className="absolute inset-0 bg-[radial-gradient(circle_at_20%_0%,rgba(128,204,42,.22),transparent_28%),radial-gradient(circle_at_100%_35%,rgba(61,41,116,.42),transparent_28%)]" /><div className="relative"><Link href="/dashboard" className="mb-8 flex items-center gap-3 rounded-3xl border border-white/10 bg-white p-3 shadow-xl"><img src="/logo-fai.png" alt="Finanza Agevola Impresa" className="h-11 w-[74px] object-contain" /><div><div className="text-sm font-black text-fai-navy">Gestionale CRM</div><div className="text-xs font-bold text-slate-500">Finanza Agevola Impresa</div></div></Link><NavLinks role={role} /><form action={logoutAction} className="mt-8 border-t border-white/15 pt-5"><button className="w-full rounded-2xl bg-white/10 px-4 py-3 text-left text-sm font-bold text-white transition hover:bg-fai-orange focus:outline-none focus:ring-2 focus:ring-fai-lime" type="submit">Logout</button></form></div></aside>; }
