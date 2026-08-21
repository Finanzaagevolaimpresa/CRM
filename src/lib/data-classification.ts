export const DATA_CLASSIFICATION_CATALOG_VERSION = 'n04-v1' as const;

export type DataClassification =
  | 'PUBLIC'
  | 'INTERNAL'
  | 'CONFIDENTIAL'
  | 'PERSONAL'
  | 'SPECIAL_CATEGORY'
  | 'FINANCIAL'
  | 'AUTHENTICATION_SECRET';

export type DataFieldRule = Readonly<{
  classification: DataClassification;
  purposeCode: string;
  legalBasisCode: string;
}>;

const rule = (
  classification: DataClassification,
  purposeCode: string,
  legalBasisCode: string,
): DataFieldRule => Object.freeze({ classification, purposeCode, legalBasisCode });

const contact = rule('PERSONAL', 'SERVICE_REQUEST_FOLLOW_UP', 'PRE_CONTRACTUAL_MEASURES');
const privacyAcknowledgement = rule('PERSONAL', 'SERVICE_REQUEST_FOLLOW_UP', 'PRE_CONTRACTUAL_MEASURES');
const marketingChoice = rule('PERSONAL', 'DIRECT_MARKETING', 'CONSENT');
const personalIdentifier = rule('PERSONAL', 'CRM_OPERATIONS', 'LEGITIMATE_INTEREST');
const privacyEvidence = rule('PERSONAL', 'PRIVACY_ACCOUNTABILITY', 'DPO_VALIDATION_REQUIRED');
const business = rule('CONFIDENTIAL', 'SERVICE_REQUEST_QUALIFICATION', 'PRE_CONTRACTUAL_MEASURES');
const operational = rule('INTERNAL', 'CRM_OPERATIONS', 'LEGITIMATE_INTEREST');
const security = rule('AUTHENTICATION_SECRET', 'SECURITY_CONTROL', 'LEGITIMATE_INTEREST');
const gatewayReceipt = rule('PERSONAL', 'SECURITY_CONTROL', 'LEGITIMATE_INTEREST');
const aiProfile = rule('CONFIDENTIAL', 'CLIENT_ADVISORY_DRAFT', 'CONTRACT_PERFORMANCE');
const aiFinancial = rule('FINANCIAL', 'CLIENT_ADVISORY_DRAFT', 'CONTRACT_PERFORMANCE');

