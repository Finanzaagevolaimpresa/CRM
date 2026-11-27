import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import type { AuthSession } from './auth';
import { canViewClient, canViewLead, canViewProject } from './access-control';
import { clientVisibilityWhere } from './core-query-policy';
import { canonicalSha256 as hash } from './canonical-json';
import { updateActor, type UpdateCredentials } from './record-updates';
import { recordUpdatePermission } from './record-update-context';
import { guardProjectResources } from './project-resource-guard';
import { withSerializableTransaction } from './serializable';
import { addDocumentCandidate, canUseOperationalDocuments, catalogAmounts, documentContextInput, documentDecisionCommand,
  documentTemplateModel, documentTemplateSnapshot, draftDocumentCommand, emptyDocumentCandidates, missingDocumentFields,
  normalizeTemplateLineEndings, OperationalDocumentError, proformaCommand, proformaDedupKey, renderDocumentTemplate, resolveDocumentFields,
  storedDocumentSnapshot, templateCommand, validateDocumentAmounts, type DocumentContextInput, type DocumentTemplate,
  templateTokens, type DocumentCandidates, type DraftDocumentCommand } from './operational-document-contract';
import { proformaGenerationDeliveryNotice, renderOperationalPdf, renderOperationalProformaPdf } from './operational-document-pdf';

