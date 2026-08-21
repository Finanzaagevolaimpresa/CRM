import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Prisma } from '@prisma/client';
import { BusinessEventBackboneError } from '../src/lib/business-event-backbone';
import {
  assertLeadIdentityKeyConsensus,
  calculateLeadIdentityKeyDigest,
  digestLeadIdentitySignal,
  digestLeadIdentitySignals,
  discoverLeadIdentityCandidates,
  LeadIdentityError,
  normalizeLeadIdentityEmail,
  normalizeLeadIdentityPhone,
  normalizeLeadIdentitySignals,
  readLeadIdentityKeyFile,
  type LeadIdentityKeyFile,
} from '../src/lib/lead-identity';
import {
  LEAD_PROJECTION_MANIFEST,
  mapLeadSubmittedEventToLead,
  projectClaimedLeadInboxEvent,
} from '../src/lib/lead-projection';
import { createLeadSubmittedEventV1 } from '../src/lib/lead-event-contract';
import { createBusinessLeadPrivacyEvidence } from '../src/lib/privacy-evidence';
import {
  N13_SYNTHETIC_KEY_SECRET,
  N13_SYNTHETIC_KEY_VERSION,
  syntheticN13LeadEvent,
} from './fixtures/n13-lead-projection-v1';
import { syntheticLeadEventInputV1 } from './fixtures/n10-lead-event-v1';

function syntheticIdentityKey(): LeadIdentityKeyFile {
  return Object.freeze({
    version: N13_SYNTHETIC_KEY_VERSION,
    secret: Buffer.from(N13_SYNTHETIC_KEY_SECRET),
    keyDigest: calculateLeadIdentityKeyDigest(N13_SYNTHETIC_KEY_SECRET),
  });
}

