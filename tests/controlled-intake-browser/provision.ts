import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { assignCommercialLeadInboxItem } from '../../src/lib/commercial-lead-inbox';
import { assertSyntheticCatalogDatabase } from '../../src/lib/service-catalog-v2-persistence';
import { privilegedStepUpKeyDigest } from '../../src/lib/privileged-step-up-token';

const db = new PrismaClient();

async function main() {
  assert.equal(process.env.CONTROLLED_INTAKE_BROWSER_CONFIRMED, '1');
  const password = process.env.CONTROLLED_INTAKE_BROWSER_PASSWORD;
  assert.ok(password && password.length >= 24);
  await assertSyntheticCatalogDatabase(db);
  const passwordHash = await bcrypt.hash(password, 12);
  const stepUpSecret = process.env.PRIVILEGED_STEP_UP_SECRET;
  assert.ok(stepUpSecret && stepUpSecret.length >= 32);
  await db.applicationKeyVersion.create({ data: {
    purpose: 'PRIVILEGED_STEP_UP', version: 1, status: 'ACTIVE', activatedAt: new Date(),
    keyDigest: privilegedStepUpKeyDigest(stepUpSecret),
  } });
  await db.user.createMany({ data: [
    { id: 'controlled-intake-browser-owner', email: 'intake-owner@invalid.test', name: 'Operatore Ingressi', passwordHash, role: 'commerciale' },
    { id: 'controlled-intake-browser-other', email: 'intake-other@invalid.test', name: 'Altro Operatore Ingressi', passwordHash, role: 'commerciale' },
    { id: 'controlled-intake-browser-manager', email: 'intake-manager@invalid.test', name: 'Responsabile Ingressi', passwordHash, role: 'admin' },
    { id: 'controlled-intake-browser-reader', email: 'intake-reader@invalid.test', name: 'Lettore Ingressi', passwordHash, role: 'revisore' },
  ] });
  const linkedProjectionIds = (await db.controlledIntake.findMany({ where: { sourceProjectionLedgerId: { not: null } }, select: { sourceProjectionLedgerId: true } })).flatMap(({ sourceProjectionLedgerId }) => sourceProjectionLedgerId ? [sourceProjectionLedgerId] : []);
  const automatic = await db.commercialLeadInboxItem.findFirst({ where: { originKind: 'BUSINESS_PROJECTION_N13', formCode: '1265', projectionLedgerId: { notIn: linkedProjectionIds }, lead: { deletedAt: null } } });
  if (!automatic?.projectionLedgerId) throw new Error('CONTROLLED_INTAKE_UNLINKED_AUTHENTICATED_FIXTURE_MISSING');
  const managerSessionId = randomUUID();
  await db.internalSession.create({ data: { id: managerSessionId, userId: 'controlled-intake-browser-manager', tokenDigest: Buffer.alloc(32, 11), expiresAt: new Date(Date.now() + 3_600_000) } });
  const automaticItem = await db.commercialLeadInboxItem.findUniqueOrThrow({ where: { leadId: automatic.leadId } });
  await assignCommercialLeadInboxItem(db, { leadId: automatic.leadId, actor: { userId: 'controlled-intake-browser-manager', sessionId: managerSessionId, requireManualAdmin: true }, targetUserId: 'controlled-intake-browser-owner', expectedInboxVersion: automaticItem.version });
  await db.internalSession.update({ where: { id: managerSessionId }, data: { revokedAt: new Date(), revokedReason: 'LOGOUT', revokedByUserId: 'controlled-intake-browser-manager' } });
  const offer = await db.commercialOffer.findFirst({ where: { title: 'Preventivo pertinente' } });
  if (!offer?.leadId) throw new Error('CONTROLLED_INTAKE_OFFER_FIXTURE_MISSING');
  await db.lead.update({ where: { id: offer.leadId }, data: { assignedToId: 'controlled-intake-browser-owner' } });
  await db.commercialOffer.update({ where: { id: offer.id }, data: { createdById: 'controlled-intake-browser-owner' } });
}

void main()
  .catch(() => { process.stderr.write('CONTROLLED_INTAKE_BROWSER_PROVISION_FAILED\n'); process.exitCode = 1; })
  .finally(() => db.$disconnect());
