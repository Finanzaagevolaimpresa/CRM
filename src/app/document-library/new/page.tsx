import { randomUUID } from 'node:crypto';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireSession } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { listOperationalTemplates, operationalDocumentOptions, prepareOperationalDocument } from '@/lib/operational-documents';
import { canUseOperationalDocuments, documentKindLabels } from '@/lib/operational-document-contract';
import { OperationalDraftForm } from '@/components/operational-document-forms';
import { Card, PageHeader, formatDateTime } from '@/components/ui';
import { withTechnicalPage } from '@/lib/technical-surface-guards';
export const dynamic = 'force-dynamic';
async function Page({ searchParams }: { searchParams: Promise<{ lead?: string; client?: string; template?: string; terms?: string }> }) {
  const session = await requireSession(); if (!canUseOperationalDocuments(session)) notFound();
  const query = await searchParams;
  if (Boolean(query.lead) === Boolean(query.client)) return <PageHeader title="Apri una scheda" description="Seleziona il lead dalla coda oppure cerca l’anagrafica in Documenti e Contratti."/>;
  const context = query.lead ? { leadId: query.lead } : { clientId: query.client! };
  const [options, templates] = await Promise.all([operationalDocumentOptions(prisma, session, context), listOperationalTemplates(prisma, session)]);
  const template = templates.find(row => row.publishedCommandId === query.template);
  const serviceRevisionId = query.terms?.startsWith('service:') ? query.terms.slice(8) : undefined;
  const contractId = query.terms?.startsWith('contract:') ? query.terms.slice(9) : undefined;
  const selection = template?.publishedCommandId && (serviceRevisionId || contractId) ? { context,
    templateCommandId: template.publishedCommandId, ...(serviceRevisionId ? { serviceRevisionId } : {}), ...(contractId ? { contractId } : {}) } : null;
  const prepared = selection ? await prepareOperationalDocument(prisma, session, selection) : null;
  return <div className="crm-space-y-6"><PageHeader title={'Prepara documento · ' + options.title} description="Il modello resta invariato. I dati e le fonti vengono conservati nella nuova bozza."/>
    <Link className="font-bold underline" href={query.lead ? '/leads/' + query.lead : '/clients/' + query.client}>Torna alla scheda</Link>
    <Card title="Modello e condizioni"><form className="grid gap-3 md:grid-cols-2">
      <input type="hidden" name={query.lead ? 'lead' : 'client'} value={query.lead ?? query.client}/>
      <label>Modello approvato<select name="template" aria-label="Modello approvato" className="w-full rounded-xl border p-3" defaultValue={query.template ?? ''} required><option value="">Seleziona modello</option>
        {templates.filter(row => row.kind !== 'PROFORMA').map(row => <option key={row.publishedCommandId} value={row.publishedCommandId!}>{row.title} · v{row.revision}</option>)}</select></label>
      <label>Catalogo o incarico<select name="terms" aria-label="Catalogo o incarico" className="w-full rounded-xl border p-3" defaultValue={query.terms ?? ''} required><option value="">Seleziona condizioni</option>
        <optgroup label="Catalogo approvato">{options.services.map(row => <option key={row.id} value={'service:' + row.id}>{row.label}</option>)}</optgroup>
        <optgroup label="Incarichi del cliente">{options.contracts.map(row => <option key={row.id} value={'contract:' + row.id}>{row.label}</option>)}</optgroup></select></label>
      <button className="rounded-xl bg-fai-green p-3 font-bold text-white">Precompila dai dati esistenti</button>
    </form>{!templates.length && <p className="mt-3">L’Admin deve pubblicare almeno un modello autorizzato.</p>}</Card>
    {prepared && selection && <Card title="Dati precompilati e campi da verificare"><OperationalDraftForm key={prepared.sourceHash} commandId={randomUUID()} selection={selection} candidates={prepared.candidates} sourceHash={prepared.sourceHash}/></Card>}
    <Card title="Documenti già preparati">{options.documents.length ? <ul className="space-y-2">{options.documents.map(row => <li key={row.id}><Link className="font-bold underline" href={'/document-library/' + row.id}>{documentKindLabels[row.kind as keyof typeof documentKindLabels] ?? row.kind} · {formatDateTime(row.createdAt)}</Link></li>)}</ul> : <p>Nessuna bozza per questa scheda.</p>}</Card>
    {options.clientId && <Link className="font-bold underline" href={'/clients/' + options.clientId + '#file-condivisi'}>Apri cartelle Drive del cliente</Link>}
  </div>;
}
export default withTechnicalPage('/document-library/new', Page);