type Tx = Prisma.TransactionClient;
type Authority = Awaited<ReturnType<typeof updateActor>>;
function deny(): never { throw new OperationalDocumentError('DENIED'); }
function plain(value: unknown): Prisma.InputJsonValue { return JSON.parse(JSON.stringify(value)); }
async function lock(tx: Tx, key: string) { await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key},0))::text`; }
async function authority(tx: Tx, claimed: AuthSession, manage = false, proof?: UpdateCredentials) {
  const auth = await updateActor(tx, claimed, proof);
  if (!canUseOperationalDocuments(auth.actor) || manage && (auth.actor.role !== 'admin'
    || !recordUpdatePermission(auth.actor, 'settings.manage') || !recordUpdatePermission(auth.actor, 'contract.write'))) deny();
  return auth;
}
async function loadTemplate(tx: Tx, id: string) {
  const rows = await tx.adminRecordRevision.findMany({ where: { model: documentTemplateModel, recordId: id }, orderBy: [{ createdAt: 'asc' }, { commandId: 'asc' }] });
  const history = rows.map(row => ({ row, after: documentTemplateSnapshot.parse(row.after) }));
  history.sort((a, b) => a.after.revision - b.after.revision);
  let current: DocumentTemplate | null = null;
  for (const { row, after } of history) {
    if (after.id !== id || row.beforeHash !== hash(current) || row.afterHash !== hash(after)
      || hash(row.before) !== hash(current) || after.revision !== (current?.revision ?? 0) + 1) deny();
    current = after;
  }
  return { current, history, published: history.filter(item => item.after.state === 'PUBLISHED').at(-1) ?? null };
}
async function templates(tx: Tx) {
  const ids = await tx.adminRecordRevision.findMany({ where: { model: documentTemplateModel, operation: 'CREATE' }, select: { recordId: true } });
  return Promise.all(ids.map(row => loadTemplate(tx, row.recordId)));
}
export async function listOperationalTemplates(db: PrismaClient, claimed: AuthSession, manage = false) {
  return withSerializableTransaction(db, async tx => {
    const auth = await authority(tx, claimed, manage), all = await templates(tx);
    const authors = manage ? await tx.user.findMany({ where: { id: { in: [...new Set(all.flatMap(item => item.history.map(version => version.row.actorId)))] } }, select: { id: true, name: true } }) : [];
    await auth.finish();
    return all.flatMap(item => {
      const chosen = manage ? item.current : item.published?.after;
      return chosen ? [{ ...chosen, publishedCommandId: item.published?.row.commandId ?? null,
        history: manage ? item.history.map(row => ({ revision: row.after.revision, state: row.after.state, createdAt: row.row.createdAt.toISOString(), actorId: row.row.actorId,
          authorName: authors.find(author => author.id === row.row.actorId)?.name ?? 'Autore registrato' })) : [] }] : [];
    });
  });
}
export async function saveOperationalTemplate(db: PrismaClient, claimed: AuthSession, raw: unknown, proof: UpdateCredentials) {
  const input = templateCommand.parse(raw);
  return withSerializableTransaction(db, async tx => {
    const auth = await authority(tx, claimed, true, proof);
    await lock(tx, 'operational-template:' + input.templateId);
    const replay = await tx.adminRecordRevision.findUnique({ where: { commandId: input.commandId } });
    if (replay) {
      if (replay.actorId !== auth.actor.id || replay.sessionId !== auth.registry.id || replay.model !== documentTemplateModel || replay.requestHash !== hash(input)) deny();
      await auth.finish(); return { id: input.templateId, replay: true };
    }
    const before = (await loadTemplate(tx, input.templateId)).current;
    if ((before?.revision ?? 0) !== input.expectedVersion) throw new OperationalDocumentError('STALE');
    if (input.operation === 'PUBLISH' && (!input.approved || !before)) throw new OperationalDocumentError('TEMPLATE');
    let copiedFrom: string | null = before?.copiedFrom ?? null;
    if (input.operation === 'DUPLICATE') {
      if (before || !input.sourceTemplateId || input.sourceTemplateId === input.templateId) deny();
      const source = (await loadTemplate(tx, input.sourceTemplateId)).current;
      if (!source || normalizeTemplateLineEndings(source.body) !== input.body || source.kind !== input.kind || hash(source.required) !== hash(input.required)) throw new OperationalDocumentError('STALE');
      copiedFrom = source.id;
    }
    const after = documentTemplateSnapshot.parse({ id: input.templateId, revision: input.expectedVersion + 1, title: input.title,
      kind: input.kind, body: input.body, required: input.required, state: input.operation === 'PUBLISH' ? 'PUBLISHED' : 'DRAFT',
      copiedFrom, updatedAt: (await auth.finish()).toISOString() });
    if (after.state === 'PUBLISHED' && after.kind === 'PROFORMA') {
      const tokens = templateTokens(after.body);
      if (!(['denominazione', 'indirizzo', 'servizio', 'imponibile', 'iva', 'totale', 'scadenza'] as const).every(field => tokens.includes(field))
        || !tokens.some(field => field === 'partita_iva' || field === 'codice_fiscale')) throw new OperationalDocumentError('TEMPLATE');
    }
    const operation = before ? 'UPDATE' : 'CREATE', beforeHash = hash(before), afterHash = hash(after);
    await tx.adminRecordRevision.create({ data: { commandId: input.commandId, actorId: auth.actor.id, sessionId: auth.registry.id,
      model: documentTemplateModel, recordId: input.templateId, operation, requestHash: hash(input), beforeHash, afterHash,
      before: before ? plain(before) : Prisma.JsonNull, after: plain(after), reason: 'Libreria modelli · ' + input.operation } });
    await tx.auditLog.create({ data: { id: 'admin-record:' + input.commandId, actorId: auth.actor.id, entityType: documentTemplateModel,
      entityId: input.templateId, event: 'admin_record_changed', after: { commandId: input.commandId, action: operation, beforeHash, afterHash } } });
    await auth.finish(); return { id: input.templateId, replay: false };
  });
}
async function context(tx: Tx, auth: Authority, raw: DocumentContextInput) {
  const input = documentContextInput.parse(raw);
  let lead = null;
  if (input.leadId) {
    await tx.$queryRaw`SELECT id FROM "Lead" WHERE id=${input.leadId} FOR SHARE`;
    lead = await tx.lead.findUnique({ where: { id: input.leadId } });
    if (!lead || lead.deletedAt || !recordUpdatePermission(auth.actor, 'lead.read') || !canViewLead(auth.actor, lead)) deny();
  }
  const clientId = input.clientId ?? lead?.clientId ?? null;
  if (clientId) await tx.$queryRaw`SELECT id FROM "Client" WHERE id=${clientId} FOR SHARE`;
  const client = clientId ? await tx.client.findUnique({ where: { id: clientId } }) : null;
  if (clientId && (!client || client.deletedAt || ['sospeso', 'archiviato'].includes(client.status)
    || !recordUpdatePermission(auth.actor, 'client.read') || !canViewClient(auth.actor, client))) deny();
  // A read grant is not a commercial assignment and cannot authorize drafting
  // a financial document for somebody else's client.
  if (client && auth.actor.role === 'commerciale' && client.salesOwnerId !== auth.actor.id) deny();
  if (client) await guardProjectResources(tx, auth.actor.id, [{ clientId: client.id }]);
  const candidates = emptyDocumentCandidates();
  if (lead) {
    addDocumentCandidate(candidates, 'denominazione', lead.companyName || `${lead.firstName} ${lead.lastName}`, 'Scheda lead');
    addDocumentCandidate(candidates, 'email', lead.email, 'Scheda lead'); addDocumentCandidate(candidates, 'telefono', lead.phone, 'Scheda lead');
  }
  if (client) addDocumentCandidate(candidates, 'denominazione', client.displayName, 'Anagrafica cliente');
  const companies = client && recordUpdatePermission(auth.actor, 'company.read')
    ? await tx.company.findMany({ where: { clientId: client.id, deletedAt: null, id: { notIn: auth.actor.selectiveClientCompanyIds } }, orderBy: { id: 'asc' } }) : [];
  const signerSources: { id: string; value: string }[] = [];
  for (const company of companies) {
    const source = 'Anagrafica azienda · ' + company.name;
    addDocumentCandidate(candidates, 'denominazione', company.name, source);
    addDocumentCandidate(candidates, 'partita_iva', company.vatNumber, source); addDocumentCandidate(candidates, 'codice_fiscale', company.taxCode, source);
    addDocumentCandidate(candidates, 'indirizzo', company.legalAddress || [company.legalStreet, company.legalStreetNumber,
      company.legalPostalCode, company.legalCity, company.legalProvince].filter(Boolean).join(' '), source);
    const memberships = await tx.companyPerson.findMany({ where: { companyId: company.id, isAdministrator: true, personId: { notIn: auth.actor.selectiveClientPersonIds } } });
    const people = await tx.person.findMany({ where: { id: { in: memberships.map(row => row.personId) }, deletedAt: null } });
    for (const person of people) {
      const value = `${person.firstName} ${person.lastName}`;
      addDocumentCandidate(candidates, 'firmatario', value, source + ' · amministratore'); signerSources.push({ id: person.id, value });
    }
  }
  return { lead, client, candidates, companySourceIds: companies.map(row => row.id), signerSources };
}
async function terms(tx: Tx, auth: Authority, c: Awaited<ReturnType<typeof context>>, input: { serviceRevisionId?: string; contractId?: string }, candidates: DocumentCandidates) {
  let binding: unknown = null;
  if (input.serviceRevisionId) {
    const now = await auth.finish();
    const revision = await tx.serviceCatalogRevision.findUnique({ where: { id: input.serviceRevisionId }, include: { serviceCatalog: true } });
    if (!revision || revision.status !== 'PUBLISHED' || !revision.serviceCatalog.active || revision.validFrom > now
      || revision.validUntil && revision.validUntil <= now || revision.priceMode !== 'FIXED' || revision.netPrice === null) deny();
    const amount = catalogAmounts(revision.netPrice.toString(), revision.vatRateBps), source = `Catalogo approvato · ${revision.serviceCatalog.code} v${revision.version}`;
    addDocumentCandidate(candidates, 'servizio', revision.publicName, source); addDocumentCandidate(candidates, 'attivita', revision.shortDescription, source);
    addDocumentCandidate(candidates, 'imponibile', amount.taxable, source); addDocumentCandidate(candidates, 'iva', amount.vat, source);
    addDocumentCandidate(candidates, 'totale', amount.total, source);
    binding = revision;
  } else if (input.contractId) {
    if (!c.client || !recordUpdatePermission(auth.actor, 'contract.read')) deny();
    const contract = await tx.contract.findUnique({ where: { id: input.contractId } });
    if (!contract || contract.clientId !== c.client.id || ['annullato', 'archiviato', 'non_firmato'].includes(contract.status)
      || auth.actor.selectiveContractIds?.includes(contract.id)) deny();
    await guardProjectResources(tx, auth.actor.id, [{ clientId: c.client.id, contractId: contract.id, projectId: contract.projectId }]);
    const project = contract.projectId ? await tx.project.findUnique({ where: { id: contract.projectId } }) : null;
    if (contract.projectId && (!project || project.deletedAt || project.clientId !== c.client.id || !canViewProject(auth.actor, { ...project, client: c.client }))) deny();
    const source = 'Incarico · ' + contract.contractNumber;
    addDocumentCandidate(candidates, 'servizio', contract.serviceName, source); addDocumentCandidate(candidates, 'attivita', contract.serviceDescription, source);
    addDocumentCandidate(candidates, 'imponibile', contract.taxableAmount.toFixed(2), source);
    addDocumentCandidate(candidates, 'iva', contract.vatAmount.toFixed(2), source); addDocumentCandidate(candidates, 'totale', contract.totalAmount.toFixed(2), source);
    const payments = recordUpdatePermission(auth.actor, 'payment.read') ? await tx.payment.findMany({ where: { contractId: contract.id, clientId: c.client.id },
      select: { dueDate: true, totalAmount: true }, orderBy: { dueDate: 'asc' } }) : [];
    if (payments.length) addDocumentCandidate(candidates, 'rate', payments.map((row, index) => `${index + 1}: € ${row.totalAmount.toFixed(2)}${row.dueDate ? ' entro ' + row.dueDate.toISOString().slice(0, 10) : ''}`).join('; '), source + ' · scadenze');
    binding = { contract, payments };
  }
  return binding;
}
async function draftSetup(tx: Tx, auth: Authority, input: Pick<DraftDocumentCommand, 'context' | 'templateCommandId' | 'serviceRevisionId' | 'contractId'>) {
  const c = await context(tx, auth, input.context);
  const row = await tx.adminRecordRevision.findUnique({ where: { commandId: input.templateCommandId } });
  if (!row || row.model !== documentTemplateModel) deny();
  const template = documentTemplateSnapshot.parse(row.after), published = (await loadTemplate(tx, template.id)).published;
  if (template.kind === 'PROFORMA') throw new OperationalDocumentError('UNCONFIRMED');
  if (template.state !== 'PUBLISHED' || published?.row.commandId !== row.commandId) throw new OperationalDocumentError('STALE');
  const binding = await terms(tx, auth, c, input, c.candidates);
  if (!binding) deny();
  return { ...c, template, sourceHash: hash(plain({ context: input.context, lead: c.lead, client: c.client, candidates: c.candidates,
    templateCommandId: row.commandId, template, binding })) };
}
export async function prepareOperationalDocument(db: PrismaClient, claimed: AuthSession, input: Pick<DraftDocumentCommand, 'context' | 'templateCommandId' | 'serviceRevisionId' | 'contractId'>) {
  return withSerializableTransaction(db, async tx => {
    const auth = await authority(tx, claimed), setup = await draftSetup(tx, auth, input);
    await auth.finish(); return { candidates: setup.candidates, sourceHash: setup.sourceHash, template: setup.template };
  });
}
export async function createOperationalDocument(db: PrismaClient, claimed: AuthSession, raw: unknown) {
  const input = draftDocumentCommand.parse(raw);
  return withSerializableTransaction(db, async tx => {
    const auth = await authority(tx, claimed); await lock(tx, 'operational-document:' + input.commandId);
    const existing = await tx.operationalDocument.findUnique({ where: { id: input.commandId } });
    if (existing) {
      await context(tx, auth, input.context);
      await readableDocument(tx, auth, existing.id);
      if (existing.actorId !== auth.actor.id || existing.sessionId !== auth.registry.id || existing.requestHash !== hash(input)) deny();
      await auth.finish(); return { id: existing.id, replay: true };
    }
    const setup = await draftSetup(tx, auth, input);
    if (setup.sourceHash !== input.sourceHash) throw new OperationalDocumentError('STALE');
    const resolved = resolveDocumentFields(setup.candidates, input.choices), missing = missingDocumentFields(setup.template, resolved.values);
    if (resolved.conflicts.length) throw new OperationalDocumentError('CONFLICT');
    const snapshot = storedDocumentSnapshot.parse({ version: 1, templateTitle: setup.template.title, templateRevision: setup.template.revision,
      templateBody: setup.template.body, fields: resolved.values, sources: resolved.sources, missing, conflicts: [], termsConfirmed: input.termsConfirmed,
      serviceRevisionId: input.serviceRevisionId ?? null, contractId: input.contractId ?? null, sourceDocumentId: null,
      companySourceIds: setup.companySourceIds, signerSourceIds: setup.signerSources.filter(person => person.value === resolved.values.firmatario).map(person => person.id),
      usesPaymentSchedule: Boolean(input.contractId && setup.candidates.rate.length),
      taxStatus: input.termsConfirmed ? 'OPERATOR_REVIEWED' : 'REVIEW_REQUIRED', fiscalStatus: 'NOT_ISSUED', deliveryStatus: 'NOT_SENT' });
    const content = renderDocumentTemplate(setup.template.body, resolved.values), contentHash = hash({ content, snapshot });
    await tx.operationalDocument.create({ data: { id: input.commandId, actorId: auth.actor.id, sessionId: auth.registry.id,
      leadId: setup.lead?.id ?? null, clientId: setup.client?.id ?? null, contractId: input.contractId ?? null,
      templateCommandId: input.templateCommandId, kind: setup.template.kind, sourceHash: setup.sourceHash, contentHash, requestHash: hash(input),
      snapshot: plain(snapshot), content } });
    await tx.auditLog.create({ data: { actorId: auth.actor.id, entityType: 'OperationalDocument', entityId: input.commandId,
      event: 'operational_document_created', after: { contentHash, sourceHash: setup.sourceHash, kind: setup.template.kind } } });
    await auth.finish(); return { id: input.commandId, replay: false };
  });
}
async function readableDocument(tx: Tx, auth: Authority, id: string) {
  z.string().uuid().parse(id);
  const row = await tx.operationalDocument.findUnique({ where: { id } });
  if (!row || !row.leadId && !row.clientId) deny();
  const current = await context(tx, auth, row.leadId ? { leadId: row.leadId } : { clientId: row.clientId! });
  // Native conversion records both directions in one transaction. A document
  // made before conversion keeps its original, immutable context; only the
  // client whose unique origin is this same lead may continue that history.
  // Arbitrary links and moves from an already bound client remain denied.
  if ((current.client?.id ?? null) !== row.clientId
    && !(row.clientId === null && row.leadId && current.client?.leadId === row.leadId)) deny();
  if (row.contractId) {
    if (!recordUpdatePermission(auth.actor, 'contract.read')) deny();
    await guardProjectResources(tx, auth.actor.id, [{ clientId: row.clientId, contractId: row.contractId }]);
  }
  const snapshot = storedDocumentSnapshot.parse(row.snapshot);
  if (row.contentHash !== hash({ content: row.content, snapshot })) deny();
  if (snapshot.companySourceIds?.length && !recordUpdatePermission(auth.actor, 'company.read')
    || snapshot.companySourceIds?.some(id => auth.actor.selectiveClientCompanyIds.includes(id))
    || snapshot.signerSourceIds?.some(id => auth.actor.selectiveClientPersonIds.includes(id))
    || snapshot.usesPaymentSchedule && !recordUpdatePermission(auth.actor, 'payment.read')) deny();
  return { row, snapshot, clientId: current.client?.id ?? null };
}
/** Compose ancillary document work under the same live role, source and session checks. */
export async function admitOperationalDocumentInTransaction(tx: Tx, claimed: AuthSession, id: string, manage = false, proof?: UpdateCredentials) {
  const auth = await authority(tx, claimed, manage, proof);
  return { auth, ...await readableDocument(tx, auth, id) };
}
export async function readOperationalDocument(db: PrismaClient, claimed: AuthSession, id: string) {
  return withSerializableTransaction(db, async tx => {
    const auth = await authority(tx, claimed), { row, snapshot, clientId } = await readableDocument(tx, auth, id);
    const decision = await tx.operationalDocumentDecision.findUnique({ where: { documentId: row.id } });
    const proformas = await tx.operationalDocument.findMany({ where: { sourceDocumentId: row.id }, select: { id: true, dueDate: true, createdAt: true }, orderBy: { createdAt: 'asc' } });
    const authors = await tx.user.findMany({ where: { id: { in: [row.actorId, ...(decision ? [decision.actorId] : [])] } }, select: { id: true, name: true } });
    await auth.finish(); return { row, snapshot, clientId, decision, proformas, authors };
  });
}
export async function confirmOperationalDocument(db: PrismaClient, claimed: AuthSession, raw: unknown) {
  const input = documentDecisionCommand.parse(raw);
  return withSerializableTransaction(db, async tx => {
    const auth = await authority(tx, claimed); await lock(tx, 'operational-document:' + input.documentId);
    const { row, snapshot } = await readableDocument(tx, auth, input.documentId);
    if (row.contentHash !== input.contentHash) throw new OperationalDocumentError('STALE');
    const existing = await tx.operationalDocumentDecision.findUnique({ where: { documentId: row.id } });
    if (existing) { await auth.finish(); return { id: row.id, replay: true }; }
    if (snapshot.missing.length || snapshot.conflicts.length || !snapshot.termsConfirmed) throw new OperationalDocumentError('MISSING');
    validateDocumentAmounts(snapshot.fields);
    renderOperationalPdf({ title: 'Documento', content: row.content, reference: row.id, status: 'Contenuto da confermare' });
    await tx.operationalDocumentDecision.create({ data: { commandId: input.commandId, documentId: row.id, actorId: auth.actor.id,
      sessionId: auth.registry.id, contentHash: row.contentHash } });
    await tx.auditLog.create({ data: { actorId: auth.actor.id, entityType: 'OperationalDocument', entityId: row.id,
      event: 'operational_document_confirmed', after: { contentHash: row.contentHash } } });
    await auth.finish(); return { id: row.id, replay: false };
  });
}
export async function createOperationalProforma(db: PrismaClient, claimed: AuthSession, raw: unknown) {
  const input = proformaCommand.parse(raw), dedupKey = proformaDedupKey(input.documentId, input.contentHash, input.dueDate);
  return withSerializableTransaction(db, async tx => {
    const auth = await authority(tx, claimed); await lock(tx, 'operational-proforma:' + dedupKey);
    const source = await readableDocument(tx, auth, input.documentId);
    if (source.row.kind !== 'CONTRACT' || source.row.contentHash !== input.contentHash) throw new OperationalDocumentError('STALE');
    const decision = await tx.operationalDocumentDecision.findUnique({ where: { documentId: source.row.id } });
    if (!decision || decision.contentHash !== source.row.contentHash) throw new OperationalDocumentError('UNCONFIRMED');
    const previous = await tx.operationalDocument.findUnique({ where: { dedupKey } });
    if (previous) { await auth.finish(); return { id: previous.id, replay: true }; }
    const templateRow = await tx.adminRecordRevision.findUnique({ where: { commandId: input.templateCommandId } });
    if (!templateRow || templateRow.model !== documentTemplateModel) deny();
    const template = documentTemplateSnapshot.parse(templateRow.after), published = (await loadTemplate(tx, template.id)).published;
    if (template.kind !== 'PROFORMA' || template.state !== 'PUBLISHED' || published?.row.commandId !== templateRow.commandId) throw new OperationalDocumentError('TEMPLATE');
    const fields = { ...source.snapshot.fields, scadenza: input.dueDate };
    validateDocumentAmounts(fields);
    if (missingDocumentFields(template, fields).length) throw new OperationalDocumentError('MISSING');
    const snapshot = storedDocumentSnapshot.parse({ ...source.snapshot, fields, sources: { ...source.snapshot.sources, scadenza: 'Scadenza confermata sul caso' },
      sourceDocumentId: source.row.id, templateTitle: template.title, templateRevision: template.revision, templateBody: template.body, missing: [], conflicts: [] });
    const content = ['NOTA PROFORMA - documento non fiscale', '', renderDocumentTemplate(template.body, fields), '',
      'Emissione fiscale e invio SdI: non eseguiti.', proformaGenerationDeliveryNotice].join('\n');
    const contentHash = hash({ content, snapshot });
    // Validate the downloadable representation before committing a proforma.
    renderOperationalProformaPdf({ id: input.commandId, content });
    await tx.operationalDocument.create({ data: { id: input.commandId, actorId: auth.actor.id, sessionId: auth.registry.id,
      leadId: source.row.leadId, clientId: source.row.clientId, contractId: source.row.contractId, sourceDocumentId: source.row.id,
      templateCommandId: templateRow.commandId, kind: 'PROFORMA', sourceHash: hash({ source: source.row.contentHash, decision: decision.commandId, template: templateRow.afterHash }),
      contentHash, requestHash: hash(input), dedupKey, snapshot: plain(snapshot), content, dueDate: input.dueDate } });
    await tx.auditLog.create({ data: { actorId: auth.actor.id, entityType: 'OperationalDocument', entityId: input.commandId,
      event: 'operational_proforma_prepared', after: { contentHash, sourceDocumentId: source.row.id } } });
    await auth.finish(); return { id: input.commandId, replay: false };
  });
}
export async function operationalDocumentOptions(db: PrismaClient, claimed: AuthSession, raw: DocumentContextInput) {
  return withSerializableTransaction(db, async tx => {
    const auth = await authority(tx, claimed), c = await context(tx, auth, raw), now = await auth.finish();
    const services = await tx.serviceCatalogRevision.findMany({ where: { status: 'PUBLISHED', priceMode: 'FIXED', netPrice: { not: null },
      validFrom: { lte: now }, OR: [{ validUntil: null }, { validUntil: { gt: now } }], serviceCatalog: { active: true } }, orderBy: { publicName: 'asc' } });
    const contracts = c.client && recordUpdatePermission(auth.actor, 'contract.read') ? await tx.contract.findMany({ where: { clientId: c.client.id, status: { notIn: ['annullato', 'archiviato', 'non_firmato'] } },
      select: { id: true, contractNumber: true, serviceName: true, projectId: true } }) : [];
    const admittedContracts = [];
    for (const contract of contracts) {
      if (auth.actor.selectiveContractIds?.includes(contract.id)) continue;
      const project = contract.projectId ? await tx.project.findUnique({ where: { id: contract.projectId } }) : null;
      if (contract.projectId && (!project || project.deletedAt || !c.client || !canViewProject(auth.actor, { ...project, client: c.client }))) continue;
      admittedContracts.push({ id: contract.id, label: contract.contractNumber + ' · ' + contract.serviceName });
    }
    const candidates = await tx.operationalDocument.findMany({ where: c.lead ? { leadId: c.lead.id } : { OR: [
      { clientId: c.client!.id }, ...(c.client!.leadId ? [{ leadId: c.client!.leadId, clientId: null }] : []),
    ] },
      select: { id: true, kind: true, createdAt: true }, orderBy: { createdAt: 'desc' } });
    const documents = [];
    for (const item of candidates) {
      try {
        const admitted = await readableDocument(tx, auth, item.id);
        if (admitted.clientId === (c.client?.id ?? null)) documents.push(item);
      } catch (error) {
        if (!(error instanceof OperationalDocumentError && error.code === 'DENIED')) throw error;
      }
    }
    await auth.finish(); return { title: c.lead?.companyName || (c.lead ? `${c.lead.firstName} ${c.lead.lastName}` : c.client!.displayName),
      clientId: c.client?.id ?? null, candidates: c.candidates, services: services.map(row => ({ id: row.id, label: row.publicName + ' · EUR ' + row.netPrice!.toFixed(2) })), contracts: admittedContracts, documents };
  });
}
export async function searchOperationalDocumentClient(db: PrismaClient, claimed: AuthSession, term: string) {
  const query = z.string().trim().regex(/^(?:[0-9]{11}|[A-Za-z0-9]{16})$/).parse(term).toUpperCase();
  return withSerializableTransaction(db, async tx => {
    const auth = await authority(tx, claimed);
    if (!recordUpdatePermission(auth.actor, 'client.read') || !recordUpdatePermission(auth.actor, 'company.read')) deny();
    const visible = await tx.client.findMany({ where: { deletedAt: null, ...(auth.actor.role === 'commerciale' ? { salesOwnerId: auth.actor.id } : {}),
      AND: [clientVisibilityWhere(auth.actor)] }, select: { id: true, displayName: true, salesOwnerId: true, consultantId: true } });
    const companies = await tx.company.findMany({ where: { clientId: { in: visible.map(row => row.id) }, deletedAt: null,
      OR: [{ vatNumber: { equals: query, mode: 'insensitive' } }, { taxCode: { equals: query, mode: 'insensitive' } }] }, select: { clientId: true } });
    const ids = new Set(companies.map(row => row.clientId));
    await auth.finish(); return visible.filter(row => ids.has(row.id) && canViewClient(auth.actor, row)).map(row => ({ id: row.id, name: row.displayName }));
  });
}
