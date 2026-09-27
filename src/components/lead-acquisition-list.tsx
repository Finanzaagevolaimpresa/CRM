import { SecondaryLink } from './actions';
import { Card, EmptyState, formatDateTime } from './ui';
import { acquisitionLabels } from '@/lib/lead-acquisition-contract';
import type { readLeadAcquisitions } from '@/lib/lead-acquisition';

export function LeadAcquisitionList({ items }: { items: Awaited<ReturnType<typeof readLeadAcquisitions>>['items'] }) {
  if (!items.length) return <EmptyState title="Nessuna richiesta">Nessuna ricevuta CRM corrisponde alla selezione.</EmptyState>;
  return <div className="space-y-4">{items.map((row) => <Card key={row.id} title={acquisitionLabels[row.state]}>
    <div className="space-y-2 text-sm text-slate-600">
      <p>Ricevuta CRM <code>{row.id}</code> · {formatDateTime(row.createdAt)}</p>
      {!row.verified ? <p>La ricevuta richiede riconciliazione: il contenuto non viene mostrato.</p> : row.event && <>
        <p>Fonte: {row.event.source.systemCode} · modulo {row.event.source.formCode} · invio {row.event.source.submissionId}</p>
        <p>Evento {row.event.eventId} · richiesta del {formatDateTime(new Date(row.event.occurredAt))}</p>
        <p>Campagna: {row.event.payload.campaignCode ?? 'Non disponibile'} · annuncio: {row.event.payload.adCode ?? 'Non disponibile'}</p>
        <p>Pagina: {row.event.payload.sourcePagePath ?? 'Non disponibile'}</p>
        <p>Servizio richiesto: {row.event.payload.serviceInterestText ?? row.event.catalogReference?.serviceCode ?? row.event.payload.interestText ?? 'Non specificato'}</p>
        {row.event.payload.message && <p className="whitespace-pre-wrap">{row.event.payload.message}</p>}
        {row.privacyEvidence ? <>
          <p>Informativa: {row.privacyEvidence.service.noticeCode}, versione {row.privacyEvidence.service.noticeVersion} · presa visione registrata.</p>
          <p>Marketing: {row.privacyEvidence.marketing.decision === 'GRANTED' ? 'Consenso registrato per la finalità dichiarata' : 'Consenso non concesso'}. Nessuna iscrizione newsletter dedotta.</p>
        </> : <p>Informativa e consensi sono consultabili dagli utenti autorizzati.</p>}
      </>}
      <p>Tentativi: {row.attemptsTotal}/{row.maxAttempts}{row.availableAt && row.attemptsTotal > 0 ? ` · prossimo tentativo non prima del ${formatDateTime(row.availableAt)}` : ''}</p>
      {row.failureCode && <p>Codice da riconciliare: <code>{row.failureCode}</code></p>}
      {row.attempts.length > 0 && <details><summary>Ultimi {row.attempts.length} tentativi</summary><ul className="mt-2 space-y-1">{row.attempts.map((attempt) => <li key={attempt.attemptSequence}>#{attempt.attemptSequence} · {attempt.outcome ?? 'In corso'} · {formatDateTime(attempt.finishedAt)}{attempt.failureCode ? ` · ${attempt.failureCode}` : ''}</li>)}</ul></details>}
      {row.leadId && <SecondaryLink href={`/leads/${row.leadId}`}>Apri lead e prossima azione</SecondaryLink>}
      {row.state === 'AMBIGUOUS' && <p>La nuova richiesta è conservata e attende una decisione nella coda duplicati.</p>}
    </div>
  </Card>)}</div>;
}
