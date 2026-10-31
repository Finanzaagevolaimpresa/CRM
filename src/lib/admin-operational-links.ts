import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import type { AuthSession } from './auth';
import { updateActor, type UpdateCredentials } from './record-updates';
import { recordUpdatePermission } from './record-update-context';
import { adminRecordVersion as digest, assertAdminRecordContextVisible, adminReferenceRows } from './admin-records';
import { mapSerializableConflict, SerializableConflictError } from './serializable';
import { canonicalSha256 } from './canonical-json';
import { currentPracticeFormalization } from './admin-practice-formalization-store';
import { assertOperationalActive } from './admin-operational-state';
import { readPrivateDocumentBounded } from './storage';
import { createHash } from 'node:crypto';
import { operationalLinkModel, linkRoot, linkId, linkChoice, linkCommand, linkFields, OperationalLinkError, type LinkChoice, type LinkRoot } from './admin-operational-link-contract';
type Tx = Prisma.TransactionClient;
type Actor = Awaited<ReturnType<typeof updateActor>>;
type Row = Record<string, unknown> & { id: string };
type Change = { model: LinkRoot; id: string; label: string; before: Record<string, string | null>; after: Record<string, string | null> };
function fail(code: OperationalLinkError['code']): never { throw new OperationalLinkError(code); }
const plain = (value: unknown) => value === null ? Prisma.JsonNull : JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const identity = (model: LinkRoot, id: string) => model + ':' + id;
async function transaction<T>(db: PrismaClient, work: (tx: Tx) => Promise<T>) {
  try { return await db.$transaction(async tx => { const result = await work(tx);
    await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE'); return result;
  }, { isolationLevel: 'Serializable', timeout: 30000 }); } catch (error) { throw mapSerializableConflict(error); }
}
async function authority(tx: Tx, session: AuthSession, model: LinkRoot, proof?: UpdateCredentials) {
  const current = await updateActor(tx, session, proof), a = current.actor;
  const permissions = model === 'ClientService' || model === 'PracticeReadiness' ? ['service.read', 'service.write', 'contract.read', 'contract.write', 'payment.read', 'document.download']
    : ['lead.read', 'lead.write', 'client.read', 'client.write'];
  if (a.role !== 'admin' || permissions.some(p => !recordUpdatePermission(a, p as Parameters<typeof recordUpdatePermission>[1]))) fail('DENIED');
  return current;
}
async function row(tx: Tx, current: Actor, model: LinkRoot | 'ServiceCatalog' | 'Contract' | 'Payment' | 'DocumentVersion' | 'PracticeOfferRevision', id: string) {
  linkId.parse(id);
  const table = { Lead: 'Lead', Client: 'Client', ClientService: 'ClientService', ServiceCatalog: 'ServiceCatalog', Contract: 'Contract', Payment: 'Payment',
    PracticeReadiness: 'PracticeReadiness', DocumentVersion: 'DocumentVersion', PracticeOfferRevision: 'PracticeOfferRevision' }[model];
  const uuid = model === 'PracticeReadiness' || model === 'PracticeOfferRevision';
  if (uuid) z.string().uuid().parse(id);
  const found = await tx.$queryRawUnsafe<Row[]>('SELECT * FROM "' + table + '" WHERE id=$1' + (uuid ? '::uuid' : '') + ' FOR UPDATE', id);
  if (found.length !== 1 || found[0].deletedAt) fail('CONTEXT');
  await assertAdminRecordContextVisible(tx, current.actor, model, found[0]);
  if (model === 'PracticeReadiness') {
    await assertOperationalActive(tx, model, id); await assertOperationalActive(tx, 'ControlledIntake', String(found[0].controlledIntakeId));
  }
  return found[0];
}
function title(model: string, value: Row) {
  const labels: Record<string, string> = { Lead: 'Lead', Client: 'Cliente', ClientService: 'Servizio acquistato', PracticeReadiness: 'Pratica',
    ServiceCatalog: 'Servizio di catalogo', Contract: 'Contratto', Payment: 'Pagamento', DocumentVersion: 'Versione documentale', PracticeOfferRevision: 'Preventivo accettato' };
  return (labels[model] ?? model) + ' · ' + String(value.displayName ?? value.name ?? value.contractNumber ?? value.scope
    ?? ([value.firstName, value.lastName].filter(Boolean).join(' ') || value.id));
}
const displayedLinkFields = {
  clientId: { label: 'Cliente', target: 'Client' }, leadId: { label: 'Lead', target: 'Lead' },
  serviceCatalogId: { label: 'Servizio di catalogo', target: 'ServiceCatalog' }, contractId: { label: 'Contratto', target: 'Contract' },
  paymentId: { label: 'Pagamento', target: 'Payment' }, clientServiceId: { label: 'Servizio acquistato', target: 'ClientService' },
  acceptedOfferRevisionId: { label: 'Preventivo già accettato', target: 'PracticeOfferRevision' },
  signedDocumentVersionId: { label: 'Versione firmata', target: 'DocumentVersion' },
} as const;
async function describeChanges(tx: Tx, current: Actor, changes: Change[]) {
  const result = [];
  for (const change of changes) {
    const details = [];
    for (const [name, descriptor] of Object.entries(displayedLinkFields)) {
      if (!Object.hasOwn(change.after, name) || change.before[name] === change.after[name]) continue;
      const describe = async (id: string | null) => {
        if (!id) return 'Nessun collegamento';
        const target = await row(tx, current, descriptor.target, id);
        if (descriptor.target === 'DocumentVersion') {
          const document = await tx.document.findUniqueOrThrow({ where: { id: String(target.documentId) } });
          return document.title + ' · versione ' + target.version;
        }
        return title(descriptor.target, target);
      };
      details.push({ label: descriptor.label, before: await describe(change.before[name]), after: await describe(change.after[name]) });
    }
    if (change.before.paymentStatus !== change.after.paymentStatus) details.push({ label: 'Stato del pagamento nel servizio',
      before: String(change.before.paymentStatus ?? '').replaceAll('_', ' '), after: String(change.after.paymentStatus ?? '').replaceAll('_', ' ') });
    if (change.before.requiredInitialAmount !== change.after.requiredInitialAmount) details.push({ label: 'Importo iniziale previsto dal preventivo accettato',
      before: String(change.before.requiredInitialAmount ?? '') + ' EUR', after: String(change.after.requiredInitialAmount ?? '') + ' EUR' });
    result.push({ ...change, details });
  }
  return result;
}
async function plan(tx: Tx, current: Actor, input: LinkChoice) {
  const fields = linkFields[input.model];
  if (Object.keys(input.values).length !== fields.length || fields.some(field => !Object.hasOwn(input.values, field.name))
    || Object.keys(input.values).some(name => !fields.some(field => field.name === name))) fail('INVALID');
  for (const field of fields) if (input.values[field.name]) linkId.parse(input.values[field.name]); else if (field.required) fail('INVALID');
  const source = await row(tx, current, input.model, input.id), basis: Row[] = [source], changes: Change[] = [];
  function change(model: LinkRoot, record: Row, values: Record<string, string | null>) {
    const before = Object.fromEntries(Object.keys(values).map(key => [key, record[key] === null ? null : String(record[key])]));
    if (digest(before) !== digest(values)) changes.push({ model, id: record.id, label: title(model, record), before, after: values });
  }
  if (input.model === 'PracticeReadiness') {
    const practice = await tx.practiceReadiness.findUniqueOrThrow({ where: { id: input.id } });
    const original = practice.currentFormalizationId ? await tx.practiceFormalization.findUnique({ where: { id: practice.currentFormalizationId } }) : null;
    if (!original || !await currentPracticeFormalization(tx, practice, original)) fail('FORMALIZED');
    const offer = await row(tx, current, 'PracticeOfferRevision', input.values.acceptedOfferRevisionId);
    const acceptance = await tx.practiceOfferAcceptance.findUnique({ where: { offerRevisionId: offer.id } });
    const serviceRevision = await tx.serviceCatalogRevision.findUnique({ where: { id: String(offer.serviceRevisionId) } });
    if (!acceptance || !serviceRevision || offer.controlledIntakeId !== practice.controlledIntakeId || offer.clientId !== practice.clientId || offer.projectId !== practice.projectId
      || acceptance.evidenceHash !== canonicalSha256({ offerRevisionId: offer.id, payloadHash: offer.payloadHash, acceptedAt: acceptance.acceptedAt.toISOString(), acceptedById: acceptance.acceptedById })) fail('CONTEXT');
    const contract = await row(tx, current, 'Contract', input.values.contractId), version = await row(tx, current, 'DocumentVersion', input.values.signedDocumentVersionId);
    const document = await tx.document.findUnique({ where: { id: String(version.documentId) } });
    const service = await row(tx, current, 'ClientService', input.values.clientServiceId);
    const payment = input.values.paymentId ? await row(tx, current, 'Payment', input.values.paymentId) : null;
    if (!document || document.deletedAt || document.status !== 'verificato' || document.clientId !== practice.clientId || document.projectId !== practice.projectId
      || contract.clientId !== practice.clientId || contract.projectId !== practice.projectId || contract.status !== 'firmato' || !contract.signedAt || contract.signedDocumentId !== document.id
      || String(contract.totalAmount) !== String(offer.totalAmount) || String(contract.taxableAmount) !== String(offer.taxableAmount) || String(contract.vatAmount) !== String(offer.vatAmount)
      || service.clientId !== practice.clientId || service.projectId !== practice.projectId || document.clientServiceId && document.clientServiceId !== service.id) fail('CONTEXT');
    await assertAdminRecordContextVisible(tx, current.actor, 'Document', document);
    if (payment && (payment.clientId !== practice.clientId || payment.contractId !== contract.id)) fail('PAYMENT');
    if (await tx.practiceReadiness.count({ where: { id: { not: practice.id }, OR: [{ clientServiceId: service.id }, { contractId: contract.id }] } })) fail('CONTEXT');
    if (!/^[a-f0-9]{64}$/.test(String(version.checksum ?? ''))) fail('CONTEXT');
    let bytes: Buffer;
    try { bytes = await readPrivateDocumentBounded(String(version.storagePath), 50 * 1024 * 1024); } catch { return fail('CONTEXT'); }
    if (!bytes.length || createHash('sha256').update(bytes).digest('hex') !== version.checksum) fail('CONTEXT');
    basis.push(offer, acceptance as unknown as Row, serviceRevision as unknown as Row, original as unknown as Row, contract, document as unknown as Row, version, service);
    if (payment) basis.push(payment);
    const bindings = { currentFormalizationId: original.id, acceptedOfferRevisionId: offer.id, contractId: contract.id,
      signedDocumentId: document.id, signedDocumentVersionId: version.id, clientServiceId: service.id, commercialOfferId: String(offer.commercialOfferId),
      offerSnapshotHash: String(offer.payloadHash), offerRevision: String(offer.revision), serviceRevisionId: String(offer.serviceRevisionId),
      requiredInitialAmount: String(offer.requiredInitialAmount), currency: String(offer.currency) };
    change('PracticeReadiness', source, bindings);
    change('ClientService', service, { serviceCatalogId: serviceRevision.serviceCatalogId, contractId: contract.id, paymentId: payment?.id ?? null,
      paymentStatus: payment ? String(payment.status) : 'da_incassare' });
    // A service-only alignment still needs a before/after formalization anchor
    // in the immutable correction receipt; it never invents a formalization.
    if (changes.length && !changes.some(c => c.model === 'PracticeReadiness')) changes.unshift({ model: 'PracticeReadiness', id: practice.id,
      label: title('PracticeReadiness', source), before: bindings, after: bindings });
  } else if (input.model === 'ClientService') {
    const catalog = await row(tx, current, 'ServiceCatalog', input.values.serviceCatalogId);
    if (!catalog.active) fail('CONTEXT'); basis.push(catalog);
    const contract = input.values.contractId ? await row(tx, current, 'Contract', input.values.contractId) : null;
    const payment = input.values.paymentId ? await row(tx, current, 'Payment', input.values.paymentId) : null;
    if (contract && (contract.clientId !== source.clientId || contract.projectId !== source.projectId
      || ['archiviato', 'annullato'].includes(String(contract.status)))) fail('CONTEXT');
    if (payment && (!contract || payment.clientId !== source.clientId || payment.contractId !== contract.id)) fail('PAYMENT');
    if (contract) basis.push(contract); if (payment) basis.push(payment);
    const practices = await tx.practiceReadiness.findMany({ where: { clientServiceId: input.id } });
    // A formalized practice is rectified from its own signed-context operation.
    // This writer cannot leave its accepted catalogue or contract inconsistent.
    for (const practice of practices) {
      const revision = await tx.serviceCatalogRevision.findUnique({ where: { id: practice.serviceRevisionId } });
      if (!revision || practice.contractId !== (contract?.id ?? null) || revision.serviceCatalogId !== catalog.id) fail('FORMALIZED');
      basis.push(practice as unknown as Row, revision as unknown as Row);
    }
    change('ClientService', source, { serviceCatalogId: catalog.id, contractId: contract?.id ?? null,
      paymentId: payment?.id ?? null, paymentStatus: payment ? String(payment.status) : 'da_incassare' });
  } else {
    const leadId = input.model === 'Lead' ? input.id : input.values.leadId || null;
    const clientId = input.model === 'Client' ? input.id : input.values.clientId || null;
    const leads = await tx.lead.findMany({ where: { OR: [...(leadId ? [{ id: leadId }] : []), ...(clientId ? [{ clientId }] : [])] }, orderBy: { id: 'asc' } });
    const clients = await tx.client.findMany({ where: { OR: [...(clientId ? [{ id: clientId }] : []), ...(leadId ? [{ leadId }] : [])] }, orderBy: { id: 'asc' } });
    if (leads.length + clients.length > 200) fail('CONTEXT');
    for (const candidate of leads) {
      const lead = await row(tx, current, 'Lead', candidate.id); basis.push(lead);
      change('Lead', lead, { clientId: lead.id === leadId ? clientId : null });
    }
    for (const candidate of clients) {
      const client = await row(tx, current, 'Client', candidate.id); basis.push(client);
      change('Client', client, { leadId: client.id === clientId ? leadId : null });
    }
    if (leadId && !leads.some(v => v.id === leadId) || clientId && !clients.some(v => v.id === clientId)) fail('CONTEXT');
  }
  return { source, changes, version: digest({ protocol: 'ADMIN_OPERATIONAL_LINK_V1', input: { model: input.model, id: input.id, values: input.values }, basis, changes }) };
}
export async function previewAdminOperationalLink(db: PrismaClient, session: AuthSession, raw: unknown) {
  const input = linkChoice.parse(raw);
  return transaction(db, async tx => { const current = await authority(tx, session, input.model), value = await plan(tx, current, input);
    const changes = await describeChanges(tx, current, value.changes);
    await current.finish(); return { changes, version: value.version };
  });
}
async function references(tx: Tx, current: Actor, source: Row, target: string, query = '', page = 1) {
  if (target !== 'PracticeOfferRevision') return adminReferenceRows(tx, current.actor, target, query, page);
  const rows = await tx.practiceOfferRevision.findMany({ where: { controlledIntakeId: String(source.controlledIntakeId),
    clientId: String(source.clientId), projectId: source.projectId ? String(source.projectId) : null, acceptance: { isNot: null },
    ...(query ? { OR: [{ scope: { contains: query, mode: 'insensitive' } }, ...(z.string().uuid().safeParse(query).success ? [{ id: query }] : [])] } : {}) },
    orderBy: [{ revision: 'desc' }, { id: 'asc' }], skip: (page - 1) * 50, take: 51 });
  return { options: rows.slice(0, 50).map(v => ({ value: v.id, label: 'Revisione ' + v.revision + ' · ' + v.scope + ' · ' + v.totalAmount.toFixed(2) + ' EUR', group: target })), hasNext: rows.length > 50 };
}
export async function searchAdminOperationalLink(db: PrismaClient, session: AuthSession, raw: unknown) {
  const input = z.object({ model: linkRoot, id: linkId, field: z.string(), query: z.string().trim().max(200), page: z.number().int().min(1).max(10000) }).strict().parse(raw);
  const field = linkFields[input.model].find(field => field.name === input.field); if (!field) return fail('INVALID');
  return transaction(db, async tx => { const current = await authority(tx, session, input.model);
    const source = await row(tx, current, input.model, input.id);
    const result = await references(tx, current, source, field.target, input.query, input.page); await current.finish(); return result;
  });
}
export async function readAdminOperationalLink(db: PrismaClient, session: AuthSession, rawModel: unknown, rawId: unknown, page = 1) {
  const model = linkRoot.parse(rawModel), id = linkId.parse(rawId);
  z.number().int().min(1).max(10000).parse(page);
  return transaction(db, async tx => { const current = await authority(tx, session, model), source = await row(tx, current, model, id);
    const values: Record<string, string> = {}, fields = [];
    for (const field of linkFields[model]) {
      const selectedValue = model === 'PracticeReadiness' && field.name === 'paymentId' && source.clientServiceId
        ? (await tx.clientService.findUnique({ where: { id: String(source.clientServiceId) } }))?.paymentId : source[field.name];
      values[field.name] = String(selectedValue ?? '');
      const found = await references(tx, current, source, field.target);
      if (values[field.name] && !found.options.some(v => v.value === values[field.name])) {
        const selected = await row(tx, current, field.target, values[field.name]);
        found.options.unshift({ value: selected.id, label: title(field.target, selected), group: field.target });
      }
      fields.push({ ...field, options: found.options });
    }
    const history = await tx.adminRecordRevision.findMany({ where: { model: operationalLinkModel, recordId: identity(model, id), operation: { not: 'CLOSE' } },
      orderBy: [{ createdAt: 'desc' }, { transactionId: 'desc' }], skip: (page - 1) * 50, take: 51, include: { actor: { select: { name: true } } } });
    await current.finish(); return { model, id, label: title(model, source), values, fields, page, hasMore: history.length > 50,
      history: history.slice(0, 50).map(v => ({ commandId: v.commandId, reason: v.reason, at: v.createdAt.toISOString(),
        actor: v.actor.name, before: v.before, after: v.after })) };
  });
}
async function journal(tx: Tx, current: Actor, input: LinkChoice & { commandId: string; reason: string }, requestHash: string,
  operation: 'UPDATE' | 'CLOSE', before: unknown, after: unknown) {
  const beforeHash = digest(before), afterHash = digest(after), recordId = identity(input.model, input.id);
  await tx.adminRecordRevision.create({ data: { commandId: input.commandId, actorId: current.actor.id, sessionId: current.registry.id,
    model: operationalLinkModel, recordId, operation, requestHash, beforeHash, afterHash, before: plain(before), after: plain(after), reason: input.reason } });
  await tx.auditLog.create({ data: { id: 'admin-record:' + input.commandId, actorId: current.actor.id, entityType: operationalLinkModel,
    entityId: recordId, event: operation === 'CLOSE' ? 'admin_record_attempt_closed' : 'admin_record_changed',
    after: operation === 'CLOSE' ? { commandId: input.commandId } : { commandId: input.commandId, action: operation, beforeHash, afterHash,
      declaration: 'ADMINISTRATIVE_LINK_CORRECTION_NO_ACCEPTANCE_OR_SEND' } } });
}
async function commandLock(tx: Tx, id: string) { await tx.$queryRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1,0))::text', 'admin-record:' + id); }
export async function saveAdminOperationalLink(db: PrismaClient, session: AuthSession, raw: unknown, proof: UpdateCredentials) {
  const input = linkCommand.parse(raw), requestHash = digest(input);
  return transaction(db, async tx => {
    const current = await authority(tx, session, input.model, proof); await commandLock(tx, input.commandId);
    const previous = await tx.adminRecordRevision.findUnique({ where: { commandId: input.commandId } });
    if (previous) {
      if (previous.actorId !== current.actor.id || previous.model !== operationalLinkModel || previous.recordId !== identity(input.model, input.id)) fail('DENIED');
      if (previous.operation === 'CLOSE') fail('CLOSED'); if (previous.requestHash !== requestHash) fail('STALE');
      await row(tx, current, input.model, input.id); await current.finish(); return { replayed: true };
    }
    const prepared = await plan(tx, current, input);
    if (prepared.version !== input.expectedVersion) fail('STALE'); if (!prepared.changes.length) fail('INVALID');
    // Release reciprocal unique links first; the transaction remains all-or-nothing.
    for (const change of prepared.changes) if (change.model === 'Client')
      await tx.client.update({ where: { id: change.id }, data: { leadId: null } });
    for (const change of prepared.changes) {
      if (change.model === 'Lead') await tx.lead.update({ where: { id: change.id }, data: { clientId: change.after.clientId } });
      else if (change.model === 'Client') await tx.client.update({ where: { id: change.id }, data: { leadId: change.after.leadId } });
      else if (change.model === 'PracticeReadiness') {
        const v = change.after;
        await tx.practiceReadiness.update({ where: { id: change.id }, data: { contractId: v.contractId!, clientServiceId: v.clientServiceId!,
          acceptedOfferRevisionId: v.acceptedOfferRevisionId!, signedDocumentId: v.signedDocumentId!, signedDocumentVersionId: v.signedDocumentVersionId!,
          commercialOfferId: v.commercialOfferId!, offerSnapshotHash: v.offerSnapshotHash!, offerRevision: Number(v.offerRevision), serviceRevisionId: v.serviceRevisionId!,
          requiredInitialAmount: v.requiredInitialAmount!, currency: v.currency!, version: { increment: 1 },
          ...(v.acceptedOfferRevisionId !== change.before.acceptedOfferRevisionId ? { materialsCompleteAt: null, materialsCompleteById: null, materialsCompleteEvidenceId: null } : {}) } });
      } else await tx.clientService.update({ where: { id: change.id }, data: { serviceCatalogId: change.after.serviceCatalogId!,
        contractId: change.after.contractId, paymentId: change.after.paymentId, paymentStatus: change.after.paymentStatus as Prisma.ClientServiceUpdateInput['paymentStatus'] } });
    }
    const id = identity(input.model, input.id);
    const beforeValues = Object.fromEntries(linkFields[input.model].map(f => [f.name, String(prepared.source[f.name] ?? '')]));
    if (input.model === 'PracticeReadiness') {
      const oldService = prepared.source.clientServiceId ? await tx.clientService.findUnique({ where: { id: String(prepared.source.clientServiceId) } }) : null;
      const changedService = prepared.changes.find(c => c.model === 'ClientService' && c.id === prepared.source.clientServiceId);
      beforeValues.paymentId = String(changedService ? changedService.before.paymentId ?? '' : oldService?.paymentId ?? '');
    }
    await journal(tx, current, input, requestHash, 'UPDATE',
      { id, values: beforeValues, changes: prepared.changes.map(c => ({ model: c.model, id: c.id, values: c.before })) },
      { id, values: input.values, changes: prepared.changes.map(c => ({ model: c.model, id: c.id, values: c.after })) });
    if (input.model === 'PracticeReadiness') {
      const p = await tx.practiceReadiness.findUniqueOrThrow({ where: { id: input.id } });
      await currentPracticeFormalization(tx, p, await tx.practiceFormalization.findUnique({ where: { id: p.currentFormalizationId! } }));
    }
    await current.finish(); return { replayed: false };
  });
}
export async function reconcileAdminOperationalLink(db: PrismaClient, session: AuthSession, raw: unknown) {
  const input = z.object({ model: linkRoot, id: linkId, commandId: z.string().uuid(), close: z.boolean() }).strict().parse(raw);
  for (let attempt = 0; ; attempt++) {
    try { return await transaction(db, async tx => {
      const current = await authority(tx, session, input.model); await row(tx, current, input.model, input.id); await commandLock(tx, input.commandId);
      const previous = await tx.adminRecordRevision.findUnique({ where: { commandId: input.commandId } });
      if (previous) {
        if (previous.actorId !== current.actor.id || previous.model !== operationalLinkModel || previous.recordId !== identity(input.model, input.id)) fail('DENIED');
        await current.finish(); return { status: previous.operation === 'CLOSE' ? 'CLOSED' as const : 'RECORDED' as const };
      }
      if (!input.close) { await current.finish(); return { status: 'UNKNOWN' as const }; }
      await journal(tx, current, { ...input, values: {}, reason: 'Chiusura esplicita del tentativo di rettifica dei collegamenti' },
        digest(input), 'CLOSE', null, null); await current.finish(); return { status: 'CLOSED' as const };
    }); } catch (error) { if (!(error instanceof SerializableConflictError) || attempt >= 2) throw error; }
  }
}
