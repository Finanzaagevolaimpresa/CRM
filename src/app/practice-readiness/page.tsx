export const dynamic = "force-dynamic";
import { filterFinancialDocuments } from '@/lib/financial-document-access';
import { requirePermission, hasPermission } from "@/lib/auth";
import {
  canViewChecklistItem,
  canViewDocument,
  canViewClient, canViewLead, canViewCommercialOffer, canViewProject, canViewClientContext,
  isSensitiveDocument,
} from "@/lib/access-control";
import { prisma } from "@/lib/prisma";
import { Card, EmptyState, PageHeader, StatusBadge } from "@/components/ui";
import { PrimaryButton } from "@/components/actions";
import Link from "next/link";
import { listAccessiblePracticeReadiness } from "@/lib/practice-readiness";
import { canViewPracticeReadinessWork } from '@/lib/practice-readiness-access';
import { engagementFeatureEnabled } from "@/lib/internal-engagement-mode";
import {
  attestPracticeMaterialsCompleteAction,
  confirmPracticeFundingAction,
  createPracticeReadinessAction,
  decidePracticeMaterialAction,
  formalizePracticeAction,
  linkPracticeClientServiceAction,
  proposePracticeOfferRevisionAction,
  recordPracticeFundingAction,
  reversePracticeFundingAction,
  startPracticeAction,
} from "@/lib/practice-readiness-actions";
const field = "w-full rounded-xl border p-2";
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string;
    practiceId?: string;
    reference?: string;
    amount?: string;
    commercialOfferSelection?: string;
    scope?: string;
    startupConditions?: string;
    requiredInitialAmount?: string;
  }>;
}) {
  const feedback = await searchParams;
  const session = await requirePermission("service.read");
  if (!engagementFeatureEnabled(process.env.PRACTICE_READINESS_MODE))
    return (
      <div className="crm-space-y-6">
        <PageHeader
          title="Pratiche da preventivo ad avvio"
          description="Percorso di avvio non attivo."
        />
        <EmptyState title="Acquisizione non attiva" />
      </div>
    );
  const writable = hasPermission(session, "service.write");
  const canViewContracts = hasPermission(session, 'contract.read');
  const canViewPayments = hasPermission(session, 'payment.read');
  const clientRows = await prisma.client.findMany({
    where: { deletedAt: null },
  });
  const clients = clientRows.filter(client => canViewClient(session, client));
  const clientIds = clientRows.map((x) => x.id);
  const leadRows = await prisma.lead.findMany({
      where: { deletedAt: null, clientId: { in: clientIds } },
      select: { id: true, assignedToId: true, clientId: true },
    });
  const leadById = new Map(leadRows.map(lead => [lead.id, lead]));
  const activeLeadIds = leadRows.filter(lead => canViewLead(session, lead)).map(lead => lead.id);
  const [
    practices,
    intakes,
    offerRows,
    revisions,
    projectRows,
    contractRows,
    documentRows,
    itemRows,
    proposalRows,
    documentServiceRows,
  ] = await Promise.all([
    listAccessiblePracticeReadiness(prisma, session),
    prisma.controlledIntake.findMany({
      where: { leadId: { in: activeLeadIds } },
    }),
    prisma.commercialOffer.findMany({
      where: {
        deletedAt: null,
        clientId: { in: clientIds },
      },
    }),
    prisma.serviceCatalogRevision.findMany({
      where: { status: "PUBLISHED" },
      include: { serviceCatalog: true },
    }),
    prisma.project.findMany({
      where: { deletedAt: null, clientId: { in: clientIds } },
    }),
    canViewContracts ? prisma.contract.findMany({
      where: { status: "firmato", clientId: { in: clientIds } },
    }) : [],
    prisma.document.findMany({
      where: { deletedAt: null, clientId: { in: clientIds } },
    }),
    prisma.documentChecklistItem.findMany({
      where: { active: true, deletedAt: null, clientId: { in: clientIds } },
    }),
    prisma.practiceOfferRevision.findMany({
      where: { clientId: { in: clientIds } },
      include: { acceptance: true },
      orderBy: { proposedAt: "desc" },
    }),
    prisma.clientService.findMany({
      where: { deletedAt: null, clientId: { in: clientIds } },
    }),
  ]);
  const clientById = new Map(clientRows.map((client) => [client.id, client]));
  const projectById = new Map(
    projectRows.map((project) => [
      project.id,
      { ...project, client: clientById.get(project.clientId) ?? null },
    ]),
  );
  const documentServiceById = new Map(
    documentServiceRows.map((service) => [
      service.id,
      {
        ...service,
        client: clientById.get(service.clientId) ?? null,
        project: service.projectId
          ? projectById.get(service.projectId) ?? null
          : null,
      },
    ]),
  );
  const canReadDocuments = hasPermission(session, "document.download");
  const projects = [...projectById.values()].filter(project => canViewProject(session, project));
  const offers = offerRows.filter(offer => offer.status === 'accettata' && canViewCommercialOffer(session, { ...offer,
    client: offer.clientId ? clientById.get(offer.clientId) ?? null : null, lead: offer.leadId ? leadById.get(offer.leadId) ?? null : null }));
  const offerById = new Map(offerRows.map(offer => [offer.id, offer]));
  const proposals = proposalRows.filter(proposal => {
    const offer = offerById.get(proposal.commercialOfferId);
    return canViewPracticeReadinessWork(session, { ...proposal, client: clientById.get(proposal.clientId) ?? null,
      project: proposal.projectId ? projectById.get(proposal.projectId) ?? null : null,
      lead: offer?.leadId ? leadById.get(offer.leadId) ?? null : null });
  });
  const contracts = contractRows.filter(contract => (!contract.projectId || projectById.has(contract.projectId)) && canViewClientContext(session, { ...contract,
    client: clientById.get(contract.clientId) ?? null, project: contract.projectId ? projectById.get(contract.projectId) ?? null : null }));
  const canReadSensitiveDocuments = hasPermission(
    session,
    "document.sensitive.read",
  );
  const documents = canReadDocuments
    ? (await filterFinancialDocuments(prisma, session, documentRows)).filter((document) =>
        canViewDocument(
          session,
          {
            ...document,
            client: document.clientId
              ? clientById.get(document.clientId) ?? null
              : null,
            project: document.projectId
              ? projectById.get(document.projectId) ?? null
              : null,
            clientService: document.clientServiceId
              ? documentServiceById.get(document.clientServiceId) ?? null
              : null,
          },
          canReadSensitiveDocuments,
        ),
      )
    : [];
  const visibleDocumentIds = new Set(documents.map((document) => document.id));
  const items = itemRows
    .filter(
      (item) => !item.documentId || visibleDocumentIds.has(item.documentId),
    )
    .filter(
      (item) =>
        (!isSensitiveDocument({
          containsSensitiveData: false,
          documentCategory: item.title,
          type: item.title,
        }) ||
          canReadSensitiveDocuments) &&
        canViewChecklistItem(session, {
          ...item,
          client: clientById.get(item.clientId) ?? null,
          project: item.projectId
            ? projectById.get(item.projectId) ?? null
            : null,
          clientService: item.clientServiceId
            ? documentServiceById.get(item.clientServiceId) ?? null
            : null,
        }),
    );
  const documentVersions = await prisma.documentVersion.findMany({
    where: { documentId: { in: documents.map((x) => x.id) } },
    orderBy: { version: "desc" },
  });
  return (
    <div className="crm-space-y-6">
      <PageHeader
        title="Pratiche da preventivo ad avvio"
        description="Richiesta, accettazione, incarico, accrediti e materiali restano verifiche distinte. L’avvio è sempre esplicito."
      />
      {writable ? (
        <Card title="Apri pratica controllata">
          <form
            action={proposePracticeOfferRevisionAction}
            className="grid gap-3 md:grid-cols-2"
          >
            <select
              name="controlledIntakeId"
              aria-label="Richiesta controllata"
              className={field}
            >
              {intakes.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.sourceId}
                </option>
              ))}
            </select>
            <select
              name="commercialOfferSelection"
              aria-label="Preventivo sorgente"
              className={field}
              defaultValue={feedback.commercialOfferSelection}
            >
              {offers.map((x) => (
                <option
                  key={x.id}
                  value={`${x.id}|${x.updatedAt.toISOString()}`}
                >
                  {x.title} · aggiornato {x.updatedAt.toISOString()}
                </option>
              ))}
            </select>
            <select
              name="serviceRevisionId"
              aria-label="Servizio e revisione catalogo"
              className={field}
            >
              {revisions.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.serviceCatalog.code} · rev. {x.version}
                </option>
              ))}
            </select>
            <select name="clientId" aria-label="Cliente" className={field}>
              {clients.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.displayName}
                </option>
              ))}
            </select>
            <select name="projectId" aria-label="Progetto" className={field}>
              <option value="">Nessun progetto</option>
              {projects.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.title}
                </option>
              ))}
            </select>
            <select
              name="digitalProjectType"
              aria-label="Tipologia digitale"
              className={field}
            >
              <option value="">Non applicabile</option>
              <option value="software_crm_workflow">
                Software, CRM e workflow
              </option>
            </select>
            <textarea
              name="scope"
              aria-label="Perimetro concordato"
              className={field}
              placeholder="Perimetro concordato"
              defaultValue={feedback.scope}
            />
            <textarea
              name="startupConditions"
              aria-label="Condizioni di avvio"
              className={field}
              placeholder="Condizioni esplicite di avvio"
              defaultValue={feedback.startupConditions}
            />
            <input
              name="requiredInitialAmount"
              aria-label="Acconto iniziale concordato"
              type="text"
              inputMode="decimal"
              className={field}
              placeholder="Acconto iniziale concordato"
              defaultValue={feedback.requiredInitialAmount}
            />
            <PrimaryButton type="submit">
              Crea revisione preventivo
            </PrimaryButton>
          </form>
        </Card>
      ) : (
        <EmptyState title="Sola consultazione">
          Il percorso sintetico o il permesso di scrittura non sono attivi.
        </EmptyState>
      )}
      {writable && (
        <Card title="Revisioni da accettare">
          {proposals
            .filter((x) => !x.acceptance)
            .map((x) => (
              <article key={x.id} className="crm-space-y-2 border-b py-3">
                <strong>
                  {x.scope} · revisione {x.revision}
                </strong>
                <p>
                  € {x.totalAmount.toFixed(2)} · acconto €{" "}
                  {x.requiredInitialAmount.toFixed(2)} · valida fino al{" "}
                  {x.validUntil.toISOString()}
                </p>
                <p>{x.startupConditions}</p>
                <form action={createPracticeReadinessAction}>
                  <input type="hidden" name="offerRevisionId" value={x.id} />
                  <PrimaryButton type="submit">
                    Accetta questa revisione
                  </PrimaryButton>
                </form>
              </article>
            ))}
        </Card>
      )}
      {feedback.error && (
        <p
          role="alert"
          className="rounded border border-amber-300 bg-amber-50 p-3"
        >
          Operazione non registrata ({feedback.error}). Correggi i dati o
          ricarica lo stato della pratica.
        </p>
      )}
      <Card title="Pratiche accessibili">
        {practices.length ? (
          practices.map((p) => {
            const paid = p.prerequisites.availableFunding;
            const missing = p.prerequisites.missing;
            return (
              <article
                key={p.id}
                id={`practice-${p.id}`}
                className="crm-space-y-3 border-b py-4"
              >
                <div className="flex justify-between">
                  <strong>Pratica {p.id}</strong>
                  <StatusBadge status={p.startedAt ? "avviata" : "in_attesa"} />
                </div>
                <p>Residui: {missing.join(", ") || "nessuno"}</p>
                {canViewPayments ? <p>
                  Accrediti confermati: € {paid} / €{" "}
                  {p.requiredInitialAmount?.toFixed(2)}
                </p> : null}
                <p>Pratica operativa: {p.clientServiceId ?? "da collegare"}</p>
                {hasPermission(session, 'practice_communications.read') ? <p><Link className="font-bold underline" href={`/communications?kind=READINESS&practice=${p.id}`}>Comunicazioni approvate della pratica</Link></p> : null}
                {canViewContracts ? <div>
                  <strong>Storico incarichi</strong>
                  {p.formalizations.map((f) => (
                    <p key={f.id}>
                      Revisione {f.offerRevisionId} · contratto {f.contractId} ·
                      documento/versione {f.signedDocumentId}/
                      {f.signedDocumentVersionId}
                    </p>
                  ))}
                </div> : null}
                {writable && (
                  <div className="grid gap-3 md:grid-cols-2">
                    {canViewContracts ? <form action={formalizePracticeAction}>
                      <input type="hidden" name="practiceId" value={p.id} />
                      <input
                        type="hidden"
                        name="expectedVersion"
                        value={p.version}
                      />
                      <select
                        name="contractId"
                        aria-label="Contratto firmato"
                        className={field}
                      >
                        {contracts
                          .filter((x) => x.clientId === p.clientId)
                          .map((x) => (
                            <option key={x.id} value={x.id}>
                              {x.contractNumber}
                            </option>
                          ))}
                      </select>
                      <select
                        name="signedDocumentId"
                        aria-label="Documento incarico"
                        className={field}
                      >
                        {documents
                          .filter((x) => x.clientId === p.clientId)
                          .map((x) => (
                            <option key={x.id} value={x.id}>
                              {x.title}
                            </option>
                          ))}
                      </select>
                      <select
                        name="signedDocumentVersionId"
                        aria-label="Versione documento incarico"
                        className={field}
                      >
                        {documentVersions
                          .filter((v) =>
                            documents.some(
                              (d) =>
                                d.id === v.documentId &&
                                d.clientId === p.clientId,
                            ),
                          )
                          .map((v) => (
                            <option key={v.id} value={v.id}>
                              {
                                documents.find((d) => d.id === v.documentId)
                                  ?.title
                              }{" "}
                              · versione {v.version}
                            </option>
                          ))}
                      </select>
                      <PrimaryButton type="submit">
                        Conferma incarico formalizzato
                      </PrimaryButton>
                    </form> : null}
                    <form action={linkPracticeClientServiceAction}>
                      <input type="hidden" name="practiceId" value={p.id} />
                      <input
                        type="hidden"
                        name="expectedVersion"
                        value={p.version}
                      />
                      <select
                        name="clientServiceId"
                        aria-label="Pratica operativa"
                        className={field}
                      >
                        {p.linkableServices.map((x) => (
                            <option key={x.id} value={x.id}>
                              {x.label}
                            </option>
                          ))}
                      </select>
                      <PrimaryButton type="submit">
                        Collega pratica operativa in attesa
                      </PrimaryButton>
                    </form>
                    {canViewPayments ? <><form action={recordPracticeFundingAction}>
                      <input type="hidden" name="practiceId" value={p.id} />
                      <input
                        name="reference"
                        aria-label="Riferimento accredito"
                        className={field}
                        placeholder="Riferimento univoco"
                        defaultValue={
                          feedback.practiceId === p.id
                            ? feedback.reference
                            : undefined
                        }
                      />
                      <input
                        name="amount"
                        aria-label="Importo accredito"
                        type="text"
                        inputMode="decimal"
                        className={field}
                        defaultValue={
                          feedback.practiceId === p.id
                            ? feedback.amount
                            : undefined
                        }
                      />
                      <input type="hidden" name="currency" value="EUR" />
                      <input
                        type="hidden"
                        name="expectedVersion"
                        value={p.version}
                      />
                      <PrimaryButton type="submit">
                        Dichiara accredito
                      </PrimaryButton>
                    </form>
                    <div className="crm-space-y-2">
                      {p.funding.map((e) => {
                        const current = !p.funding.some(
                          (next) => next.predecessorId === e.id,
                        );
                        return (
                          <div
                            key={e.id}
                            className="rounded border p-2"
                            data-funding-evidence-id={e.id}
                            data-funding-reference={e.reference}
                            data-funding-status={e.status}
                          >
                            <p>
                              {e.reference} · € {e.amount.toFixed(2)} ·{" "}
                              {e.status}
                            </p>
                            {current && e.status === "DECLARED" && (
                              <form action={confirmPracticeFundingAction}>
                                <input
                                  type="hidden"
                                  name="practiceId"
                                  value={p.id}
                                />
                                <input
                                  type="hidden"
                                  name="evidenceId"
                                  value={e.id}
                                />
                                <input
                                  type="hidden"
                                  name="expectedVersion"
                                  value={p.version}
                                />
                                <PrimaryButton type="submit">
                                  Conferma accredito
                                </PrimaryButton>
                              </form>
                            )}
                            {current && e.status === "CONFIRMED" && (
                              <form action={reversePracticeFundingAction}>
                                <input
                                  type="hidden"
                                  name="practiceId"
                                  value={p.id}
                                />
                                <input
                                  type="hidden"
                                  name="evidenceId"
                                  value={e.id}
                                />
                                <input
                                  type="hidden"
                                  name="expectedVersion"
                                  value={p.version}
                                />
                                <PrimaryButton type="submit">
                                  Rettifica / storna
                                </PrimaryButton>
                              </form>
                            )}
                          </div>
                        );
                      })}
                    </div></> : null}
                    <form action={decidePracticeMaterialAction}>
                      <input type="hidden" name="practiceId" value={p.id} />
                      <input
                        type="hidden"
                        name="expectedVersion"
                        value={p.version}
                      />
                      <select
                        name="checklistItemId"
                        aria-label="Requisito materiale"
                        className={field}
                      >
                        {items
                          .filter((x) => x.clientId === p.clientId)
                          .map((x) => (
                            <option key={x.id} value={x.id}>
                              {x.title}
                            </option>
                          ))}
                      </select>
                      <select
                        name="documentId"
                        aria-label="Documento materiale"
                        className={field}
                      >
                        <option value="">Nessun documento</option>
                        {documents
                          .filter((x) => x.clientId === p.clientId)
                          .map((x) => (
                            <option key={x.id} value={x.id}>
                              {x.title}
                            </option>
                          ))}
                      </select>
                      <select
                        name="documentVersionId"
                        aria-label="Versione documento materiale"
                        className={field}
                      >
                        <option value="">Nessuna versione</option>
                        {documentVersions
                          .filter((v) =>
                            documents.some(
                              (d) =>
                                d.id === v.documentId &&
                                d.clientId === p.clientId,
                            ),
                          )
                          .map((v) => (
                            <option key={v.id} value={v.id}>
                              Versione {v.version} ·{" "}
                              {v.checksum ?? "checksum non disponibile"}
                            </option>
                          ))}
                      </select>
                      <select
                        name="status"
                        aria-label="Decisione materiale"
                        className={field}
                      >
                        <option>VALIDATED</option>
                        <option>NOT_NEEDED</option>
                        <option>INVALIDATED</option>
                      </select>
                      <input
                        name="reason"
                        aria-label="Motivazione decisione"
                        className={field}
                        placeholder="Motivazione"
                      />
                      <PrimaryButton type="submit">
                        Registra decisione materiale
                      </PrimaryButton>
                    </form>
                    <div className="crm-space-y-1">
                      <strong>Storico materiali</strong>
                      {p.materials.map((m) => (
                        <p
                          key={m.id}
                          data-material-evidence-id={m.id}
                          data-material-checklist-item-id={m.checklistItemId}
                          data-material-status={m.status}
                          data-material-sequence={m.sequence}
                        >
                          {m.checklistItemId} · decisione {m.sequence} ·{" "}
                          {m.status} ·{" "}
                          {m.documentVersionId ?? m.reason ?? "senza documento"}
                        </p>
                      ))}
                    </div>
                    <form action={attestPracticeMaterialsCompleteAction}>
                      <input type="hidden" name="practiceId" value={p.id} />
                      <input
                        type="hidden"
                        name="expectedVersion"
                        value={p.version}
                      />
                      <input
                        name="emptyChecklistReason"
                        aria-label="Motivazione checklist non applicabile"
                        className={field}
                        placeholder="Motivazione se la checklist non è applicabile"
                      />
                      <PrimaryButton type="submit">
                        Attesta materiali completi
                      </PrimaryButton>
                    </form>
                    <form action={startPracticeAction}>
                      <input type="hidden" name="practiceId" value={p.id} />
                      <input
                        type="hidden"
                        name="expectedVersion"
                        value={p.version}
                      />
                      <PrimaryButton type="submit">
                        Avvia esplicitamente
                      </PrimaryButton>
                    </form>
                    {p.startedAt && (
                      <Link className="inline-flex rounded-xl bg-fai-green px-4 py-2 font-bold text-white" href={`/engagement-dossiers/new/${p.id}`}>
                        Preanalisi → dossier e consegna
                      </Link>
                    )}
                  </div>
                )}
              </article>
            );
          })
        ) : (
          <EmptyState title="Nessuna pratica" />
        )}
      </Card>
    </div>
  );
}
