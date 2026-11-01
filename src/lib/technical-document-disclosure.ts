import { z } from 'zod';
import type { Document, DocumentVersion, Prisma } from '@prisma/client';
import { canonicalSha256 } from './canonical-json';
import { isFinancialDocument } from './financial-privacy-policy';
import { isTechnicalAccount, type TechnicalConfidentialityActor } from './technical-confidentiality';

export const technicalDisclosureModel = 'TechnicalDocumentDisclosure';
export const disclosureDigest = (value: unknown) => canonicalSha256(JSON.parse(JSON.stringify(value)));
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const disclosureAssertions = z.object({ noPayments: z.literal(true), noSignedCustomerContracts: z.literal(true),
  noFreeOrInternalNotes: z.literal(true), reviewedExactVersion: z.literal(true) }).strict().nullable();
export const disclosureSnapshot = z.object({
  id: z.string().min(1).max(128), revision: z.number().int().nonnegative().safe(),
  classification: z.enum(['UNCLASSIFIED', 'RESTRICTED', 'TECHNICAL_CONTENT']),
  sourceSha256: hash.nullable(), contentSha256: hash.nullable(),
  assertions: disclosureAssertions,
}).strict().superRefine((v, ctx) => {
  if (v.classification === 'TECHNICAL_CONTENT' && (!v.sourceSha256 || !v.contentSha256 || !v.assertions)) {
    ctx.addIssue({ code: 'custom', message: 'Verifica esplicita della versione richiesta.' });
  }
});
export type DisclosureSnapshot = z.infer<typeof disclosureSnapshot>;
export type DisclosureDb = Pick<Prisma.TransactionClient,
  '$queryRawUnsafe' | 'adminRecordRevision' | 'documentVersion' | 'contract' | 'payment' | 'practiceFormalization'>;
export function originalDisclosure(id: string): DisclosureSnapshot {
  return { id, revision: 0, classification: 'UNCLASSIFIED', sourceSha256: null, contentSha256: null, assertions: null };
}
export function restrictedDocumentMetadata(document: Pick<Document, 'title' | 'fileName' | 'type' | 'documentCategory' | 'serviceArea' | 'mimeType'>) {
  const text = [document.title, document.fileName, document.type, document.documentCategory]
    .join(' ').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  return isFinancialDocument(document)
    || /firmat|signed|quietanz|ricevut|receipt|iban|swift|bonific|corrispettiv|compens[oi]|accont[oi]|saldo|\.p7m\b|pkcs7/.test(text)
    || /(?:^|[\s_.-])(not[ae]s?|annotazion[ei]|appunt[oi]|comment[oi]|memo)(?:$|[\s_.-])/.test(text);
}
export function disclosureSource(document: Document, version: DocumentVersion) {
  // Bind the reviewed version and its disclosure metadata, not the mutable
  // pointer to the document's newest bytes. Appending another version never
  // classifies it; existing grant/context fingerprints remain independently checked.
  const metadata = { id: document.id, clientId: document.clientId, companyId: document.companyId,
    projectId: document.projectId, clientServiceId: document.clientServiceId,
    title: document.title, fileName: document.fileName, type: document.type, mimeType: document.mimeType,
    documentCategory: document.documentCategory, serviceArea: document.serviceArea,
    visibilityLevel: document.visibilityLevel, containsSensitiveData: document.containsSensitiveData,
    status: document.status, validUntil: document.validUntil, deletedAt: document.deletedAt,
    uploadedById: document.uploadedById };
  return disclosureDigest({ protocol: 'TECHNICAL_DISCLOSURE_SOURCE_V1', metadata, version });
}
export async function readDisclosure(db: Pick<DisclosureDb, 'adminRecordRevision' | '$queryRawUnsafe'>, id: string, write = false) {
  await db.$queryRawUnsafe(write
    ? 'SELECT pg_advisory_xact_lock(hashtextextended($1,0))::text'
    : 'SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))::text', 'technical-disclosure:' + id);
  const rows = await db.adminRecordRevision.findMany({ where: { model: technicalDisclosureModel, recordId: id, operation: { not: 'CLOSE' } },
    orderBy: [{ createdAt: 'asc' }, { commandId: 'asc' }], take: 1001 });
  if (rows.length > 1000) throw new Error('TECHNICAL_DISCLOSURE_UNAVAILABLE');
  const history = rows.map(row => {
    const before = disclosureSnapshot.parse(row.before), after = disclosureSnapshot.parse(row.after);
    if (row.operation !== 'UPDATE' || before.id !== id || after.id !== id || after.revision !== before.revision + 1
      || disclosureDigest(before) !== row.beforeHash || disclosureDigest(after) !== row.afterHash) throw new Error('TECHNICAL_DISCLOSURE_INTEGRITY');
    return { commandId: row.commandId, reason: row.reason, createdAt: row.createdAt.toISOString(), before, after };
  }).sort((a, b) => a.after.revision - b.after.revision);
  let current = originalDisclosure(id);
  for (const row of history) {
    if (disclosureDigest(row.before) !== disclosureDigest(current)) throw new Error('TECHNICAL_DISCLOSURE_INTEGRITY');
    current = row.after;
  }
  return { current, history, version: disclosureDigest(current) };
}
export async function hasRestrictedDocumentBinding(db: Pick<DisclosureDb, 'contract' | 'payment' | 'practiceFormalization'>, id: string) {
  const [contract, payment, formalization] = await Promise.all([
    db.contract.findFirst({ where: { signedDocumentId: id }, select: { id: true } }),
    db.payment.findFirst({ where: { accountingDocumentId: id }, select: { id: true } }),
    db.practiceFormalization.findFirst({ where: { signedDocumentId: id }, select: { id: true } }),
  ]);
  return !!(contract || payment || formalization);
}
/** A classification is necessary, never a grant. Every caller still checks
 * current recipient, record scope, version selection, revocation and expiry. */
export async function technicalVersionDisclosureAllowed(db: DisclosureDb, actor: TechnicalConfidentialityActor,
  document: Document, version: DocumentVersion) {
  if (!isTechnicalAccount(actor)) return true;
  if (document.deletedAt || document.status === 'archiviato' || document.status === 'respinto'
    || document.status === 'scaduto' || version.documentId !== document.id || !version.checksum
    || restrictedDocumentMetadata(document) || await hasRestrictedDocumentBinding(db, document.id)) return false;
  const state = await readDisclosure(db, version.id);
  return state.current.classification === 'TECHNICAL_CONTENT'
    && state.current.sourceSha256 === disclosureSource(document, version)
    && state.current.contentSha256 === version.checksum && !!state.current.assertions;
}
export async function technicalCurrentDocumentAllowed(db: DisclosureDb, actor: TechnicalConfidentialityActor, document: Document) {
  if (!isTechnicalAccount(actor)) return true;
  const versions = await db.documentVersion.findMany({ where: { documentId: document.id,
    checksum: document.checksum, storagePath: document.storagePath }, orderBy: { version: 'desc' }, take: 1 });
  return !!versions[0] && technicalVersionDisclosureAllowed(db, actor, document, versions[0]);
}
