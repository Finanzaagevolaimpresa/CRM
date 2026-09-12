import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { AuthSession } from '../../src/lib/auth';
import {
  countAccessibleDashboardDossiers,
  countAccessibleDashboardOffers,
  countAccessibleDashboardPayments,
} from '../../src/lib/dashboard-business-counts';
import { prisma } from '../../src/lib/prisma';
import {
  getCommercialOfferReadAccess,
  getLegacyDossierReadAccess,
  getPaymentReadAccess,
  getPreAnalysisReadAccess,
} from '../../src/lib/read-access';
import {
  assertAiOrchestratorEphemeralDatabaseIdentity,
  assertAiOrchestratorEphemeralDbTestConfiguration,
} from './ai-orchestrator-db-test-guard';

const runDbTests = assertAiOrchestratorEphemeralDbTestConfiguration({
  requested: process.env.RUN_DB_TESTS === '1',
  destructiveConfirmed: process.env.AI_ORCHESTRATOR_DB_TESTS_CONFIRMED === '1',
  databaseUrl: process.env.DATABASE_URL,
  sentinel: process.env.AI_ORCHESTRATOR_DB_TEST_SENTINEL,
  appEnvironment: process.env.APP_ENV,
  nodeEnvironment: process.env.NODE_ENV,
});
const runPrefix = `dashboard-business-${randomUUID()}-`;
const amounts = { taxableAmount: 100, vatAmount: 22, totalAmount: 122 };

function actor(userId: string, role: AuthSession['role']): AuthSession {
  return { userId, role, active: true, permissionOverrides: [], expiresAt: Math.floor(Date.now() / 1000) + 3600 };
}

function rowId(prefix: string, index: number) {
  return `${prefix}${String(index).padStart(4, '0')}`;
}

test.before(async () => {
  if (runDbTests) await assertAiOrchestratorEphemeralDatabaseIdentity(prisma);
});

test.after(async () => {
  await prisma.$disconnect();
});

