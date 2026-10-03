export const dynamic = 'force-dynamic';
import Link from 'next/link';
import { requirePermission, hasPermission } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { canViewClient, canViewClientContext, canViewTask } from '@/lib/access-control';
import { listAccessiblePracticeReadiness } from '@/lib/practice-readiness';
import { getEngagementDossierReadAccess } from '@/lib/engagement-dossier';
import { engagementFeatureEnabled } from '@/lib/internal-engagement-mode';
import { nextProgressAction, progressTaskType, selectProgressTask } from '@/lib/customer-progress-policy';
import { contractSignatureDeclarationEvent, storedContractSignatureDeclarationSchema, orderedSignatureDeclarations } from '@/lib/contract-signature-policy';
import { Card, EmptyState, PageHeader, formatDateTime } from '@/components/ui';
import { SecondaryLink } from '@/components/actions';

export default async function Page({ searchParams }: { searchParams: Promise<{ client?: string; q?: string }> }) {
  const session = await requirePermission('client.read');
  const query = await searchParams;
  const needle = (query.q ?? '').trim().slice(0, 100).toLocaleLowerCase('it');
  const clients = (await prisma.client.findMany({ where: { deletedAt: null, ...(query.client ? { id: query.client } : {}) }, orderBy: [{ displayName: 'asc' }, { id: 'asc' }] }))
    .filter(client => canViewClient(session, client) && (!needle || client.displayName.toLocaleLowerCase('it').includes(needle)));
  const clientIds = clients.map(client => client.id);
  const canReadContracts = hasPermission(session, 'contract.read'), canReadPayments = hasPermission(session, 'payment.read');
  const projects = await prisma.project.findMany({ where: { clientId: { in: clientIds }, deletedAt: null } });
  const services = await prisma.clientService.findMany({ where: { clientId: { in: clientIds }, deletedAt: null } });
  const clientById = new Map(clients.map(row => [row.id, row]));
  const projectById = new Map(projects.map(row => [row.id, { ...row, client: clientById.get(row.clientId) ?? null }]));
  const serviceById = new Map(services.map(row => [row.id, { ...row, client: clientById.get(row.clientId) ?? null, project: row.projectId ? projectById.get(row.projectId) ?? null : null }]));
  const readinessEnabled = engagementFeatureEnabled(process.env.PRACTICE_READINESS_MODE);
  const practices = readinessEnabled && hasPermission(session, 'service.read')
    ? (await listAccessiblePracticeReadiness(prisma, session)).filter(row => clientById.has(row.clientId)) : [];
  const tasks = hasPermission(session, 'service.read') ? (await prisma.task.findMany({ where: { clientId: { in: clientIds }, deletedAt: null, type: { startsWith: 'percorso:' } } }))
    .filter(row => canViewTask(session, { ...row, client: row.clientId ? clientById.get(row.clientId) ?? null : null,
      project: row.projectId ? projectById.get(row.projectId) ?? null : null, clientService: row.clientServiceId ? serviceById.get(row.clientServiceId) ?? null : null })) : [];
  const contracts = canReadContracts ? (await prisma.contract.findMany({ where: { clientId: { in: clientIds } }, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }] }))
    .filter(row => canViewClientContext(session, { ...row, client: clientById.get(row.clientId) ?? null, project: row.projectId ? projectById.get(row.projectId) ?? null : null })) : [];
  const contractIds = contracts.map(row => row.id);
  const declarations = contractIds.length ? await prisma.auditLog.findMany({ where: { entityType: 'Contract', entityId: { in: contractIds }, event: contractSignatureDeclarationEvent }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] }) : [];
  const payments = canReadPayments && contractIds.length ? await prisma.payment.findMany({ where: { contractId: { in: contractIds } } }) : [];
  const users = await prisma.user.findMany({ where: { id: { in: [...new Set([...declarations.flatMap(row => row.actorId ? [row.actorId] : []), ...tasks.flatMap(row => row.assignedToId ? [row.assignedToId] : []), ...practices.flatMap(row => row.startedById ? [row.startedById] : [])])] } }, select: { id: true, name: true } });
  const userName = (id: string | null) => id ? users.find(user => user.id === id)?.name ?? 'Responsabile non disponibile' : 'Da assegnare';
  const practiceCards = [];
  for (const practice of practices) {
    const dossierRow = hasPermission(session, 'dossier.read') ? await prisma.clientDossier.findUnique({ where: { practiceReadinessId: practice.id }, select: { id: true } }) : null;
    const context = dossierRow ? await getEngagementDossierReadAccess(prisma, session, dossierRow.id) : null;
    const history = context?.engagementHistory;
    const delivered = history?.authorizations.filter(auth => history.receipts.some(receipt => receipt.authorizationId === auth.id && receipt.outcome === 'DELIVERED')).map(auth => auth.versionId) ?? [];
    const step = nextProgressAction({ missing: practice.prerequisites.missing, started: !!practice.startedAt, canReadContracts, canReadPayments,
      dossier: context ? { currentVersionId: context.dossier.currentVersionId, approvedVersionId: context.dossier.approvedVersionId, deliveredVersionIds: delivered } : null });
    const type = progressTaskType(practice.id, step.key);
    // Only a deliberately linked action supplies its owner/date, not an unrelated open task.
    const task = selectProgressTask(tasks.filter(row => row.clientId === practice.clientId), type);
    const href = context && ['review', 'delivery', 'delivered'].includes(step.key) ? `/client-dossiers/${context.dossier.id}` : `/practice-readiness#practice-${practice.id}`;
    const version = history?.versions.find(row => row.id === context?.dossier.currentVersionId);
    practiceCards.push(<Card key={practice.id} title={`${clientById.get(practice.clientId)!.displayName} — percorso`}>
      <div data-progress-practice={practice.id} className="space-y-2">
        <p><b>Stato:</b> {practice.startedAt ? 'Servizio avviato esplicitamente' : 'Servizio non avviato'}</p>
        <p><b>Motivo:</b> {step.reason}</p><p><b>Prossima azione:</b> {step.action}</p>
        <p><b>Responsabile dell’azione:</b> {userName(task?.assignedToId ?? null)}</p>
        <p><b>Scadenza dell’azione:</b> {task?.dueAt ? formatDateTime(task.dueAt) : 'Da pianificare'}</p>
        <p><b>Risultato atteso:</b> {step.expected}</p>
        <p>Fonte: pratica controllata, aggiornata il {formatDateTime(practice.updatedAt)}. Anagrafica riutilizzata dal fascicolo cliente.</p>
        {practice.startedAt ? <p>Avvio registrato da {userName(practice.startedById)} il {formatDateTime(practice.startedAt)}.</p> : null}
        {version ? <p>Versione corrente del dossier: {version.version} · {version.id}. Approvazione e consegna si riferiscono a questa versione soltanto.</p> : null}
        <div className="flex flex-wrap gap-3"><SecondaryLink href={href}>Apri la funzione per proseguire</SecondaryLink>
          <SecondaryLink href={`/clients/${practice.clientId}`}>Fascicolo e dati già salvati</SecondaryLink>
          {hasPermission(session, 'service.write') && type ? <SecondaryLink href={`/clients/${practice.clientId}?progressTask=${encodeURIComponent(type)}#task-scadenze`}>Assegna e pianifica questa azione</SecondaryLink> : null}</div>
      </div>
    </Card>);
  }
  return <div className="space-y-6"><PageHeader title="Stato e prossime azioni" description="Dati salvati e verifiche distinte. Una dichiarazione non sostituisce un documento verificato; l’avvio richiede un’azione esplicita." />
    <form method="get" className="flex flex-wrap gap-3">{query.client ? <input type="hidden" name="client" value={query.client} /> : null}
      <label>Cerca cliente<input name="q" defaultValue={query.q ?? ''} maxLength={100} className="ml-2 rounded-xl border p-2" /></label><button type="submit" className="rounded-xl border px-4">Cerca</button><Link href="/progress">Tutti i clienti accessibili</Link></form>
    <p>{clients.length} clienti accessibili corrispondenti · {practices.length} percorsi. L’elenco non si limita alle prime dieci priorità.</p>
    {practiceCards}
    {!practices.length ? <EmptyState title="Nessun percorso accessibile corrispondente">Apri il fascicolo per proseguire dai dati già salvati. Non creare un duplicato dopo un esito incerto.</EmptyState> : null}
    {contracts.map(contract => {
      const row = orderedSignatureDeclarations(declarations.filter(item => item.entityId === contract.id))[0]?.row;
      const declaration = storedContractSignatureDeclarationSchema.safeParse(row?.after);
      const relatedPayments = payments.filter(item => item.contractId === contract.id);
      return <Card key={contract.id} title={`${clientById.get(contract.clientId)!.displayName} — ${contract.contractNumber}`}>
        <div className="space-y-2" data-progress-contract={contract.id}>
          <p><b>Firma:</b> {contract.signedAt && contract.signedDocumentId ? 'Registrata con documento collegato' : declaration.success ? 'Dichiarata, da verificare sul documento' : 'Non registrata; nessuna dichiarazione verificabile'}</p>
          {declaration.success && row ? <><p>Firma dichiarata del {declaration.data.declaredSignedAt}; fonte: {declaration.data.source}.</p><p>Registrata da {userName(row.actorId)} il {formatDateTime(row.createdAt)}.</p></> : null}
          <p><b>Documento:</b> {contract.signedDocumentId ? 'Collegato alla registrazione della firma; versione e disponibilità da consultare nella scheda.' : 'Non ancora collegato alla firma; acquisizione e verifica da completare nella scheda.'}</p>
          {canReadPayments ? <p><b>Pagamenti:</b> {relatedPayments.length ? relatedPayments.map(item => item.status.replaceAll('_', ' ')).join(' · ') : 'Nessun pagamento registrato'}. L’incasso non avvia il servizio automaticamente.</p> : null}
          <SecondaryLink href={`/contracts/${contract.id}`}>Apri dichiarazione, documento e firma</SecondaryLink>
        </div>
      </Card>;
    })}
    <p className="text-sm">Dopo un esito incerto, ricarica questa scheda e verifica i record già salvati prima di ripetere. Gli input non salvati non vengono conservati.</p>
  </div>;
}
