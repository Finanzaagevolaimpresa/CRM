import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { Prisma } from '@prisma/client';

export const LEAD_NORMALIZATION_VERSION = 'n13-v1' as const;
export const LEAD_IDENTITY_HASH_DOMAIN = 'fai.lead-identity.v1' as const;
export const LEAD_IDENTITY_WRITE_LOCK = 'FAI_LEAD_IDENTITY_WRITE_V1' as const;

export const LEAD_IDENTITY_SIGNAL_KINDS = Object.freeze([
  'EMAIL_EXACT_V1',
  'PHONE_E164_EXACT_V1',
  'PHONE_NATIONAL_EXACT_V1',
  'PERSON_NAME_EXACT_V1',
  'COMPANY_NAME_EXACT_V1',
] as const);

export type LeadIdentitySignalKind = typeof LEAD_IDENTITY_SIGNAL_KINDS[number];
export type LeadIdentitySignalStrength = 'STRONG' | 'WEAK';

export type LeadIdentitySignal = Readonly<{
  kind: LeadIdentitySignalKind;
  strength: LeadIdentitySignalStrength;
  canonicalValue: string;
}>;

export type DigestedLeadIdentitySignal = LeadIdentitySignal & Readonly<{
  identityDigest: string;
}>;

export type LeadIdentityKeyFile = Readonly<{
  version: number;
  secret: Buffer;
  keyDigest: string;
}>;

export type LeadIdentityCandidate = Readonly<{
  leadId: string;
  leadCreatedAt: Date;
  strongestSignal: LeadIdentitySignalStrength;
  strongSignalCount: number;
  weakSignalCount: number;
  matchedSignalCodes: readonly LeadIdentitySignalKind[];
}>;

export const LEAD_IDENTITY_ERROR_CODES = Object.freeze([
  'N13_IDENTITY_KEY_UNAVAILABLE',
  'N13_IDENTITY_KEY_CONSENSUS_FAILURE',
] as const);

export type LeadIdentityErrorCode = typeof LEAD_IDENTITY_ERROR_CODES[number];

export class LeadIdentityError extends Error {
  constructor(readonly code: LeadIdentityErrorCode) {
    super(code);
    this.name = 'LeadIdentityError';
  }
}

const VERSION_PATTERN = /^[1-9][0-9]{0,8}$/u;
const SECRET_BASE64_PATTERN = /^[A-Za-z0-9+/]{43}=$/u;
const E164_PATTERN = /^\+[1-9][0-9]{6,14}$/u;
const NATIONAL_PHONE_PATTERN = /^[0-9]{7,15}$/u;
const PHONE_SEPARATOR_PATTERN = /[ .()\-]/gu;
const WHITESPACE_PATTERN = /\s+/gu;
const MAXIMUM_KEY_FILE_BYTES = 256;
const SIGNAL_ORDER = new Map(
  LEAD_IDENTITY_SIGNAL_KINDS.map((kind, index) => [kind, index]),
);

function identityFail(code: LeadIdentityErrorCode): never {
  throw new LeadIdentityError(code);
}