test('dashboard offers scan multiple pages and reject dangling or inconsistent links even for Admin', { skip: !runDbTests }, async () => {
  const prefix = `${runPrefix}offers-`;
  const owner = actor(`${prefix}owner`, 'commerciale');
  const admin = actor(`${prefix}admin`, 'admin');
  const unrelated = actor(`${prefix}unrelated`, 'commerciale');
  const beforeAdmin = await countAccessibleDashboardOffers(admin);
  const beforeOwner = await countAccessibleDashboardOffers(owner);
  const beforeUnrelated = await countAccessibleDashboardOffers(unrelated);
  const clientA = `${prefix}client-a`;
  const clientB = `${prefix}client-b`;
  const foreignClient = `${prefix}foreign-client`;
  const deletedClient = `${prefix}deleted-client`;
  const leadA = `${prefix}lead-a`;
  const foreignLead = `${prefix}foreign-lead`;
  const deletedLead = `${prefix}deleted-lead`;
  try {
    await prisma.client.createMany({ data: [
      { id: clientA, type: 'societa', displayName: 'Synthetic offer client A', salesOwnerId: owner.userId },
      { id: clientB, type: 'societa', displayName: 'Synthetic offer client B', salesOwnerId: owner.userId },
      { id: foreignClient, type: 'societa', displayName: 'Synthetic foreign offer client', salesOwnerId: `${prefix}other` },
      { id: deletedClient, type: 'societa', displayName: 'Synthetic deleted offer client', salesOwnerId: owner.userId, deletedAt: new Date() },
    ] });
    await prisma.lead.createMany({ data: [
      { id: leadA, firstName: 'Synthetic', lastName: 'Owned lead', assignedToId: owner.userId, clientId: clientA },
      { id: foreignLead, firstName: 'Synthetic', lastName: 'Foreign lead', assignedToId: `${prefix}other`, clientId: foreignClient },
      { id: deletedLead, firstName: 'Synthetic', lastName: 'Deleted lead', assignedToId: owner.userId, clientId: clientA, deletedAt: new Date() },
    ] });
    const base = { ...amounts, title: 'Synthetic offer', createdById: owner.userId };
    const invalid = [
      { ...base, id: `${prefix}missing-lead`, leadId: `${prefix}absent-lead`, clientId: clientA },
      { ...base, id: `${prefix}deleted-lead-offer`, leadId: deletedLead, clientId: clientA },
      { ...base, id: `${prefix}missing-client`, leadId: leadA, clientId: `${prefix}absent-client` },
      { ...base, id: `${prefix}deleted-client-offer`, clientId: deletedClient },
      // Both objects are individually visible, but they do not describe the same client.
      { ...base, id: `${prefix}mismatched-client`, leadId: leadA, clientId: clientB },
      { ...base, id: `${prefix}deleted-offer`, leadId: leadA, clientId: clientA, deletedAt: new Date() },
    ];
    await prisma.commercialOffer.createMany({ data: [
      ...Array.from({ length: 122 }, (_, index) => ({
        ...base, id: rowId(`${prefix}valid-`, index), leadId: leadA, clientId: clientA,
        status: index % 2 === 0 ? 'inviata' as const : 'accettata' as const,
      })),
      ...invalid.map((row) => ({ ...row, status: 'inviata' as const })),
      { ...base, id: `${prefix}foreign`, createdById: `${prefix}other`, leadId: foreignLead, clientId: foreignClient, status: 'accettata' },
      { ...base, id: `${prefix}draft`, leadId: leadA, clientId: clientA, status: 'bozza' },
      { ...base, id: `${prefix}rejected`, leadId: leadA, clientId: clientA, status: 'rifiutata' },
      { ...base, id: `${prefix}expired`, leadId: leadA, clientId: clientA, status: 'scaduta' },
    ] });
    // Unassigned leads may make pre-existing offers visible to any commercial
    // actor. Compare deltas without deleting or assuming away those records.
    assert.deepEqual(await countAccessibleDashboardOffers(owner), {
      sent: beforeOwner.sent + 61, accepted: beforeOwner.accepted + 61,
    });
    assert.deepEqual(await countAccessibleDashboardOffers(admin), {
      sent: beforeAdmin.sent + 61, accepted: beforeAdmin.accepted + 62,
    });
    assert.deepEqual(await countAccessibleDashboardOffers(unrelated), beforeUnrelated);
    for (const row of invalid) {
      assert.equal(await getCommercialOfferReadAccess(admin, row.id), null, row.id);
    }
  } finally {
    await prisma.commercialOffer.deleteMany({ where: { id: { startsWith: prefix } } });
    await prisma.lead.deleteMany({ where: { id: { startsWith: prefix } } });
    await prisma.client.deleteMany({ where: { id: { startsWith: prefix } } });
  }
});