export const dataClassificationCatalog = Object.freeze({
  website_lead_intake_v2: Object.freeze({
    firstName: contact,
    lastName: contact,
    companyName: business,
    email: contact,
    phone: contact,
    city: contact,
    region: contact,
    interest: business,
    requestedAmount: rule('FINANCIAL', 'SERVICE_REQUEST_QUALIFICATION', 'PRE_CONTRACTUAL_MEASURES'),
    message: contact,
    sourcePage: operational,
    serviceInterest: business,
    sourceSystem: operational,
    formCode: operational,
    formVersion: operational,
    privacyAccepted: privacyAcknowledgement,
    privacyNoticeCode: operational,
    privacyNoticeVersion: operational,
    privacyPurposeCode: operational,
    privacyLegalBasisCode: operational,
    marketingAccepted: marketingChoice,
    marketingNoticeCode: operational,
    marketingNoticeVersion: operational,
    marketingPurposeCode: operational,
    marketingLegalBasisCode: operational,
    submittedAt: operational,
  }),
  lead_business_event_v1: Object.freeze({
    schemaVersion: operational,
    eventType: operational,
    eventVersion: operational,
    eventId: contact,
    businessCorrelationId: contact,
    occurredAt: contact,
    'source.systemCode': operational,
    'source.formCode': operational,
    'source.formVersion': operational,
    'source.submissionId': contact,
    'privacy.service.noticeCode': operational,
    'privacy.service.noticeVersion': operational,
    'privacy.service.purposeCode': operational,
    'privacy.service.legalBasisCode': operational,
    'privacy.service.evidenceKind': operational,
    'privacy.service.decision': privacyAcknowledgement,
    'privacy.marketing.noticeCode': operational,
    'privacy.marketing.noticeVersion': operational,
    'privacy.marketing.purposeCode': operational,
    'privacy.marketing.legalBasisCode': operational,
    'privacy.marketing.evidenceKind': operational,
    'privacy.marketing.decision': marketingChoice,
    'catalogReference.catalogVersion': business,
    'catalogReference.serviceCode': business,
    'catalogReference.serviceVersion': business,
    'payload.firstName': contact,
    'payload.lastName': contact,
    'payload.companyName': business,
    'payload.email': contact,
    'payload.phone': contact,
    'payload.city': contact,
    'payload.region': contact,
    'payload.interestText': business,
    'payload.serviceInterestText': business,
    'payload.message': contact,
    'payload.sourcePagePath': operational,
    'payload.requestedAmount.currency': rule(
      'FINANCIAL',
      'SERVICE_REQUEST_QUALIFICATION',
      'PRE_CONTRACTUAL_MEASURES',
    ),
    'payload.requestedAmount.minorUnits': rule(
      'FINANCIAL',
      'SERVICE_REQUEST_QUALIFICATION',
      'PRE_CONTRACTUAL_MEASURES',
    ),
    'idempotency.canonicalizationVersion': operational,
    'idempotency.keyDigest': privacyEvidence,
    'idempotency.payloadHash': privacyEvidence,
  }),
  secure_lead_gateway_security_state_v2: Object.freeze({
    producerCode: operational,
    keyVersionId: security,
    keyId: security,
    keyVersion: operational,
    secretDigest: security,
    nonceDigest: security,
    requestFingerprint: security,
    receiptId: gatewayReceipt,
    inboxEventId: gatewayReceipt,
    theoreticalArrivalAt: operational,
    receiptVersion: operational,
    retentionClass: operational,
    retentionPolicyVersion: operational,
    retentionEligibleAt: privacyEvidence,
    createdAt: privacyEvidence,
  }),
  crm_lead_v1: Object.freeze({
    id: personalIdentifier,
    firstName: contact,
    lastName: contact,
    companyName: business,
    contactPerson: contact,
    phone: contact,
    email: contact,
    source: operational,
    leadSource: operational,
    region: contact,
    province: contact,
    city: contact,
    interest: business,
    declaredInvestment: rule('FINANCIAL', 'SERVICE_REQUEST_QUALIFICATION', 'PRE_CONTRACTUAL_MEASURES'),
    requestedAmount: rule('FINANCIAL', 'SERVICE_REQUEST_QUALIFICATION', 'PRE_CONTRACTUAL_MEASURES'),
    availableBudget: rule('FINANCIAL', 'SERVICE_REQUEST_QUALIFICATION', 'PRE_CONTRACTUAL_MEASURES'),
    status: operational,
    priority: operational,
    commercialStatus: operational,
    assignedToId: personalIdentifier,
    nextAction: operational,
    nextActionNote: contact,
    nextActionDate: operational,
    notes: contact,
    commercialProposal: business,
    clientId: personalIdentifier,
    createdAt: operational,
    updatedAt: operational,
    deletedAt: operational,
  }),
  privacy_notice_version_v1: Object.freeze({
    id: operational,
    noticeCode: operational,
    noticeVersion: operational,
    purposeCode: operational,
    legalBasisCode: operational,
    evidenceKind: operational,
    contentHash: operational,
    status: operational,
    effectiveFrom: operational,
    retiredAt: operational,
    createdAt: operational,
  }),
  privacy_evidence_receipt_v1: Object.freeze({
    id: privacyEvidence,
    leadId: privacyEvidence,
    websiteLeadReceiptId: privacyEvidence,
    noticeVersionId: operational,
    catalogVersion: operational,
    purposeCode: operational,
    legalBasisCode: operational,
    evidenceKind: operational,
    decision: privacyEvidence,
    sourceSystem: operational,
    formCode: operational,
    formVersion: operational,
    sourceSubmittedAt: privacyEvidence,
    sourceEvidenceDigest: privacyEvidence,
    evidenceHash: privacyEvidence,
    createdAt: privacyEvidence,
  }),
  ai_execution_request_v1: Object.freeze({
    origin: operational,
    requesterKind: operational,
    requesterUserId: personalIdentifier,
    requesterIdentity: rule('PERSONAL', 'AI_AUTHORIZATION', 'CONTRACT_PERFORMANCE'),
    clientId: personalIdentifier,
    companyId: personalIdentifier,
    projectId: personalIdentifier,
    clientServiceId: personalIdentifier,
    functionCode: operational,
    agentId: operational,
    agentConfigVersion: operational,
    provider: operational,
    model: operational,
    purposeCode: operational,
    dataCategories: operational,
    correlationId: operational,
    idempotencyKey: security,
    inputFingerprint: security,
    executionInputHash: security,
    hashCanonicalizationVersion: operational,
    expiresAt: operational,
    status: operational,
  }),
  external_ai_payload_v1: Object.freeze({
    source: operational,
    humanReviewRequired: operational,
    operationalInstructions: aiProfile,
    context: aiProfile,
    'context.client': aiProfile,
    'context.client.type': aiProfile,
    'context.client.status': aiProfile,
    'context.companies': aiProfile,
    'context.companies[]': aiProfile,
    'context.companies[].annualRevenue': aiFinancial,
    'context.companies[].legalForm': aiProfile,
    'context.companies[].atecoCode': aiProfile,
    'context.companies[].region': aiProfile,
    'context.companies[].employees': aiProfile,
    'context.companies[].durcStatus': aiProfile,
    'context.service': aiProfile,
    'context.service.label': aiProfile,
    'context.service.practiceType': aiProfile,
    'context.service.status': aiProfile,
    'context.service.operationalStatus': aiProfile,
    'context.service.requestedAmount': aiFinancial,
    'context.service.plannedInvestment': aiFinancial,
    'context.project': aiProfile,
    'context.project.requestedAmount': aiFinancial,
    'context.project.totalInvestment': aiFinancial,
    'context.project.status': aiProfile,
    'context.project.priority': aiProfile,
    'context.project.startTiming': aiProfile,
    'context.project.region': aiProfile,
    'context.project.sector': aiProfile,
    'context.checklist': aiProfile,
    'context.checklist[]': aiProfile,
    'context.checklist[].title': aiProfile,
    'context.checklist[].status': aiProfile,
    'context.checklist[].hasLinkedDocument': aiProfile,
    'context.documents': aiProfile,
    'context.documents[]': aiProfile,
    'context.documents[].documentCategory': aiProfile,
    'context.documents[].status': aiProfile,
    'context.documents[].serviceArea': aiProfile,
    'context.tasks': aiProfile,
    'context.tasks[]': aiProfile,
    'context.tasks[].status': aiProfile,
    'context.tasks[].priority': aiProfile,
  }),
});

