import Link from 'next/link';
import { randomUUID } from 'node:crypto';
import type { Lead } from '@prisma/client';
import { Card, formatDateTime } from './ui';
import { prisma } from '@/lib/prisma';
import { LeadSetterForm } from './lead-setter-form';
import { setterDetails, setterFields, riskFields, riskOrigins, setterOutcomes, assistanceOptions, type SetterOutcome } from '@/lib/lead-setter-contract';
import { isTechnicalAccount } from '@/lib/technical-confidentiality';
import { hasPermission, type AuthSession } from '@/lib/auth';
import { leadVisibilityWhere } from '@/lib/core-query-policy';

export async function LeadSetterPanel({ session, lead, item }: { session: AuthSession; lead: Lead; item: { state: string; version: number } | null }) {
  if (isTechnicalAccount(session) || !hasPermission(session,'lead.read')) return null;
  const calls = await prisma.leadSetterCall.findMany({ where: { leadId: lead.id, lead: { deletedAt: null, AND: [leadVisibilityWhere(session)] } },
    orderBy: [{ recordedAt: 'desc' }, { id: 'asc' }], include: { actor: { select: { name: true } } } });
  const open = !lead.clientId && (!item || item.state === 'OPEN') && !['archiviato','perso','vinto','cliente_acquisito','non_qualificato'].includes(lead.status);
  const defaults = { project: lead.interest ?? '', site: [lead.city,lead.province,lead.region].filter(Boolean).join(', '),
    investment: lead.declaredInvestment?.toString(), financing: lead.requestedAmount?.toString() };
  return <><Card title="Registra chiamata">
    {lead.availableBudget != null && <p>Budget disponibile indicato nel lead: {lead.availableBudget.toString()} €.</p>}
    {open && lead.assignedToId === session.userId && hasPermission(session,'lead.write')
      ? <LeadSetterForm leadId={lead.id} actorId={session.userId} confirmedIds={calls.filter(c => c.actorId === session.userId).map(c => c.id)} initialId={randomUUID()} version={item?.version ?? null} leadVersion={lead.updatedAt.toISOString()}
          defaults={defaults} scheduledVideo={lead.setterNextKind === 'VIDEO'}/>
      : <p>Il referente nominativo può registrare le telefonate mentre il lead è aperto.</p>}
    <nav className="mt-4 flex flex-wrap gap-4"><Link href="/leads/work?queue=callbacks" className="underline">Richiami di oggi</Link>
      <Link href="/leads/work?queue=overdue" className="underline">Scaduti</Link><Link href="/leads/work?queue=videos" className="underline">Videochiamate fissate</Link></nav>
  </Card><Card title="Storico telefonate e riepilogo per il consulente">
    {!calls.length && <p>Nessuna telefonata registrata.</p>}
    {calls.map(call => { const details = setterDetails.safeParse(call.details);
      return <details key={call.id} className="border-b py-2"><summary>{setterOutcomes[call.outcome as SetterOutcome]} · {call.actor.name} · {formatDateTime(call.recordedAt)}</summary>
        {call.nextAt && <p>{call.nextKind === 'VIDEO' ? 'Videochiamata' : 'Richiamo'} · {call.nextKind === 'VIDEO' ? formatDateTime(call.nextAt) : call.nextAt.toLocaleDateString('it-IT',{ timeZone:'Europe/Rome' })}</p>}
        {details.success && <dl>{Object.entries(setterFields).map(([k,label]) => { const v = details.data[k as keyof typeof setterFields];
          return v ? <div key={k}><dt className="font-bold">{label}</dt><dd>{v}</dd></div> : null; })}
          {Object.entries(riskFields).map(([k,label]) => { const r = details.data[k as keyof typeof riskFields];
            return <div key={k}><dt className="font-bold">{label}</dt><dd>{[riskOrigins[r.origin],r.finding,r.source,r.date].filter(Boolean).join(' · ')}</dd></div>; })}
          <dt className="font-bold">Disponibilità per l’assistenza</dt><dd>{assistanceOptions[details.data.assistance]}</dd></dl>}
      </details>; })}
  </Card></>;
}
