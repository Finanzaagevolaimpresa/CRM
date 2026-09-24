import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Card, PageHeader, formatDateTime } from '@/components/ui';
import { PurchasedServiceHandoffForm } from '@/components/purchased-service-handoff-form';
import { DocumentUploadForm } from '@/components/document-upload-form';
import { hasPermission, requirePermission } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { canEditService, canViewDocument, canViewTechnicalPractice } from '@/lib/access-control';
import { getHandoffReceipt, previewPurchasedServiceHandoff, purchasedServiceContext } from '@/lib/purchased-service-handoff';
import { canonicalSha256 } from '@/lib/canonical-json';
import { UserFacingActionError } from '@/lib/action-errors';
import { technicalRoles } from '@/lib/responsibility';

export const dynamic = 'force-dynamic';
export default async function Page({ params, searchParams }: {
  params: Promise<{ id: string }>; searchParams: Promise<{ q?: string; after?: string }>;
}) {
  const session = await requirePermission('technical.read'), { id } = await params, query = await searchParams;
  const context = await purchasedServiceContext(prisma, id).catch(() => null);
  if (!context) notFound();
  const entry = await getHandoffReceipt(prisma, id), { client, service, project } = context;
  const practice = entry ? await prisma.technicalPractice.findFirst({ where: { id: entry.receipt.technicalPracticeId, clientId: client.id,
    clientServiceId: id, projectId: service.projectId, deletedAt: null } }) : null;
  if (session.role !== 'admin' && (!practice || !canViewTechnicalPractice(session, { ...practice, client }))) notFound();
  const path = `/services/${id}/handoff`;
  if (entry) {
    const receipt = entry.receipt;
    const [contract, tasks, docs] = await Promise.all([
      prisma.contract.findUnique({ where: { id: receipt.contractId }, select: { serviceDescription: true, clientId: true } }),
      prisma.task.findMany({ where: { id: { in: receipt.paths }, clientId: client.id, clientServiceId: id, deletedAt: null }, orderBy: { id: 'asc' } }),
      prisma.document.findMany({ where: { id: { in: receipt.source.map(item => item.id) }, deletedAt: null } }),
    ]);
    const scopeMatches = contract?.clientId === client.id && canonicalSha256(contract.serviceDescription) === receipt.scopeHash;
    return <div className="space-y-6"><PageHeader title="Passaggio del servizio acquistato" description={`Cliente: ${client.displayName}`} />
      <Card title="Passaggio registrato"><p>Registrato il {formatDateTime(entry.createdAt)} · variante {receipt.variantCode} · reparto iniziale {receipt.departmentCode}</p>
        <p>Incarico e pagamento documentato verificati dall’amministratore al momento del passaggio. La presa in carico personale è registrata separatamente.</p>
        <div className="flex gap-4"><Link href={`/technical-office/practices/${receipt.technicalPracticeId}`}>Apri la pratica</Link><Link href={`/assignments/TechnicalPractice/${receipt.technicalPracticeId}`}>Responsabilità e presa in carico</Link></div>
        {!practice && <p>La pratica non è attualmente disponibile; la ricevuta storica è conservata.</p>}
      </Card>
      <Card title="Perimetro dell’incarico">{scopeMatches ? <p className="whitespace-pre-wrap">{contract!.serviceDescription}</p> : <p>L’incarico è cambiato dopo il passaggio. Verifica la versione firmata con l’amministratore prima di proseguire.</p>}</Card>
      <Card title="Documenti del passaggio"><ul>{receipt.source.map(source => {
        const document = docs.find(item => item.id === source.id);
        const allowed = document && document.checksum === source.checksumHash && hasPermission(session, 'document.download')
          && canViewDocument(session, { ...document, client: document.clientId === client.id ? client : null,
            project: document.projectId ? project : null, clientService: document.clientServiceId === id ? { ...service, client, project } : null }, hasPermission(session, 'document.sensitive.read'));
        return <li key={source.kind}>{source.kind === 'contract' ? 'Incarico firmato' : 'Prova del pagamento'} · versione {source.version} · {allowed ? <Link href={`/documents/${source.id}/download`}>Scarica documento</Link> : 'Consultazione da verificare con l’amministratore'}</li>;
      })}</ul></Card>
      <Card title="Attività dovute"><ul>{tasks.map(task => <li key={task.id}>{task.title} · {task.status} · {formatDateTime(task.dueAt)}</li>)}</ul>
        {tasks.length !== receipt.paths.length && <p>Alcune attività originarie sono archiviate o hanno cambiato collegamento. Verifica lo storico amministrativo.</p>}</Card>
      {hasPermission(session, 'document.upload') && canEditService(session, { ...service, client, project }) && <Card title="Carica materiali o elaborati del servizio">
        <DocumentUploadForm fixedClientId={client.id} clients={[{ id: client.id, clientId: client.id, label: client.displayName, generalUploadAllowed: false }]}
          companies={[]} projects={[]} includeProject={false} services={[{ id, clientId: client.id, label: receipt.variantCode }]} serviceAreas={['altro']} />
      </Card>}
    </div>;
  }
  let preview: Awaited<ReturnType<typeof previewPurchasedServiceHandoff>>;
  try { preview = await previewPurchasedServiceHandoff(prisma, id); }
  catch (error) { if (!(error instanceof UserFacingActionError)) throw error;
    return <Card title="Requisiti del passaggio da completare"><p>{error.message}</p><Link href={`/clients/${client.id}#servizi-acquistati`}>Torna al servizio acquistato</Link></Card>; }
  const q = (query.q ?? '').trim().slice(0, 120), after = query.after && /^[a-zA-Z0-9_-]{1,128}$/.test(query.after) ? query.after : undefined;
  const candidates = await prisma.user.findMany({ where: { active: true, deletedAt: null, role: { in: [...technicalRoles] },
    ...(q ? { name: { contains: q, mode: 'insensitive' } } : {}), ...(after ? { id: { gt: after } } : {}) }, orderBy: { id: 'asc' }, take: 26, select: { id: true, name: true } });
  const currentOwner = service.assignedToId ? await prisma.user.findUnique({ where: { id: service.assignedToId }, select: { name: true } }) : null;
  return <div className="space-y-6"><PageHeader title="Affida il servizio acquistato al tecnico" description={`${client.displayName} · ${preview.catalog.name}`} />
    <Link href={`/clients/${client.id}#servizi-acquistati`}>Torna al servizio acquistato</Link>
    <Card title="Incarico e pagamento"><p>Incarico {preview.contract.contractNumber}, firmato il {formatDateTime(preview.contract.signedAt)}.</p>
      <p className="whitespace-pre-wrap">{preview.contract.serviceDescription}</p>
      <p>Rata incassata: € {preview.payment.totalAmount.toFixed(2)} su incarico di € {preview.contract.totalAmount.toFixed(2)} · {formatDateTime(preview.payment.collectedAt)}.</p>
      <p>Verifica che la rata incassata soddisfi le condizioni dell’incarico per l’affidamento.</p>
      <ul>{preview.documents.map(item => <li key={item.binding.kind}><Link href={`/documents/${item.document.id}/download`}>{item.binding.kind === 'contract' ? 'Incarico firmato' : 'Prova del pagamento'} · versione {item.version.version}</Link></li>)}</ul>
      <p>{preview.practice ? `Sarà utilizzata la pratica esistente: ${preview.practice.title}.` : 'Sarà aperta una pratica per questo servizio sullo stesso cliente.'}</p>
      <p>Responsabile attuale del servizio: {currentOwner?.name ?? 'Non assegnato'}. Il passaggio lo sostituisce con il referente tecnico scelto.</p>
    </Card>
    <Card title="Decisione amministrativa"><form method="get"><label>Cerca referente<input name="q" defaultValue={q} className="m-2 rounded-lg border p-2" /></label><button>Cerca</button></form>
      {candidates.length > 25 && <Link href={`${path}?${new URLSearchParams({ q, after: candidates[24].id })}`}>Altri referenti</Link>}
      <PurchasedServiceHandoffForm key={`${preview.expectedHash}:${q}:${after ?? ''}`} serviceId={id} expectedHash={preview.expectedHash} users={candidates.slice(0, 25)} />
    </Card>
  </div>;
}