export type DataContractCode = keyof typeof dataClassificationCatalog;

export class UnclassifiedDataFieldError extends Error {
  constructor(readonly contractCode: DataContractCode, readonly fieldPath: string) {
    super(`Unclassified field denied: ${contractCode}.${fieldPath}`);
    this.name = 'UnclassifiedDataFieldError';
  }
}

function fieldIsKnown(catalog: Readonly<Record<string, DataFieldRule>>, path: string) {
  return Object.hasOwn(catalog, path)
    || Object.keys(catalog).some((known) => known.startsWith(`${path}.`) || known.startsWith(`${path}[]`));
}

function inspectFields(
  contractCode: DataContractCode,
  catalog: Readonly<Record<string, DataFieldRule>>,
  value: unknown,
  path = '',
) {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    const arrayPath = `${path}[]`;
    if (!fieldIsKnown(catalog, arrayPath)) throw new UnclassifiedDataFieldError(contractCode, arrayPath);
    for (const item of value) inspectFields(contractCode, catalog, item, arrayPath);
    return;
  }
  if (typeof value !== 'object') {
    if (!Object.hasOwn(catalog, path)) throw new UnclassifiedDataFieldError(contractCode, path);
    return;
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    const nestedPath = path ? `${path}.${key}` : key;
    if (!fieldIsKnown(catalog, nestedPath)) throw new UnclassifiedDataFieldError(contractCode, nestedPath);
    inspectFields(contractCode, catalog, nested, nestedPath);
  }
}