function normalizedOptionalText(value: string | null | undefined) {
  if (value === null || value === undefined) return null;
  const normalized = value.normalize('NFC').trim().replace(WHITESPACE_PATTERN, ' ').toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

export function normalizeLeadIdentityEmail(value: string | null | undefined) {
  return normalizedOptionalText(value);
}

export function normalizeLeadIdentityPhone(value: string | null | undefined) {
  if (value === null || value === undefined) return null;
  const normalized = value.replace(PHONE_SEPARATOR_PATTERN, '');
  if (E164_PATTERN.test(normalized)) {
    return Object.freeze({
      kind: 'PHONE_E164_EXACT_V1' as const,
      strength: 'STRONG' as const,
      canonicalValue: normalized,
    });
  }
  if (NATIONAL_PHONE_PATTERN.test(normalized)) {
    return Object.freeze({
      kind: 'PHONE_NATIONAL_EXACT_V1' as const,
      strength: 'WEAK' as const,
      canonicalValue: normalized,
    });
  }
  return null;
}

export function normalizeLeadIdentitySignals(input: Readonly<{
  email?: string | null;
  phone?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  companyName?: string | null;
}>): readonly LeadIdentitySignal[] {
  const signals: LeadIdentitySignal[] = [];
  const email = normalizeLeadIdentityEmail(input.email);
  if (email) {
    signals.push(Object.freeze({
      kind: 'EMAIL_EXACT_V1',
      strength: 'STRONG',
      canonicalValue: email,
    }));
  }
  const phone = normalizeLeadIdentityPhone(input.phone);
  if (phone) signals.push(phone);
  const firstName = normalizedOptionalText(input.firstName);
  const lastName = normalizedOptionalText(input.lastName);
  if (firstName && lastName) {
    signals.push(Object.freeze({
      kind: 'PERSON_NAME_EXACT_V1',
      strength: 'WEAK',
      canonicalValue: `${firstName}\n${lastName}`,
    }));
  }
  const companyName = normalizedOptionalText(input.companyName);
  if (companyName) {
    signals.push(Object.freeze({
      kind: 'COMPANY_NAME_EXACT_V1',
      strength: 'WEAK',
      canonicalValue: companyName,
    }));
  }
  return Object.freeze(signals);
}

export function calculateLeadIdentityKeyDigest(secret: Uint8Array) {
  return createHash('sha256').update(secret).digest('hex');
}

export function digestLeadIdentitySignal(
  key: Pick<LeadIdentityKeyFile, 'version' | 'secret'>,
  signal: LeadIdentitySignal,
) {
  const message = [
    LEAD_IDENTITY_HASH_DOMAIN,
    LEAD_NORMALIZATION_VERSION,
    String(key.version),
    signal.kind,
    signal.canonicalValue,
  ].join('\n');
  return createHmac('sha256', key.secret).update(message, 'utf8').digest('hex');
}

export function digestLeadIdentitySignals(
  key: Pick<LeadIdentityKeyFile, 'version' | 'secret'>,
  signals: readonly LeadIdentitySignal[],
): readonly DigestedLeadIdentitySignal[] {
  return Object.freeze(signals.map((signal) => Object.freeze({
    ...signal,
    identityDigest: digestLeadIdentitySignal(key, signal),
  })));
}

function parseLeadIdentityKeyFile(raw: Buffer) {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
  } catch {
    return identityFail('N13_IDENTITY_KEY_UNAVAILABLE');
  }
  const versionFirst = /^\s*\{\s*"version"\s*:\s*([1-9][0-9]{0,8})\s*,\s*"secretBase64"\s*:\s*"([A-Za-z0-9+/]{43}=)"\s*\}\s*$/u.exec(text);
  const secretFirst = /^\s*\{\s*"secretBase64"\s*:\s*"([A-Za-z0-9+/]{43}=)"\s*,\s*"version"\s*:\s*([1-9][0-9]{0,8})\s*\}\s*$/u.exec(text);
  const version = versionFirst?.[1] ?? secretFirst?.[2];
  const secretBase64 = versionFirst?.[2] ?? secretFirst?.[1];
  if (!version || !VERSION_PATTERN.test(version)
    || !secretBase64 || !SECRET_BASE64_PATTERN.test(secretBase64)) {
    return identityFail('N13_IDENTITY_KEY_UNAVAILABLE');
  }
  const secret = Buffer.from(secretBase64, 'base64');
  if (secret.byteLength !== 32 || secret.toString('base64') !== secretBase64) {
    return identityFail('N13_IDENTITY_KEY_UNAVAILABLE');
  }
  return Object.freeze({
    version: Number(version),
    secret,
    keyDigest: calculateLeadIdentityKeyDigest(secret),
  });
}