test('N13 manifest and release surfaces remain dormant with no consumer or activation', () => {
  assert.equal(LEAD_PROJECTION_MANIFEST.dormant, true);
  assert.equal(LEAD_PROJECTION_MANIFEST.activation, 'NONE');
  assert.deepEqual(LEAD_PROJECTION_MANIFEST.runtimeConsumers, []);
  for (const path of ['.env.example', '.env.production.example', '.env.staging.example']) {
    assert.match(readFileSync(path, 'utf8'), /LEAD_IDENTITY_KEY_FILE=""/u);
  }
  assert.match(readFileSync('.github/workflows/ci.yml', 'utf8'), /LEAD_IDENTITY_KEY_FILE: ""/u);
  const projection = readFileSync('src/lib/lead-projection.ts', 'utf8');
  assert.doesNotMatch(projection, /operational-telemetry|\bfetch\s*\(|\bconsole\.|setInterval|setTimeout/u);
  assert.doesNotMatch(projection, /claimBusinessQueueEvent|heartbeatBusinessQueueLease/u);
  assert.match(
    readFileSync('src/lib/business-event-backbone.ts', 'utf8'),
    /processClaimedBusinessInboxEventInTransaction[\s\S]*completeCurrentBusinessQueueEvent/u,
  );
});

test('projection rejects OUTBOX before reading key material or mutating queue state', async () => {
  await assert.rejects(projectClaimedLeadInboxEvent({} as never, {
    queueKind: 'OUTBOX',
    eventRowId: '00000000-0000-4000-8000-000000000021',
    attemptId: '00000000-0000-4000-8000-000000000022',
    fencingToken: 1n,
    leaseOwnerId: '00000000-0000-4000-8000-000000000023',
    leaseToken: '0'.repeat(64),
  }, { keyFilePath: '' }), (error: unknown) => error instanceof BusinessEventBackboneError
    && error.code === 'BUSINESS_QUEUE_LEASE_STALE');
});

test('N10 to Lead mapping preserves exact fields, precedence, absences and Decimal money', () => {
  const mapped = mapLeadSubmittedEventToLead(syntheticN13LeadEvent());
  assert.deepEqual({
    firstName: mapped.firstName,
    lastName: mapped.lastName,
    companyName: mapped.companyName,
    contactPerson: mapped.contactPerson,
    phone: mapped.phone,
    email: mapped.email,
    source: mapped.source,
    leadSource: mapped.leadSource,
    region: mapped.region,
    province: mapped.province,
    city: mapped.city,
    interest: mapped.interest,
    declaredInvestment: mapped.declaredInvestment,
    requestedAmount: mapped.requestedAmount?.toString(),
    availableBudget: mapped.availableBudget,
    status: mapped.status,
    priority: mapped.priority,
    assignedToId: mapped.assignedToId,
    notes: mapped.notes,
    clientId: mapped.clientId,
    deletedAt: mapped.deletedAt,
  }, {
    firstName: 'Synthetic',
    lastName: 'Lead',
    companyName: 'Synthetic Company',
    contactPerson: null,
    phone: '+393330000010',
    email: 'synthetic.lead@n10.invalid',
    source: 'N10:WORDPRESS:N13_SYNTHETIC_FORM:v1',
    leadSource: 'altro',
    region: 'Synthetic Region',
    province: null,
    city: 'Synthetic City',
    interest: 'Synthetic service request',
    declaredInvestment: null,
    requestedAmount: '50000',
    availableBudget: null,
    status: 'nuovo',
    priority: 'media',
    assignedToId: null,
    notes: 'Synthetic-only N10 contract fixture.',
    clientId: null,
    deletedAt: null,
  });

  const base = syntheticLeadEventInputV1();
  const sparse = createLeadSubmittedEventV1({
    ...base,
    eventId: '00000000-0000-4000-8000-000000000015',
    businessCorrelationId: '00000000-0000-4000-8000-000000000016',
    catalogReference: null,
    payload: { email: 'sparse@n13.invalid' },
  });
  const sparseMapped = mapLeadSubmittedEventToLead(sparse);
  assert.equal(sparseMapped.firstName, '');
  assert.equal(sparseMapped.lastName, '');
  assert.equal(sparseMapped.interest, null);
  assert.equal(sparseMapped.requestedAmount, null);
  assert.equal(sparseMapped.notes, null);
});

test('normalization v1 is exact, Unicode-aware and never guesses provider or country rules', () => {
  assert.equal(
    normalizeLeadIdentityEmail(' Synthetic.User+tag@N13.Invalid '),
    'synthetic.user+tag@n13.invalid',
  );
  assert.deepEqual(normalizeLeadIdentityPhone('+39 (333)-000.0010'), {
    kind: 'PHONE_E164_EXACT_V1',
    strength: 'STRONG',
    canonicalValue: '+393330000010',
  });
  assert.deepEqual(normalizeLeadIdentityPhone('333 000 0010'), {
    kind: 'PHONE_NATIONAL_EXACT_V1',
    strength: 'WEAK',
    canonicalValue: '3330000010',
  });
  assert.equal(normalizeLeadIdentityPhone('333\t000\t0010'), null);
  assert.deepEqual(normalizeLeadIdentityPhone('0039 333 000 0010'), {
    kind: 'PHONE_NATIONAL_EXACT_V1',
    strength: 'WEAK',
    canonicalValue: '00393330000010',
  });
  const signals = normalizeLeadIdentitySignals({
    firstName: '  A\u0300lIce  ',
    lastName: '  EXAMPLE   PERSON ',
    companyName: '  Synthetic   COMPANY  ',
  });
  assert.deepEqual(signals, [
    {
      kind: 'PERSON_NAME_EXACT_V1',
      strength: 'WEAK',
      canonicalValue: 'àlice\nexample person',
    },
    {
      kind: 'COMPANY_NAME_EXACT_V1',
      strength: 'WEAK',
      canonicalValue: 'synthetic company',
    },
  ]);
});

test('identity HMAC binds domain, normalization, key version, kind and canonical value', () => {
  const key = syntheticIdentityKey();
  assert.equal(
    key.keyDigest,
    '630dcd2966c4336691125448bbb25b4ff412a49c732db2c8abc1b8581bd710dd',
  );
  assert.equal(digestLeadIdentitySignal(key, {
    kind: 'EMAIL_EXACT_V1',
    strength: 'STRONG',
    canonicalValue: 'synthetic+tag@n13.invalid',
  }), '7ddf16d5c8a1d1028aae8359bbe01bf3d110102fca4d72adebe829862e8fce9a');
});

test('identity key file is exact, private, file-only and consensus-bound', async () => {
  const root = mkdtempSync(join(tmpdir(), 'n13-identity-key-'));
  const path = join(root, 'lead-identity.json');
  try {
    writeFileSync(path, JSON.stringify({
      version: N13_SYNTHETIC_KEY_VERSION,
      secretBase64: N13_SYNTHETIC_KEY_SECRET.toString('base64'),
    }), { mode: 0o600 });
    const key = await readLeadIdentityKeyFile(path, { allowedRoot: root });
    assert.equal(key.version, N13_SYNTHETIC_KEY_VERSION);
    assert.equal(key.keyDigest, syntheticIdentityKey().keyDigest);
    assert.equal(key.secret.equals(N13_SYNTHETIC_KEY_SECRET), true);

    const consensusTx = {
      $queryRaw: async () => [{
        id: '00000000-0000-4000-8000-000000000017',
        version: key.version,
        keyDigest: key.keyDigest,
      }],
    } as unknown as Prisma.TransactionClient;
    const active = await assertLeadIdentityKeyConsensus(consensusTx, key);
    assert.equal(active.version, key.version);

    const mismatchTx = {
      $queryRaw: async () => [{
        id: '00000000-0000-4000-8000-000000000017',
        version: key.version + 1,
        keyDigest: key.keyDigest,
      }],
    } as unknown as Prisma.TransactionClient;
    await assert.rejects(
      assertLeadIdentityKeyConsensus(mismatchTx, key),
      (error: unknown) => error instanceof LeadIdentityError
        && error.code === 'N13_IDENTITY_KEY_CONSENSUS_FAILURE',
    );

    chmodSync(path, 0o644);
    await assert.rejects(
      readLeadIdentityKeyFile(path, { allowedRoot: root }),
      (error: unknown) => error instanceof LeadIdentityError
        && error.code === 'N13_IDENTITY_KEY_UNAVAILABLE',
    );
    chmodSync(path, 0o600);
    writeFileSync(path, '{"version":7,"secretBase64":"invalid","extra":true}', { mode: 0o600 });
    await assert.rejects(
      readLeadIdentityKeyFile(path, { allowedRoot: root }),
      (error: unknown) => error instanceof LeadIdentityError
        && error.code === 'N13_IDENTITY_KEY_UNAVAILABLE',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  await assert.rejects(
    readLeadIdentityKeyFile(''),
    (error: unknown) => error instanceof LeadIdentityError
      && error.code === 'N13_IDENTITY_KEY_UNAVAILABLE',
  );
});

test('candidate discovery unifies digests and conservative raw fallback with deterministic ranking', async () => {
  const key = syntheticIdentityKey();
  const signals = digestLeadIdentitySignals(key, normalizeLeadIdentitySignals({
    email: 'match@n13.invalid',
    phone: '+39 333 000 0010',
    firstName: 'Synthetic',
    lastName: 'Person',
    companyName: 'Synthetic Company',
  }));
  const responses = [
    [
      {
        leadId: 'lead-b',
        createdAt: new Date('2020-01-01T00:00:00.000Z'),
        signalKind: 'COMPANY_NAME_EXACT_V1',
      },
    ],
    [
      {
        id: 'lead-a',
        createdAt: new Date('2022-01-01T00:00:00.000Z'),
        firstName: 'Other',
        lastName: 'Name',
        companyName: 'Synthetic Company',
        email: 'match@n13.invalid',
        phone: null,
      },
      {
        id: 'lead-c',
        createdAt: new Date('2019-01-01T00:00:00.000Z'),
        firstName: 'Other',
        lastName: 'Name',
        companyName: null,
        email: null,
        phone: '+39 (333) 000-0010',
      },
      {
        id: 'lead-d',
        createdAt: new Date('2018-01-01T00:00:00.000Z'),
        firstName: ' Synthetic ',
        lastName: ' PERSON ',
        companyName: 'Synthetic   Company',
        email: null,
        phone: null,
      },
    ],
  ];
  const tx = {
    $queryRaw: async () => responses.shift() ?? [],
  } as unknown as Prisma.TransactionClient;
  const candidates = await discoverLeadIdentityCandidates(tx, {
    identityKeyVersionId: '00000000-0000-4000-8000-000000000017',
    signals,
  });
  assert.deepEqual(candidates.map((candidate) => candidate.leadId), [
    'lead-a',
    'lead-c',
    'lead-d',
    'lead-b',
  ]);
  assert.deepEqual(candidates.map((candidate) => [
    candidate.strongSignalCount,
    candidate.weakSignalCount,
  ]), [[1, 1], [1, 0], [0, 2], [0, 1]]);
});

test('business privacy evidence creates exactly two inbox-bound receipts without Lead binding', async () => {
  const createdRows: Array<Record<string, unknown>> = [];
  const notices = [
    { id: '00000000-0000-4000-8000-000000000018' },
    { id: '00000000-0000-4000-8000-000000000019' },
  ];
  const tx = {
    privacyNoticeVersion: {
      findFirst: async () => notices.shift() ?? null,
    },
    privacyEvidenceReceipt: {
      createMany: async ({ data }: { data: Array<Record<string, unknown>> }) => {
        createdRows.push(...data);
        return { count: data.length };
      },
    },
  } as unknown as Prisma.TransactionClient;
  const event = syntheticN13LeadEvent();
  const result = await createBusinessLeadPrivacyEvidence(tx, {
    businessInboxEventId: '00000000-0000-4000-8000-000000000020',
    event,
  });
  assert.equal(result.count, 2);
  assert.deepEqual(createdRows.map((row) => ({
    leadId: row.leadId,
    websiteLeadReceiptId: row.websiteLeadReceiptId,
    businessInboxEventId: row.businessInboxEventId,
    decision: row.decision,
  })), [
    {
      leadId: null,
      websiteLeadReceiptId: null,
      businessInboxEventId: '00000000-0000-4000-8000-000000000020',
      decision: 'ACKNOWLEDGED',
    },
    {
      leadId: null,
      websiteLeadReceiptId: null,
      businessInboxEventId: '00000000-0000-4000-8000-000000000020',
      decision: 'DENIED',
    },
  ]);
});
