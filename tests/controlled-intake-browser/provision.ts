import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { assertSyntheticCatalogDatabase } from '../../src/lib/service-catalog-v2-persistence';

const db = new PrismaClient();

async function main() {
  assert.equal(process.env.CONTROLLED_INTAKE_BROWSER_CONFIRMED, '1');
  const password = process.env.CONTROLLED_INTAKE_BROWSER_PASSWORD;
  assert.ok(password && password.length >= 24);
  await assertSyntheticCatalogDatabase(db);
  const passwordHash = await bcrypt.hash(password, 12);
  await db.user.createMany({ data: [
    { id: 'controlled-intake-browser-owner', email: 'intake-owner@invalid.test', name: 'Operatore Ingressi', passwordHash, role: 'commerciale' },
    { id: 'controlled-intake-browser-other', email: 'intake-other@invalid.test', name: 'Altro Operatore Ingressi', passwordHash, role: 'commerciale' },
    { id: 'controlled-intake-browser-reader', email: 'intake-reader@invalid.test', name: 'Lettore Ingressi', passwordHash, role: 'revisore' },
  ] });
  const linkedProjectionIds = (await db.controlledIntake.findMany({ where: { sourceProjectionLedgerId: { not: null } }, select: { sourceProjectionLedgerId: true } })).flatMap(({ sourceProjectionLedgerId }) => sourceProjectionLedgerId ? [sourceProjectionLedgerId] : []);
  const automatic = await db.commercialLeadInboxItem.findFirst({ where: { originKind: 'BUSINESS_PROJECTION_N13', formCode: '1265', projectionLedgerId: { notIn: linkedProjectionIds } } });
  if (!automatic?.projectionLedgerId) throw new Error('CONTROLLED_INTAKE_UNLINKED_AUTHENTICATED_FIXTURE_MISSING');
  await db.lead.update({ where: { id: automatic.leadId }, data: { assignedToId: 'controlled-intake-browser-owner' } });
  const offer = await db.commercialOffer.findFirst({ where: { title: 'Preventivo pertinente' } });
  if (!offer?.leadId) throw new Error('CONTROLLED_INTAKE_OFFER_FIXTURE_MISSING');
  await db.lead.update({ where: { id: offer.leadId }, data: { assignedToId: 'controlled-intake-browser-owner' } });
  await db.commercialOffer.update({ where: { id: offer.id }, data: { createdById: 'controlled-intake-browser-owner' } });
}

void main()
  .catch(() => { process.stderr.write('CONTROLLED_INTAKE_BROWSER_PROVISION_FAILED\n'); process.exitCode = 1; })
  .finally(() => db.$disconnect());