test('dashboard payment totals require matching readable contracts and include every outstanding row', { skip: !runDbTests }, async () => {
  const prefix = `${runPrefix}payments-`;
  const owner = actor(`${prefix}owner`, 'consulente');
  const admin = actor(`${prefix}admin`, 'admin');
  const beforeAdmin = await countAccessibleDashboardPayments(admin);
  const clientA = `${prefix}client-a`;
  const clientB = `${prefix}client-b`;
  const foreignClient = `${prefix}foreign-client`;
  const deletedClient = `${prefix}deleted-client`;
  const projectOnlyClient = `${prefix}project-only-client`;
  try {
    await prisma.client.createMany({ data: [
      { id: clientA, type: 'societa', displayName: 'Synthetic payment A', consultantId: owner.userId },
      { id: clientB, type: 'societa', displayName: 'Synthetic payment B', consultantId: owner.userId },
      { id: foreignClient, type: 'societa', displayName: 'Synthetic foreign payment', consultantId: `${prefix}other` },
      { id: deletedClient, type: 'societa', displayName: 'Synthetic deleted payment', consultantId: owner.userId, deletedAt: new Date() },
      { id: projectOnlyClient, type: 'societa', displayName: 'Synthetic project-only payment' },
    ] });
    await prisma.project.createMany({ data: [
      { id: `${prefix}project-b`, clientId: clientB, title: 'Synthetic project B', consultantId: owner.userId },
      { id: `${prefix}project-only`, clientId: projectOnlyClient, title: 'Synthetic assigned-only project', consultantId: owner.userId },
      { id: `${prefix}deleted-project`, clientId: clientA, title: 'Synthetic deleted project', consultantId: owner.userId, deletedAt: new Date() },
    ] });
    const contracts = [
      { id: `${prefix}contract-a`, clientId: clientA },
      { id: `${prefix}contract-b`, clientId: clientB },
      { id: `${prefix}contract-foreign`, clientId: foreignClient },
      { id: `${prefix}contract-deleted-client`, clientId: deletedClient },
      { id: `${prefix}contract-project-mismatch`, clientId: clientA, projectId: `${prefix}project-b` },
      { id: `${prefix}contract-project-missing`, clientId: clientA, projectId: `${prefix}absent-project` },
      { id: `${prefix}contract-project-deleted`, clientId: clientA, projectId: `${prefix}deleted-project` },
      { id: `${prefix}contract-project-only`, clientId: projectOnlyClient, projectId: `${prefix}project-only` },
    ];
    await prisma.contract.createMany({ data: contracts.map((row) => ({
      ...row, ...amounts, contractNumber: row.id, serviceName: 'Synthetic count service',
    })) });
    const base = { ...amounts, clientId: clientA, contractId: `${prefix}contract-a` };
    const invalid = [
      { ...base, id: `${prefix}missing-contract`, contractId: `${prefix}absent-contract` },
      { ...base, id: `${prefix}mismatched-contract`, contractId: `${prefix}contract-b` },
      { ...base, id: `${prefix}missing-client`, clientId: `${prefix}absent-client` },
      { ...base, id: `${prefix}deleted-client-payment`, clientId: deletedClient, contractId: `${prefix}contract-deleted-client` },
      { ...base, id: `${prefix}mismatched-project`, contractId: `${prefix}contract-project-mismatch` },
      { ...base, id: `${prefix}missing-project`, contractId: `${prefix}contract-project-missing` },
      { ...base, id: `${prefix}deleted-project-payment`, contractId: `${prefix}contract-project-deleted` },
    ];
    const outstanding = ['da_incassare', 'parziale', 'scaduto'] as const;
    await prisma.payment.createMany({ data: [
      ...Array.from({ length: 121 }, (_, index) => ({
        ...base, id: rowId(`${prefix}valid-`, index), status: outstanding[index % outstanding.length],
      })),
      ...invalid.map((row) => ({ ...row, status: 'da_incassare' as const })),
      { ...base, id: `${prefix}project-only-payment`, clientId: projectOnlyClient, contractId: `${prefix}contract-project-only` },
      { ...base, id: `${prefix}foreign`, clientId: foreignClient, contractId: `${prefix}contract-foreign` },
      { ...base, id: `${prefix}collected`, status: 'incassato' },
      { ...base, id: `${prefix}reversed`, status: 'stornato' },
      { ...base, id: `${prefix}refunded`, status: 'rimborsato' },
    ] });
    assert.equal(await countAccessibleDashboardPayments(owner), 121);
    assert.equal(await countAccessibleDashboardPayments(admin), beforeAdmin + 123);
    assert.equal(await countAccessibleDashboardPayments(actor(`${prefix}unrelated`, 'consulente')), 0);
    // Detail access permits the assigned project, but the payment list requires
    // client visibility. Its counter must not expose a row absent from that list.
    assert.ok(await getPaymentReadAccess(owner, `${prefix}project-only-payment`));
    for (const row of invalid) assert.equal(await getPaymentReadAccess(admin, row.id), null, row.id);
  } finally {
    await prisma.payment.deleteMany({ where: { id: { startsWith: prefix } } });
    await prisma.contract.deleteMany({ where: { id: { startsWith: prefix } } });
    await prisma.project.deleteMany({ where: { id: { startsWith: prefix } } });
    await prisma.client.deleteMany({ where: { id: { startsWith: prefix } } });
  }
});

