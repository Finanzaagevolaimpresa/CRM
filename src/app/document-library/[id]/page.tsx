import { randomUUID } from 'node:crypto';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireSession } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { listOperationalTemplates, readOperationalDocument } from '@/lib/operational-documents';
import { canUseOperationalDocuments, documentFieldLabels, documentFields, documentKindLabels, OperationalDocumentError } from '@/lib/operational-document-contract';
import { OperationalDocumentDecisionForm } from '@/components/operational-document-forms';
import { Card, PageHeader, formatDateTime } from '@/components/ui';
import { withTechnicalPage } from '@/lib/technical-surface-guards';
import { readOperationalDocumentDelivery } from '@/lib/operational-document-delivery';
import { listDriveFolders } from '@/lib/drive-folder-library';
import { ProformaEmailForm, ProformaArchiveForm } from '@/components/operational-document-delivery-forms';
export const dynamic = 'force-dynamic';
async function Page({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession(); if (!canUseOperationalDocuments(session)) notFound();
  const { id } = await params;
  let data;
  try { data = await readOperationalDocument(prisma, session, id); }
  catch (error) { if (error instanceof OperationalDocumentError && error.code === 'DENIED') notFound(); throw error; }
  const { row, snapshot, decision, authors, proformas } = data;
  const delivery = row.kind === 'PROFORMA' ? await readOperationalDocumentDelivery(prisma, session, row.id) : null;
  const folders = delivery?.isAdmin && row.clientId ? (await listDriveFolders(prisma, session, { manage: true, clientId: row.clientId })).filter(folder => folder.state === 'ACTIVE' && folder.clientCurrent && !folder.expired) : [];
  const proformaTemplates = decision && row.kind === 'CONTRACT' ? (await listOperationalTemplates(prisma, session)).filter(template => template.kind === 'PROFORMA') : [];
  const kind = documentKindLabels[row.kind as keyof typeof documentKindLabels] ?? 'Documento';
  return <div className="crm-space-y-6"><PageHeader title={kind + ' · ' + snapshot.fields.denominazione} description={decision ? 'Contenuto confermato. Invio, firma ed emissione fiscale conservano i propri stati.' : 'Bozza indipendente dal modello: controlla dati e contenuto prima della conferma.'}/>
    <Link className="font-bold underline" href={row.leadId ? '/document-library/new?lead=' + row.leadId : '/document-library/new?client=' + row.clientId}>Documenti della scheda</Link>
    <Card title="Stato"><p>{decision ? 'Contenuto confermato' : 'Bozza da verificare'}</p><p>{delivery?.email ? 'Comunicazione: ' + (delivery.email.native?.label ?? 'bozza affidata alla gestione autorizzata della posta; esito da consultare con l’Admin.') : 'Invio al cliente: non eseguito.'}</p>
      <p>{row.kind === 'PROFORMA' ? 'Documento non fiscale. Emissione fiscale e SdI: non eseguiti.' : 'Firma: non attestata da questa bozza.'}</p>
      {snapshot.missing.length > 0 && <p className="font-bold text-amber-800">Campi mancanti: {snapshot.missing.map(field => documentFieldLabels[field]).join(', ')}. Completa una nuova bozza dalla scheda.</p>}
      {!snapshot.termsConfirmed && <p className="font-bold text-amber-800">Condizioni del caso ancora da confermare. Prepara una nuova bozza dopo la verifica.</p>}
    </Card>
    <Card title="Anteprima"><pre className="whitespace-pre-wrap font-sans text-sm leading-7">{row.content}</pre>
      <Link href={'/document-library/' + row.id + '/pdf'} target="_blank" className="mt-4 inline-block rounded-xl border p-3 font-bold">Apri anteprima PDF</Link></Card>
    <Card title="Dati e fonti"><dl className="grid gap-3 md:grid-cols-2">{documentFields.map(field => <div key={field}><dt className="font-bold">{documentFieldLabels[field]}</dt><dd>{snapshot.fields[field] || 'Mancante'}</dd><dd className="text-sm text-slate-500">{snapshot.sources[field]}</dd></div>)}</dl></Card>
    {!decision && !snapshot.missing.length && snapshot.termsConfirmed && <Card title="Conferma documento"><OperationalDocumentDecisionForm key={row.id + ':confirm'} documentId={row.id} contentHash={row.contentHash} commandId={randomUUID()}/></Card>}
    {decision && row.kind === 'CONTRACT' && <Card title="Prepara proforma">{proformaTemplates.length ? <OperationalDocumentDecisionForm key={row.id + ':proforma'} documentId={row.id} contentHash={row.contentHash} commandId={randomUUID()} proforma templates={proformaTemplates.map(template => ({ id: template.publishedCommandId!, title: template.title + ' · v' + template.revision }))}/>
      : <p>L’Admin deve pubblicare un modello Proforma con i dati aziendali autorizzati dell’emittente.</p>}</Card>}
    {delivery && <Card title="Invio e ricevute">{delivery.email ? <>
      <p>Bozza email con PDF preparata il {formatDateTime(delivery.email.createdAt)}. Approvazione e invio seguono il percorso della posta aziendale.</p>
      {delivery.isAdmin && <Link className="font-bold underline" href={'/communications?' + new URLSearchParams({ kind: 'CLIENT', practice: row.clientId!, focus: delivery.email.messageId })}>Apri bozza, approvazioni e ricevute</Link>}
      {delivery.email.native && <p>Stato verificato nella posta: {delivery.email.native.label}. Tentativi manuali: {delivery.email.native.attempts.length}; ricevute del canale: {delivery.email.native.receipts.length}.</p>}
    </> : delivery.isAdmin && decision && row.clientId ? <ProformaEmailForm documentId={row.id} contentHash={row.contentHash} commandId={randomUUID()} email={snapshot.fields.email} mailboxes={delivery.mailboxes}/>
      : <p>Conferma l’anteprima della proforma. L’Admin autorizzato alla posta può preparare la bozza email con il PDF e sottoporla all’approvazione prevista.</p>}</Card>}
    {delivery && <Card title="Archivio Drive">{delivery.archives.map(item => <div className="mb-3" key={item.commandId}><a className="font-bold underline" href={item.url} target="_blank" rel="noopener noreferrer">Apri PDF archiviato</a><p>Archiviazione attestata dall’operatore il {formatDateTime(item.occurredAt)}. Evidenza: {item.evidence}</p></div>)}
      <p>Il CRM registra l’evidenza dell’operatore e il collegamento. I file e i permessi Google si verificano in Drive.</p>
      {delivery.isAdmin && decision && folders.length > 0 && <ProformaArchiveForm documentId={row.id} contentHash={row.contentHash} commandId={randomUUID()} pdfSha256={delivery.pdfSha256} folders={folders}/>}
      {delivery.isAdmin && decision && folders.length === 0 && <p>Collega prima una cartella attiva e autorizzata al cliente nella libreria Fascicoli Drive.</p>}
    </Card>}
    {!!proformas.length && <Card title="Proforma già preparate">{proformas.map(item => <p key={item.id}><Link className="font-bold underline" href={'/document-library/' + item.id}>Scadenza {item.dueDate} · {formatDateTime(item.createdAt)}</Link></p>)}</Card>}
    <Card title="Cronologia"><p>Creata da {authors.find(author => author.id === row.actorId)?.name ?? 'Autore registrato'} il {formatDateTime(row.createdAt)}.</p>
      <p>Modello: {snapshot.templateTitle} · versione {snapshot.templateRevision}.</p>
      {decision && <p>Contenuto confermato da {authors.find(author => author.id === decision.actorId)?.name ?? 'Autore registrato'} il {formatDateTime(decision.createdAt)}.</p>}
      {row.sourceDocumentId && <Link className="font-bold underline" href={'/document-library/' + row.sourceDocumentId}>Apri contratto di origine</Link>}
    </Card>
    <Card title="Documenti e firma"><p>Carica i file nella cartella Drive autorizzata del cliente. Il collegamento mantiene i permessi già assegnati.</p>
      {row.clientId ? <Link className="font-bold underline" href={'/clients/' + row.clientId + '#file-condivisi'}>Apri cartelle Drive</Link> : <p>Nessuna anagrafica cliente collegata: completa il percorso di acquisizione prima dell’archiviazione.</p>}
      {row.contractId && session.role === 'admin' && <Link className="mt-3 block font-bold underline" href={'/contracts/' + row.contractId}>Apri incarico e procedura di registrazione della firma</Link>}
    </Card>
  </div>;
}
export default withTechnicalPage('/document-library/[id]', Page);
