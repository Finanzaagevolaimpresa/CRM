import { PrimaryButton, SecondaryLink } from '@/components/actions';
import { PaginationNav } from '@/components/pagination-nav';
import { Card, EmptyState, PageHeader, StatusBadge, formatDateTime } from '@/components/ui';
import { requirePermission } from '@/lib/auth';
import {
  coreQueryFetchSize,
  coreQueryOffset,
  parseCoreQueryPage,
  toCoreQueryPage,
} from '@/lib/core-query-policy';
import { resolveLeadDuplicateCaseAndRefresh } from '@/lib/form-actions';
import { internalSessionMode } from '@/lib/session';
import { listLeadDuplicateReviewCases } from '@/lib/lead-duplicate-review';
import { prisma } from '@/lib/prisma';
import { privilegedAccessReadiness } from '@/lib/privileged-access';

function displayIdentity(parts: readonly (string | null | undefined)[]) {
  return parts.filter(Boolean).join(' ') || 'Dato non disponibile';
}

export default async function Page({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | undefined>>;
}) {
  const session = await requirePermission('lead.duplicate.resolve');
  const params = (await searchParams) ?? {};
  const pageNumber = parseCoreQueryPage(params.page);
  const [rows, readiness] = await Promise.all([
    listLeadDuplicateReviewCases(prisma, {
      skip: coreQueryOffset(pageNumber),
      take: coreQueryFetchSize(),
    }),
    privilegedAccessReadiness(session),
  ]);
  const page = toCoreQueryPage(rows, pageNumber);
  let registrySession = false;
  try {
    registrySession = internalSessionMode() === 'registry' && Boolean(session.sessionId);
  } catch {
    // Invalid session configuration keeps operator decisions unavailable.
  }
  const decisionsAvailable = readiness.active && registrySession;

  return <div className="space-y-6">
    <PageHeader
      title="Revisione possibili duplicati"
      description="Coda protetta N13: confronta soltanto i segnali necessari e registra una decisione non distruttiva."
    />
    <div className="flex flex-wrap gap-3">
      <SecondaryLink href="/leads">← Pipeline</SecondaryLink>
      <SecondaryLink href="/audit-log">Audit log</SecondaryLink>
      {!decisionsAvailable && <SecondaryLink href="/settings/security">Abilita verifica privilegiata</SecondaryLink>}
    </div>
    {!decisionsAvailable && <EmptyState title="Decisioni protette non disponibili">
      Puoi consultare la coda, ma per decidere servono modalità registry e verifica privilegiata valida.
    </EmptyState>}
    {page.items.length === 0 ? <EmptyState title="Nessun caso aperto">
      Non risultano proiezioni N13 in attesa di decisione.
    </EmptyState> : <div className="space-y-5">
      {page.items.map((item) => <Card
        key={item.caseId}
        title={`Caso ricevuto ${formatDateTime(item.incoming.occurredAt)}`}
      >
        <div className="flex flex-wrap items-center gap-2 text-sm text-slate-600">
          <StatusBadge status="REVIEW_REQUIRED" />
          <span>Revisione {item.discoveryRevision}</span>
          <span>·</span>
          <span>{item.candidateCount} candidati</span>
          <span>·</span>
          <span>Sorgente {item.incoming.sourceSystem}/{item.incoming.formCode}</span>
        </div>
        {item.previousDecision && <p className="mt-3 rounded-xl bg-amber-50 p-3 text-sm text-amber-900">
          Decisione precedente: {item.previousDecision.outcome} ({item.previousDecision.reasonCode}),
          registrata {formatDateTime(item.previousDecision.createdAt)}.
        </p>}
        <section className="mt-4 rounded-2xl border border-fai-blue/15 bg-fai-blue/5 p-4">
          <h2 className="font-extrabold text-fai-navy">Dati ricevuti da confrontare</h2>
          <dl className="mt-3 grid gap-2 text-sm md:grid-cols-2">
            <div><dt className="font-bold text-slate-500">Persona</dt><dd>{displayIdentity([item.incoming.firstName, item.incoming.lastName])}</dd></div>
            <div><dt className="font-bold text-slate-500">Azienda</dt><dd>{item.incoming.companyName || '—'}</dd></div>
            <div><dt className="font-bold text-slate-500">Email</dt><dd>{item.incoming.email || '—'}</dd></div>
            <div><dt className="font-bold text-slate-500">Telefono</dt><dd>{item.incoming.phone || '—'}</dd></div>
          </dl>
        </section>
        {item.candidatesTruncated && <p className="mt-4 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
          Caso ad alta cardinalità: sono mostrati i primi {item.visibleCandidateCount} candidati su {item.candidateCount},
          secondo il ranking N13 deterministico. Tutti gli snapshot restano conservati; la decisione operatore non è automatica.
        </p>}
        <div className="mt-4 space-y-3">
          {item.candidates.map((candidate) => <article
            key={candidate.leadId}
            className="rounded-2xl border border-slate-200 bg-white p-4"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <a className="font-extrabold text-fai-blue underline" href={`/leads/${candidate.leadId}`}>
                  {displayIdentity([
                    candidate.lead.companyName,
                    candidate.lead.firstName,
                    candidate.lead.lastName,
                  ])}
                </a>
                <p className="mt-1 text-sm text-slate-600">
                  {candidate.lead.email || 'Email —'} · {candidate.lead.phone || 'Telefono —'}
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  Match {candidate.strongestSignal.toLowerCase()} · {candidate.strongSignalCount} segnali forti · {candidate.weakSignalCount} deboli · Lead creato {formatDateTime(candidate.lead.createdAt)}
                </p>
              </div>
              {candidate.selectable ? <StatusBadge status={`RANK_${candidate.rank}`} /> : <StatusBadge status="NON_DISPONIBILE" />}
            </div>
            {decisionsAvailable && candidate.selectable && <form action={resolveLeadDuplicateCaseAndRefresh} className="mt-3">
              <input type="hidden" name="caseId" value={item.caseId} />
              <input type="hidden" name="expectedCaseVersion" value={item.caseVersion} />
              <input type="hidden" name="outcome" value="LINK_EXISTING_NO_OVERWRITE" />
              <input type="hidden" name="selectedLeadId" value={candidate.leadId} />
              <input type="hidden" name="reasonCode" value="OPERATOR_CONFIRMED_SAME_LEAD" />
              <PrimaryButton type="submit">Collega senza sovrascrivere</PrimaryButton>
            </form>}
          </article>)}
        </div>
        {decisionsAvailable && <form action={resolveLeadDuplicateCaseAndRefresh} className="mt-4 rounded-2xl border border-fai-orange/30 bg-orange-50 p-4">
          <input type="hidden" name="caseId" value={item.caseId} />
          <input type="hidden" name="expectedCaseVersion" value={item.caseVersion} />
          <input type="hidden" name="outcome" value="CREATE_NEW" />
          <input type="hidden" name="reasonCode" value="OPERATOR_CONFIRMED_DISTINCT_LEAD" />
          <p className="mb-3 text-sm text-slate-700">Usa questa scelta soltanto se nessun candidato rappresenta la richiesta ricevuta.</p>
          <PrimaryButton type="submit">Crea un nuovo Lead</PrimaryButton>
        </form>}
      </Card>)}
    </div>}
    <PaginationNav
      pathname="/leads/duplicates"
      params={params}
      page={page.page}
      hasPrevious={page.hasPrevious}
      hasNext={page.hasNext}
    />
  </div>;
}

export const dynamic = 'force-dynamic';
