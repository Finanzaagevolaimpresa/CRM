
import Link from 'next/link';
import { logoutAction } from '@/lib/login-actions';

export function Badge({ children, tone = 'blue' }: { children: React.ReactNode; tone?: 'blue' | 'green' | 'orange' | 'purple' | 'gray' | 'lime' }) {
  const tones = { blue: 'bg-fai-blue/10 text-fai-blue ring-fai-blue/15', green: 'bg-fai-green/10 text-fai-green ring-fai-green/15', orange: 'bg-fai-orange/10 text-fai-orange ring-fai-orange/20', purple: 'bg-fai-purple/10 text-fai-purple ring-fai-purple/15', gray: 'bg-slate-100 text-fai-gray ring-slate-200', lime: 'bg-fai-lime/20 text-fai-green ring-fai-lime/30' };
  return <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ${tones[tone]}`}>{children}</span>;
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
  return <div className="mt-3 grid gap-2 rounded-xl bg-slate-50 p-3 text-xs text-fai-gray md:grid-cols-2">
    <div><span className="font-bold uppercase">Creato il</span><br />{formatDateTime(createdAt)}{createdBy ? ` · da ${createdBy}` : ''}</div>
    <div><span className="font-bold uppercase">Aggiornato il</span><br />{formatDateTime(updatedAt ?? createdAt)}{updatedBy ? ` · da ${updatedBy}` : ''}</div>
  </div>;
}

export function ActivityTimeline({ events }: { events: Array<{ id: string; date: Date | string; user?: string | null; type: string; entity?: string | null; description: string; beforeAfter?: string | null }> }) {
  if (events.length === 0) return <EmptyState title="Nessun evento storico">La timeline verrà popolata con gli aggiornamenti operativi e gli audit log disponibili.</EmptyState>;
  return <ol className="space-y-3">
    {events.map((event) => <li key={event.id} className="rounded-xl border border-slate-200 p-4">
      <div className="flex flex-wrap items-center gap-2 text-xs text-fai-gray"><Badge tone="purple">{event.type}</Badge><span>{formatDateTime(event.date)}</span><span>Utente: {event.user ?? 'Sistema'}</span><span>Entità: {event.entity ?? '—'}</span></div>
      <p className="mt-2 font-semibold text-fai-navy">{event.description}</p>
      {event.beforeAfter && <p className="mt-1 text-xs text-fai-gray">{event.beforeAfter}</p>}
    </li>)}
  </ol>;
}


export function Card({ title, children, action, id }: { title: string; children: React.ReactNode; action?: React.ReactNode; id?: string }) { return <section id={id} className="scroll-mt-36 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm shadow-slate-200/70"><div className="mb-4 flex items-start justify-between gap-3"><h2 className="text-lg font-bold text-fai-navy">{title}</h2>{action}</div>{children}</section>; }

export function EmptyState({ title = 'Nessun dato disponibile', children }: { title?: string; children?: React.ReactNode }) { return <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50/70 p-6 text-center"><p className="font-semibold text-fai-navy">{title}</p><p className="mt-1 text-sm text-fai-gray">{children ?? 'Quando saranno presenti dati operativi, verranno mostrati in questa sezione.'}</p></div>; }

export function Stat({ label, value, description, href }: { label: string; value: number | string; description?: string; href?: string }) { const box = <div className="h-full rounded-2xl border border-slate-200 bg-white p-4 shadow-sm transition hover:-translate-y-0.5 hover:border-fai-blue/30 hover:shadow-md"><div className="text-3xl font-extrabold text-fai-blue">{value}</div><div className="mt-2 font-semibold text-fai-navy">{label}</div>{description && <div className="mt-1 text-xs leading-5 text-fai-gray">{description}</div>}{href && <div className="mt-3 text-xs font-bold text-fai-green">Apri sezione â†’</div>}</div>; return href ? <Link href={href}>{box}</Link> : box; }

export function Table({ headers, rows }: { headers: string[]; rows: Array<Array<React.ReactNode>> }) { return <div className="overflow-hidden rounded-xl border border-slate-200 bg-white"><table className="w-full text-sm"><thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-fai-gray"><tr>{headers.map((h) => <th className="px-4 py-3 font-bold" key={h}>{h}</th>)}</tr></thead><tbody>{rows.map((r,i)=><tr className="border-t border-slate-100 hover:bg-fai-bg/60" key={i}>{r.map((c,j)=><td className="px-4 py-3 align-top" key={j}>{c}</td>)}</tr>)}</tbody></table></div>; }

export function PageHeader({ title, description }: { title: string; description: string }) { return <header className="rounded-2xl bg-gradient-to-r from-fai-navy via-fai-blue to-fai-green p-6 text-white shadow-sm"><h1 className="text-3xl font-extrabold tracking-tight">{title}</h1><p className="mt-2 max-w-4xl text-sm leading-6 text-white/85">{description}</p></header>; }

export function Nav() { const items = [['Dashboard','/dashboard'],['Lead','/leads'],['Clienti','/clients'],['Progetti','/projects'],['Documenti','/documents'],['Pre-analisi','/preanalyses'],['Dossier','/dossiers'],['Contratti','/contracts'],['Pagamenti','/payments'],['Task','/tasks'],['AI','/ai']]; return <aside className="sticky top-0 min-h-screen w-72 bg-fai-navy p-5 text-white"><Link href="/dashboard" className="mb-7 flex items-center gap-3 rounded-2xl bg-white p-3 shadow-sm"><img src="/logo-fai.png" alt="Finanza Agevola Impresa" className="h-10 w-[68px] object-contain" /><div><div className="text-sm font-extrabold text-fai-navy">Gestionale CRM</div><div className="text-xs font-semibold text-fai-gray">Finanza Agevola Impresa</div></div></Link><nav className="space-y-1.5">{items.map(([l,h])=><Link className="group flex items-center justify-between rounded-xl px-3 py-2.5 text-sm font-semibold text-white/85 transition hover:bg-white/12 hover:text-white" href={h} key={h}><span>{l}</span><span className="text-white/25 group-hover:text-fai-lime">›</span></Link>)}</nav><form action={logoutAction} className="mt-8 border-t border-white/15 pt-5"><button className="w-full rounded-xl bg-white/10 px-3 py-2.5 text-left text-sm font-semibold hover:bg-fai-orange" type="submit">Logout</button></form></aside>; }
