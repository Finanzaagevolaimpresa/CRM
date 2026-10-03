export const dynamic = 'force-dynamic';

import { SecondaryLink } from '@/components/actions';
import { Card, PageHeader, StatusBadge, TimestampMeta, formatDateTime } from '@/components/ui';
import { requirePermission } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { getContractReadAccess } from '@/lib/read-access';
import { ContractSignatureForm } from '@/components/contract-signature-form';
import { canRecordContractSignature, contractCanRecordSignature, isSignatureDocument, signatureCalendarDay } from '@/lib/contract-signature-policy';
import { contractSignatureDeclarationEvent, storedContractSignatureDeclarationSchema, orderedSignatureDeclarations } from '@/lib/contract-signature-policy';
import { ContractSignatureDeclarationForm } from '@/components/contract-signature-declaration-form';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const session = await requirePermission('contract.read');
  const { id } = await params;
  const context = await getContractReadAccess(session, id);
  if (!context) return <PageHeader title="Contratto non trovato" description="Il record richiesto non esiste o non è accessibile." />;
  const { contract } = context;
  const client = await prisma.client.findFirst({ where: { id: contract.clientId, deletedAt: null } });
  const project = contract.projectId ? await prisma.project.findFirst({ where: { id: contract.projectId, deletedAt: null } }) : null;
  const canRecord = !!client && (!contract.projectId || !!project) && canRecordContractSignature(session, client, project)
    && contractCanRecordSignature(contract.status) && !contract.signedAt && !contract.signedDocumentId;
  const documents = [] as { versionId: string; title: string; version: number }[];
  if (canRecord && client) {
    const candidates = await prisma.document.findMany({ where: { clientId: contract.clientId, projectId: contract.projectId, clientServiceId: null,
      serviceArea: 'contratti', deletedAt: null }, orderBy: [{ title: 'asc' }, { id: 'asc' }] });
    for (const document of candidates) {
      const version = await prisma.documentVersion.findFirst({ where: { documentId: document.id }, orderBy: [{ version: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }] });
      if (version && isSignatureDocument(session, contract, client, project, document, version)) documents.push({ versionId: version.id, title: document.title, version: version.version });
    }
  }
  const declarations = orderedSignatureDeclarations(await prisma.auditLog.findMany({ where: { entityType: 'Contract', entityId: contract.id, event: contractSignatureDeclarationEvent } }))
    .map(item => item.row).slice(0, 30);
  const authors = await prisma.user.findMany({ where: { id: { in: declarations.flatMap(row => row.actorId ? [row.actorId] : []) } }, select: { id: true, name: true } });

  return <div className="space-y-6">
    <PageHeader title={`Contratto — ${contract.contractNumber}`} description="Contratto interno con stato e gestione manuale di invio/firma." />
    <SecondaryLink href="/contracts">← Torna alla lista</SecondaryLink>
    <Card title="Dati contratto">
      <p>Cliente: {client?.displayName ?? 'Cliente non disponibile'}</p>
      <p>Servizio: {contract.serviceName}</p>
      <p>Totale: € {Number(contract.totalAmount).toLocaleString('it-IT')}</p>
      <p>Stato: <StatusBadge status={contract.status} /></p>
      {contract.signedAt ? <p>Firma registrata: {new Intl.DateTimeFormat('it-IT', { timeZone: 'UTC' }).format(contract.signedAt)}</p> : null}
      {contract.status === 'firmato' ? <p>La firma è registrata. Il pagamento si verifica separatamente nella sezione Pagamenti.</p> : null}
      <p className="mt-2 text-sm text-fai-gray">{contract.notes ?? 'Nessun dato presente'}</p>
      <TimestampMeta createdAt={contract.createdAt} updatedAt={contract.updatedAt} />
    </Card>
    <Card title="Dichiarazione della firma">
      {declarations.length === 0 ? <p>Nessuna dichiarazione salvata. Eventuali note libere non attestano la firma.</p> :
        <div className="space-y-3">{declarations.map((row, index) => {
          const value = storedContractSignatureDeclarationSchema.safeParse(row.after);
          return <div key={row.id} className="rounded-xl border p-3">
            <p className="font-semibold">{index === 0 ? 'Dichiarazione corrente' : 'Dichiarazione precedente'} — da verificare sul documento</p>
            {value.success ? <><p>Data dichiarata: {value.data.declaredSignedAt}</p><p>Fonte: {value.data.source}</p></> : <p>Evidenza da verificare: formato non riconosciuto.</p>}
            <p>Registrata da {authors.find(author => author.id === row.actorId)?.name ?? 'Autore non disponibile'} il {formatDateTime(row.createdAt)}.</p>
          </div>;
        })}</div>}
      {canRecord ? <div className="mt-4"><ContractSignatureDeclarationForm contractId={contract.id} expectedVersion={contract.updatedAt.toISOString()}
        expectedDeclarationId={declarations[0]?.id ?? null} today={signatureCalendarDay()} /></div> : null}
      <p className="mt-3">Il documento caricato, la registrazione della firma, il pagamento e l’avvio del servizio sono verifiche separate.</p>
      <SecondaryLink href={`/progress?client=${encodeURIComponent(contract.clientId)}`}>Stato e prossime azioni del cliente</SecondaryLink>
    </Card>
    {canRecord ? <Card title="Registra il contratto firmato">{documents.length ? <ContractSignatureForm contractId={contract.id}
      expectedVersion={contract.updatedAt.toISOString()} documents={documents} today={signatureCalendarDay()} />
      : <div className="space-y-3"><p>Carica il contratto firmato nella sezione Contratti del fascicolo cliente, con lo stesso progetto di questa scheda e senza collegarlo a un servizio. Poi torna qui per registrare la firma.</p>
        <SecondaryLink href={`/clients/${contract.clientId}#documenti`}>Apri documenti del cliente</SecondaryLink></div>}</Card> : null}
  </div>;
}