export function assertClassifiedFields(contractCode: DataContractCode, value: unknown) {
  const catalog = dataClassificationCatalog[contractCode] as Readonly<Record<string, DataFieldRule>>;
  inspectFields(contractCode, catalog, value);
}

export function classifyDataField(contractCode: DataContractCode, fieldPath: string): DataFieldRule {
  const catalog = dataClassificationCatalog[contractCode] as Readonly<Record<string, DataFieldRule>>;
  const classification = catalog[fieldPath];
  if (!classification) throw new UnclassifiedDataFieldError(contractCode, fieldPath);
  return classification;
}

const directIdentifierPattern = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b|\b[A-Z]{6}\d{2}[A-Z]\d{2}[A-Z]\d{3}[A-Z]\b|\bIT\d{2}[A-Z]\d{10}[0-9A-Z]{12}\b/gi;
const internationalPhonePattern = /\+\d(?:[\s().-]*\d){7,14}/g;
const domesticMobilePhonePattern = /\b3\d{2}(?:[\s().-]*\d){6,7}\b/g;
const domesticLandlinePhonePattern = /\b0\d{1,4}(?:[\s().-]*\d){5,8}\b/g;
const labeledSensitiveTextPattern = /\b(?:phone|telefono|cellulare|password|token|secret|authorization|prompt|instruction)\s*[:=]\s*[^,;\n]{1,500}/gi;
const credentialPattern = /\bbearer\s+[A-Za-z0-9._-]{16,}\b|\b[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/gi;
const sensitiveAuditKeyPattern = /(?:email|phone|telephone|first.?name|last.?name|display.?name|company.?name|contact.?person|tax.?code|vat.?number|address|city|province|region|description|message|content|prompt|instruction|secret|password|token|authorization|cookie|credential|api.?key|private.?key|storage.?path|file.?name|ip.?address)/i;
const exactOrSuffixSensitiveAuditKeyPattern = /^(?:pec|pec.?address)$|notes?$/i;
const exactSafeAuditKeyPattern = /^(?:before|after|id|receipt|mode|outcome|format|type|role|priority|provider|model|purpose|origin|source|sequence|replay|replayed|reason|action|permission|requiredPermissions|permissionDecisions|overrides|removedOverrides|dataCategories|changedPaths|contentChanged|sizeBytes|enabled|allowed|confirmed|active|code|version|hash|fingerprint|count|status|state|kind|cycle|key|started|expired|bytes|paths|changed)$/i;
const safeAuditSuffixKeyPattern = /(?:Id|Code|Version|Hash|Fingerprint|Count|Status|At|Type|Role|Priority|Provider|Model|Purpose|State|Mode|Kind|Sequence|Cycle|Key|Enabled|Allowed|Confirmed|Active|Started|Expired|Replayed|Bytes|Paths|Changed)$/;

export function redactTechnicalText(value: string) {
  return value
    .replace(directIdentifierPattern, '[REDACTED:PERSONAL]')
    .replace(internationalPhonePattern, '[REDACTED:PERSONAL]')
    .replace(domesticMobilePhonePattern, '[REDACTED:PERSONAL]')
    .replace(domesticLandlinePhonePattern, '[REDACTED:PERSONAL]')
    .replace(labeledSensitiveTextPattern, '[REDACTED:SENSITIVE]')
    .replace(credentialPattern, '[REDACTED:SECRET]')
    .slice(0, 4096);
}

export function redactAuditPayload(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactTechnicalText(value);
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 100).map(redactAuditPayload);

  const redacted: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (sensitiveAuditKeyPattern.test(key) || exactOrSuffixSensitiveAuditKeyPattern.test(key)) continue;
    if (!exactSafeAuditKeyPattern.test(key) && !safeAuditSuffixKeyPattern.test(key)) continue;
    redacted[key] = redactAuditPayload(nested);
  }
  return redacted;
}
