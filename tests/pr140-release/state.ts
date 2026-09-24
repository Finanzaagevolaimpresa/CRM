import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { assertSyntheticCatalogDatabase, CatalogV2PreparationError, prepareInternalServiceCatalogV2 } from '../../src/lib/service-catalog-v2-persistence';
import { createControlledIntake, ControlledIntakeError } from '../../src/lib/controlled-intake';
import { createPracticeReadiness, PracticeReadinessError } from '../../src/lib/practice-readiness';
import { purchasedFixture } from '../purchased-service-fixture';
import { handoffPurchasedService } from '../../src/lib/purchased-service-handoff';
import { acceptResponsibility } from '../../src/lib/responsibility';
import { recordCommercialOrigin } from '../../src/lib/commercial-origin';

const db = new PrismaClient();
const mode = process.argv[2];
async function main() {
  await assertSyntheticCatalogDatabase(db);
  assert.equal(process.env.CI, 'true');
  if (mode === 'actors') {
    const password = process.env.PRACTICE_READINESS_BROWSER_PASSWORD!;
    assert.ok(password.length >= 24);
    const passwordHash = await bcrypt.hash(password, 12);
    for (const [id, role] of [['release-owner', 'admin'], ['release-observer', 'revisore']] as const)
      await db.user.create({ data: { id, email: `${id}@invalid.test`, name: id, role, passwordHash } });
    assert.equal(await db.internalSession.count(), 0);
  } else if (mode === 'm1-history') {
    assert.equal(process.env.INTERNAL_SESSION_MODE, 'registry');
    const password = process.env.PRACTICE_READINESS_BROWSER_PASSWORD!;
    assert.ok(password.length >= 24);
    const f = await purchasedFixture(db, await bcrypt.hash(password, 12));
    const origin = await db.$transaction(tx => recordCommercialOrigin(tx, f.admin, { clientId: f.client.id,
      expectedEntryId: '', acquiredById: f.admin.id, contractedById: f.admin.id,
      sourceReference: 'Synthetic recovery fixture', reason: 'Preserve the independently recorded commercial origin' }, true));
    const entry = await db.$transaction(tx => handoffPurchasedService(tx, f.admin, f.input, true), { isolationLevel: 'Serializable' });
    const accepted = await db.$transaction(tx => acceptResponsibility(tx, f.tech, { kind: 'TechnicalPractice',
      id: entry.receipt.technicalPracticeId, decisionId: entry.receipt.decisionId, role: 'tecnico' }), { isolationLevel: 'Serializable' });
    writeFileSync(process.argv[3], JSON.stringify({ synthetic: true, clientId: f.client.id, serviceId: f.service.id,
      practiceId: entry.receipt.technicalPracticeId, handoffId: entry.id, acceptanceId: accepted.id, originId: origin.id,
      tech: { id: f.tech.id, email: f.tech.email }, otherEmail: f.other.email,
      materialId: f.documents[2].id, materialHash: f.documents[2].checksum, sensitiveId: f.documents[0].id }) + '\n');
  } else if (mode === 'footprint') {
    const data = {
      clientReadGrants: await db.clientReadGrant.findMany({ orderBy: { id: 'asc' } }),
      m1History: await db.auditLog.findMany({ where: { event: { in: ['purchased_service_handoff', 'responsibility_assigned',
        'responsibility_accepted', 'client_commercial_origin_recorded', 'client_commercial_origin_corrected'] } }, orderBy: { id: 'asc' } }),
      services: await db.clientService.findMany({ orderBy: { id: 'asc' } }),
      technicalPractices: await db.technicalPractice.findMany({ orderBy: { id: 'asc' } }),
      tasks: await db.task.findMany({ orderBy: { id: 'asc' } }),
      documentVersions: await db.documentVersion.findMany({ orderBy: { id: 'asc' } }),
      dossiers: await db.clientDossier.findMany({ where: { practiceReadinessId: { not: null } }, orderBy: { id: 'asc' } }),
      versions: await db.engagementDossierVersion.findMany({ orderBy: { id: 'asc' } }),
      reviews: await db.engagementDossierReview.findMany({ orderBy: { id: 'asc' } }),
      exports: await db.engagementDossierExport.findMany({ orderBy: { id: 'asc' } }),
      authorizations: await db.engagementDossierDeliveryAuthorization.findMany({ orderBy: { id: 'asc' } }),
      receipts: await db.engagementDossierDeliveryReceipt.findMany({ orderBy: { id: 'asc' } }),
      practices: await db.practiceReadiness.findMany({ orderBy: { id: 'asc' } }),
      materials: await db.practiceMaterialEvidence.findMany({ orderBy: { id: 'asc' } }),
      ledger: await db.$queryRaw<Array<{ migration_name: string; checksum: string }>>`SELECT migration_name,checksum FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name`,
    };
    assert.ok(data.dossiers.length >= 3 && data.versions.length >= 3 && data.reviews.length >= 3);
    assert.ok(data.exports.length >= 3 && data.authorizations.length >= 3 && data.receipts.length >= 3);
    assert.equal(data.ledger.length, 48);
    assert.ok(data.clientReadGrants.length >= 3);
    assert.ok(data.m1History.some(row => row.event === 'purchased_service_handoff'));
    assert.ok(data.m1History.some(row => row.event === 'responsibility_accepted'));
    const minimized = Object.fromEntries(Object.entries(data).map(([key, rows]) => [key, {
      count: rows.length, sha256: createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
    }]));
    writeFileSync(process.argv[3], JSON.stringify(minimized, null, 2) + '\n');
  } else if (mode === 'revoke-sessions') {
    // An explicitly authorized operation only in this sentinel-bound CI database.
    // Production must separately authorize revocation; rows and references remain.
    const before = await db.internalSession.count();
    const live = await db.internalSession.count({ where: { revokedAt: null, expiresAt: { gt: new Date() } } });
    assert.ok(live > 0);
    const result = await db.internalSession.updateMany({ where: { revokedAt: null, expiresAt: { gt: new Date() } },
      data: { revokedAt: new Date(), revokedReason: 'INTERNAL_GLOBAL', revokedByUserId: 'release-owner' } });
    assert.equal(await db.internalSession.count(), before);
    process.stdout.write(JSON.stringify({ synthetic: true, liveBefore: live, revoked: result.count, rowsPreserved: before }) + '\n');
  } else if (mode === 'admission') {
    const envKeys = ['INTERNAL_ENGAGEMENT_MODE', 'INTERNAL_SESSION_MODE', 'PRACTICE_READINESS_MODE', 'CONTROLLED_INTAKE_MODE'] as const;
    const previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
    const sessionId = randomUUID();
    await db.internalSession.create({ data: { id: sessionId, userId: 'release-owner', tokenDigest: randomBytes(32), expiresAt: new Date(Date.now() + 600_000) } });
    const actor = { userId: 'release-owner', sessionId, expiresAt: Math.floor(Date.now() / 1000) + 600, role: 'admin' as const, active: true, permissionOverrides: [] };
    const before = await db.serviceCatalogRevision.count();
    const denied = (e: unknown) => e instanceof CatalogV2PreparationError && e.message === 'INTERNAL_CATALOG_PREPARATION_DENIED';
    try {
      process.env.PRACTICE_READINESS_MODE = 'internal';
      process.env.CONTROLLED_INTAKE_MODE = 'internal';
      process.env.INTERNAL_SESSION_MODE = 'registry';
      delete process.env.INTERNAL_ENGAGEMENT_MODE;
      await assert.rejects(createPracticeReadiness(db, actor, {}), (e: unknown) => e instanceof PracticeReadinessError && e.code === 'DISABLED');
      await assert.rejects(createControlledIntake(db, actor, {}), (e: unknown) => e instanceof ControlledIntakeError && e.code === 'DISABLED');
      await assert.rejects(prepareInternalServiceCatalogV2(db, actor), denied);
      process.env.INTERNAL_ENGAGEMENT_MODE = 'controlled';
      process.env.INTERNAL_SESSION_MODE = 'legacy';
      await assert.rejects(createPracticeReadiness(db, actor, {}), (e: unknown) => e instanceof PracticeReadinessError && e.code === 'DISABLED');
      await assert.rejects(createControlledIntake(db, actor, {}), (e: unknown) => e instanceof ControlledIntakeError && e.code === 'DISABLED');
      process.env.INTERNAL_SESSION_MODE = 'registry';
      assert.equal((await prepareInternalServiceCatalogV2(db, actor)).created, 0);
      assert.equal(await db.serviceCatalogRevision.count(), before);
      await db.user.update({ where: { id: actor.userId }, data: { role: 'revisore' } });
      await assert.rejects(prepareInternalServiceCatalogV2(db, actor), denied);
      // Admin has unconditional application permissions by policy. Test an
      // override on direzione while the claimed snapshot still says admin.
      await db.user.update({ where: { id: actor.userId }, data: { role: 'direzione' } });
      assert.equal((await prepareInternalServiceCatalogV2(db, actor)).created, 0);
      const override = await db.userPermissionOverride.create({ data: { userId: actor.userId, permission: 'service.write', allowed: false } });
      await assert.rejects(prepareInternalServiceCatalogV2(db, actor), denied);
      await db.userPermissionOverride.delete({ where: { id: override.id } });
      await db.internalSession.update({ where: { id: sessionId }, data: { revokedAt: new Date(), revokedReason: 'INTERNAL_SINGLE', revokedByUserId: 'release-owner' } });
      await assert.rejects(prepareInternalServiceCatalogV2(db, actor), denied);
      assert.equal(await db.serviceCatalogRevision.count(), before);
      process.stdout.write(JSON.stringify({ synthetic: true, defaultOff: true, legacyDenied: true, canonicalRole: true, permissionRevocation: true, sessionRevocation: true, catalogIdempotent: true }) + '\n');
    } finally {
      await db.user.update({ where: { id: actor.userId }, data: { role: 'admin' } });
      for (const key of envKeys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    }
  } else throw new Error('Unknown guarded fixture phase');
}
void main().finally(() => db.$disconnect());