test('dashboard pre-analysis and dossier totals require consistent client, project and source links across pages', { skip: !runDbTests }, async () => {
  const prefix = `${runPrefix}dossiers-`;
  const owner = actor(`${prefix}owner`, 'consulente');
  const admin = actor(`${prefix}admin`, 'admin');
  const beforeAdmin = await countAccessibleDashboardDossiers(admin);
  const clientA = `${prefix}client-a`;
  const clientB = `${prefix}client-b`;
  const foreignClient = `${prefix}foreign-client`;
  const deletedClient = `${prefix}deleted-client`;
  const projectOnlyClient = `${prefix}project-only-client`;
  const projectA = `${prefix}project-a`;
  const projectB = `${prefix}project-b`;
  try {
    await prisma.client.createMany({ data: [
      { id: clientA, type: 'societa', displayName: 'Synthetic dossier A', consultantId: owner.userId },
      { id: clientB, type: 'societa', displayName: 'Synthetic dossier B', consultantId: owner.userId },
      { id: foreignClient, type: 'societa', displayName: 'Synthetic foreign dossier', consultantId: `${prefix}other` },
      { id: deletedClient, type: 'societa', displayName: 'Synthetic deleted dossier', consultantId: owner.userId, deletedAt: new Date() },
      { id: projectOnlyClient, type: 'societa', displayName: 'Synthetic project-only dossier' },
    ] });
    await prisma.project.createMany({ data: [
      { id: projectA, clientId: clientA, title: 'Synthetic project A', consultantId: owner.userId },
      { id: projectB, clientId: clientB, title: 'Synthetic project B', consultantId: owner.userId },
      { id: `${prefix}second-project-a`, clientId: clientA, title: 'Synthetic second project A', consultantId: owner.userId },
      { id: `${prefix}foreign-project`, clientId: foreignClient, title: 'Synthetic foreign project', consultantId: `${prefix}other` },
      { id: `${prefix}deleted-client-project`, clientId: deletedClient, title: 'Synthetic deleted-client project', consultantId: owner.userId },
      { id: `${prefix}deleted-project`, clientId: clientA, title: 'Synthetic deleted project', consultantId: owner.userId, deletedAt: new Date() },
      { id: `${prefix}project-only`, clientId: projectOnlyClient, title: 'Synthetic assigned-only project', consultantId: owner.userId },
    ] });
    await prisma.company.createMany({ data: [
      { id: `${prefix}company-b`, clientId: clientB, name: 'Synthetic other-client company' },
      { id: `${prefix}deleted-company`, clientId: clientA, name: 'Synthetic deleted company', deletedAt: new Date() },
    ] });
    const baseContext = { clientId: clientA, projectId: projectA };
    const invalidContexts = [
      { ...baseContext, id: `${prefix}missing-client`, clientId: `${prefix}absent-client` },
      { ...baseContext, id: `${prefix}missing-project`, projectId: `${prefix}absent-project` },
      { ...baseContext, id: `${prefix}mismatched-project`, projectId: projectB },
      { ...baseContext, id: `${prefix}deleted-client-row`, clientId: deletedClient, projectId: `${prefix}deleted-client-project` },
      { ...baseContext, id: `${prefix}deleted-project-row`, projectId: `${prefix}deleted-project` },
    ];
    const invalidPre = [
      ...invalidContexts.map((row) => ({ ...row, id: `${row.id}-pre` })),
      { ...baseContext, id: `${prefix}missing-company-pre`, companyId: `${prefix}absent-company` },
      { ...baseContext, id: `${prefix}mismatched-company-pre`, companyId: `${prefix}company-b` },
      { ...baseContext, id: `${prefix}deleted-company-pre`, companyId: `${prefix}deleted-company` },
    ];
    await prisma.preAnalysis.createMany({ data: [
      ...Array.from({ length: 121 }, (_, index) => ({
        ...baseContext, id: rowId(`${prefix}valid-pre-`, index),
        status: index % 2 === 0 ? 'bozza_generata' as const : 'da_revisionare' as const,
      })),
      ...invalidPre.map((row) => ({ ...row, status: 'da_revisionare' as const })),
      { id: `${prefix}project-only-pre`, clientId: projectOnlyClient, projectId: `${prefix}project-only`, status: 'da_revisionare' },
      { id: `${prefix}foreign-pre`, clientId: foreignClient, projectId: `${prefix}foreign-project`, status: 'da_revisionare' },
      { ...baseContext, id: `${prefix}other-project-source`, projectId: `${prefix}second-project-a`, status: 'da_avviare' },
      { id: `${prefix}other-client-source`, clientId: clientB, projectId: projectB, status: 'da_avviare' },
      { ...baseContext, id: `${prefix}approved-pre`, status: 'approvata_internamente' },
    ] });
    const baseDossier = { ...baseContext, title: 'Synthetic dossier', type: 'synthetic_test' };
    const invalidDossiers = [
      ...invalidContexts.map((row) => ({ ...baseDossier, ...row, id: `${row.id}-dossier` })),
      { ...baseDossier, id: `${prefix}missing-pre-dossier`, preAnalysisId: `${prefix}absent-pre` },
      { ...baseDossier, id: `${prefix}different-project-pre-dossier`, preAnalysisId: `${prefix}other-project-source` },
      { ...baseDossier, id: `${prefix}different-client-pre-dossier`, preAnalysisId: `${prefix}other-client-source` },
    ];
    const draftStatuses = ['bozza_ai', 'bozza_consulente', 'in_revisione'] as const;
    await prisma.dossier.createMany({ data: [
      ...Array.from({ length: 121 }, (_, index) => ({
        ...baseDossier, id: rowId(`${prefix}valid-dossier-`, index),
        preAnalysisId: index % 2 === 0 ? rowId(`${prefix}valid-pre-`, 0) : null,
        status: draftStatuses[index % draftStatuses.length],
      })),
      ...invalidDossiers.map((row) => ({ ...row, status: 'bozza_ai' as const })),
      { ...baseDossier, id: `${prefix}project-only-dossier`, clientId: projectOnlyClient, projectId: `${prefix}project-only`, preAnalysisId: `${prefix}project-only-pre` },
      { ...baseDossier, id: `${prefix}foreign-dossier`, clientId: foreignClient, projectId: `${prefix}foreign-project`, preAnalysisId: `${prefix}foreign-pre` },
      { ...baseDossier, id: `${prefix}archived-dossier`, status: 'archiviato' },
      { ...baseDossier, id: `${prefix}approved-dossier`, status: 'approvato_internamente' },
    ] });
    assert.deepEqual(await countAccessibleDashboardDossiers(owner), { preReview: 121, draftDossiers: 121 });
    assert.deepEqual(await countAccessibleDashboardDossiers(admin), {
      preReview: beforeAdmin.preReview + 123, draftDossiers: beforeAdmin.draftDossiers + 123,
    });
    assert.deepEqual(await countAccessibleDashboardDossiers(actor(`${prefix}unrelated`, 'consulente')), { preReview: 0, draftDossiers: 0 });
    // These details are individually readable, but the destination lists also
    // require the parent client to be visible. They do not increase list counters.
    assert.ok(await getPreAnalysisReadAccess(owner, `${prefix}project-only-pre`));
    assert.ok(await getLegacyDossierReadAccess(owner, `${prefix}project-only-dossier`));
    for (const row of invalidPre) assert.equal(await getPreAnalysisReadAccess(admin, row.id), null, row.id);
    for (const row of invalidDossiers) assert.equal(await getLegacyDossierReadAccess(admin, row.id), null, row.id);
  } finally {
    await prisma.dossier.deleteMany({ where: { id: { startsWith: prefix } } });
    await prisma.preAnalysis.deleteMany({ where: { id: { startsWith: prefix } } });
    await prisma.company.deleteMany({ where: { id: { startsWith: prefix } } });
    await prisma.project.deleteMany({ where: { id: { startsWith: prefix } } });
    await prisma.client.deleteMany({ where: { id: { startsWith: prefix } } });
  }
});