export async function readLeadIdentityKeyFile(
  path = process.env.LEAD_IDENTITY_KEY_FILE,
  options: { readonly allowedRoot?: string } = {},
): Promise<LeadIdentityKeyFile> {
  if (!path) return identityFail('N13_IDENTITY_KEY_UNAVAILABLE');
  const allowedRoot = resolve(options.allowedRoot ?? '/run/secrets');
  const target = resolve(path);
  if (dirname(target) !== allowedRoot) {
    return identityFail('N13_IDENTITY_KEY_UNAVAILABLE');
  }
  let handle;
  try {
    handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > MAXIMUM_KEY_FILE_BYTES
      || (stat.mode & 0o077) !== 0) {
      return identityFail('N13_IDENTITY_KEY_UNAVAILABLE');
    }
    return parseLeadIdentityKeyFile(await handle.readFile());
  } catch (error) {
    if (error instanceof LeadIdentityError) throw error;
    return identityFail('N13_IDENTITY_KEY_UNAVAILABLE');
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function acquireLeadIdentityWriteLock(tx: Prisma.TransactionClient) {
  await tx.$executeRaw(
    Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${LEAD_IDENTITY_WRITE_LOCK}))`,
  );
}

export async function assertLeadIdentityKeyConsensus(
  tx: Prisma.TransactionClient,
  key: LeadIdentityKeyFile,
) {
  const rows = await tx.$queryRaw<Array<{
    id: string;
    version: number;
    keyDigest: string;
  }>>(Prisma.sql`
    SELECT "id", "version", "keyDigest"
    FROM "LeadIdentityKeyVersion"
    WHERE "normalizationVersion" = ${LEAD_NORMALIZATION_VERSION}
      AND "status" = 'ACTIVE'
      AND "activatedAt" IS NOT NULL
      AND "revokedAt" IS NULL
      AND "retiredAt" IS NULL
    FOR SHARE
  `);
  const active = rows[0];
  if (!active || rows.length !== 1) return identityFail('N13_IDENTITY_KEY_UNAVAILABLE');
  const configuredDigest = Buffer.from(key.keyDigest, 'hex');
  const registeredDigest = Buffer.from(active.keyDigest, 'hex');
  if (active.version !== key.version
    || configuredDigest.length !== 32
    || registeredDigest.length !== 32
    || !timingSafeEqual(configuredDigest, registeredDigest)) {
    return identityFail('N13_IDENTITY_KEY_CONSENSUS_FAILURE');
  }
  return Object.freeze({
    id: active.id,
    version: active.version,
    keyDigest: active.keyDigest,
  });
}

type CandidateLeadRow = Readonly<{
  id: string;
  createdAt: Date;
  firstName: string;
  lastName: string;
  companyName: string | null;
  email: string | null;
  phone: string | null;
}>;

type IdentityCandidateRow = Readonly<{
  leadId: string;
  createdAt: Date;
  signalKind: LeadIdentitySignalKind;
}>;

function signalsForLeadRow(row: CandidateLeadRow) {
  return normalizeLeadIdentitySignals({
    email: row.email,
    phone: row.phone,
    firstName: row.firstName,
    lastName: row.lastName,
    companyName: row.companyName,
  });
}

function orderedSignalCodes(values: ReadonlySet<LeadIdentitySignalKind>) {
  return [...values].sort(
    (left, right) => (SIGNAL_ORDER.get(left) ?? 99) - (SIGNAL_ORDER.get(right) ?? 99),
  );
}

export async function discoverLeadIdentityCandidates(
  tx: Prisma.TransactionClient,
  input: Readonly<{
    identityKeyVersionId: string;
    signals: readonly DigestedLeadIdentitySignal[];
  }>,
): Promise<readonly LeadIdentityCandidate[]> {
  if (input.signals.length === 0) return Object.freeze([]);
  const byKind = new Map(input.signals.map((signal) => [signal.kind, signal]));
  const digestPredicates = input.signals.map((signal) => Prisma.sql`
    (identity_key."signalKind" = ${signal.kind}
      AND identity_key."identityDigest" = ${signal.identityDigest})
  `);
  const identityRows = await tx.$queryRaw<IdentityCandidateRow[]>(Prisma.sql`
    SELECT identity_key."leadId", lead."createdAt", identity_key."signalKind"
    FROM "LeadIdentityKey" identity_key
    JOIN "Lead" lead ON lead."id" = identity_key."leadId"
    WHERE identity_key."normalizationVersion" = ${LEAD_NORMALIZATION_VERSION}
      AND identity_key."identityKeyVersionId" = ${input.identityKeyVersionId}::UUID
      AND identity_key."retiredAt" IS NULL
      AND lead."deletedAt" IS NULL
      AND (${Prisma.join(digestPredicates, ' OR ')})
  `);

  const rawPredicates: Prisma.Sql[] = [];
  for (const signal of input.signals) {
    if (signal.kind === 'EMAIL_EXACT_V1') {
      rawPredicates.push(Prisma.sql`LOWER(BTRIM("email")) = ${signal.canonicalValue}`);
    } else if (signal.kind === 'PHONE_E164_EXACT_V1'
      || signal.kind === 'PHONE_NATIONAL_EXACT_V1') {
      rawPredicates.push(Prisma.sql`
        REGEXP_REPLACE("phone", '[[:space:]().-]', '', 'g') = ${signal.canonicalValue}
      `);
    } else if (signal.kind === 'PERSON_NAME_EXACT_V1') {
      const [firstName, lastName] = signal.canonicalValue.split('\n');
      rawPredicates.push(Prisma.sql`
        LOWER(REGEXP_REPLACE(BTRIM("firstName"), '[[:space:]]+', ' ', 'g')) = ${firstName}
        AND LOWER(REGEXP_REPLACE(BTRIM("lastName"), '[[:space:]]+', ' ', 'g')) = ${lastName}
      `);
    } else if (signal.kind === 'COMPANY_NAME_EXACT_V1') {
      rawPredicates.push(Prisma.sql`
        LOWER(REGEXP_REPLACE(BTRIM("companyName"), '[[:space:]]+', ' ', 'g'))
          = ${signal.canonicalValue}
      `);
    }
  }
  const fallbackRows = await tx.$queryRaw<CandidateLeadRow[]>(Prisma.sql`
    SELECT "id", "createdAt", "firstName", "lastName", "companyName", "email", "phone"
    FROM "Lead"
    WHERE "deletedAt" IS NULL AND (${Prisma.join(rawPredicates, ' OR ')})
  `);

  const matches = new Map<string, {
    createdAt: Date;
    signals: Set<LeadIdentitySignalKind>;
  }>();
  const addMatch = (leadId: string, createdAt: Date, kind: LeadIdentitySignalKind) => {
    const current = matches.get(leadId) ?? { createdAt, signals: new Set() };
    current.signals.add(kind);
    matches.set(leadId, current);
  };
  for (const row of identityRows) {
    if (byKind.has(row.signalKind)) addMatch(row.leadId, row.createdAt, row.signalKind);
  }
  for (const row of fallbackRows) {
    for (const signal of signalsForLeadRow(row)) {
      if (byKind.get(signal.kind)?.canonicalValue === signal.canonicalValue) {
        addMatch(row.id, row.createdAt, signal.kind);
      }
    }
  }

  const candidates = [...matches.entries()].map(([leadId, match]) => {
    const matchedSignalCodes = orderedSignalCodes(match.signals);
    const strongSignalCount = matchedSignalCodes.filter(
      (kind) => byKind.get(kind)?.strength === 'STRONG',
    ).length;
    const weakSignalCount = matchedSignalCodes.length - strongSignalCount;
    return Object.freeze({
      leadId,
      leadCreatedAt: match.createdAt,
      strongestSignal: strongSignalCount > 0 ? 'STRONG' as const : 'WEAK' as const,
      strongSignalCount,
      weakSignalCount,
      matchedSignalCodes: Object.freeze(matchedSignalCodes),
    });
  });
  candidates.sort((left, right) => {
    const strongOrder = Number(right.strongSignalCount > 0) - Number(left.strongSignalCount > 0);
    if (strongOrder !== 0) return strongOrder;
    const countOrder = (right.strongSignalCount + right.weakSignalCount)
      - (left.strongSignalCount + left.weakSignalCount);
    if (countOrder !== 0) return countOrder;
    const timeOrder = left.leadCreatedAt.getTime() - right.leadCreatedAt.getTime();
    return timeOrder !== 0 ? timeOrder : left.leadId.localeCompare(right.leadId);
  });
  return Object.freeze(candidates);
}

export async function hasStrongRawLeadIdentityDuplicate(
  tx: Prisma.TransactionClient,
  input: Readonly<{
    email?: string | null;
    phone?: string | null;
    excludeLeadId?: string;
  }>,
) {
  const predicates: Prisma.Sql[] = [];
  const email = normalizeLeadIdentityEmail(input.email);
  if (email) predicates.push(Prisma.sql`LOWER(BTRIM("email")) = ${email}`);
  const phone = normalizeLeadIdentityPhone(input.phone);
  if (phone?.kind === 'PHONE_E164_EXACT_V1') {
    predicates.push(Prisma.sql`
      REGEXP_REPLACE("phone", '[[:space:]().-]', '', 'g') = ${phone.canonicalValue}
    `);
  }
  if (predicates.length === 0) return false;
  const excluded = input.excludeLeadId
    ? Prisma.sql`AND "id" <> ${input.excludeLeadId}`
    : Prisma.empty;
  const rows = await tx.$queryRaw<Array<{ duplicate: boolean }>>(Prisma.sql`
    SELECT EXISTS (
      SELECT 1 FROM "Lead"
      WHERE "deletedAt" IS NULL
        AND (${Prisma.join(predicates, ' OR ')})
        ${excluded}
    ) AS "duplicate"
  `);
  return rows[0]?.duplicate === true;
}
