import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import type { PrismaClient } from '@prisma/client';
import { assertSyntheticCatalogDatabase } from '../../src/lib/service-catalog-v2-persistence';

type ProvisionDb = Pick<PrismaClient, '$queryRaw' | '$transaction' | 'user' | 'userPermissionOverride'>;

export async function provisionCatalogBrowserFixtures(db: ProvisionDb, password: string | undefined) {
  assert.equal(process.env.CATALOG_BROWSER_SYNTHETIC_CONFIRMED, '1');
  assert.ok(password && password.length >= 24);
  await assertSyntheticCatalogDatabase(db);
  const passwordHash = await bcrypt.hash(password, 12);
  await db.user.createMany({ data: [
    { id: 'catalog-browser-viewer', email: 'catalog-viewer@invalid.test', name: 'Catalogo Sintetico', passwordHash, role: 'backoffice' },
    { id: 'catalog-browser-denied', email: 'catalog-denied@invalid.test', name: 'Catalogo Negato', passwordHash, role: 'consulente' },
  ] });
  await db.userPermissionOverride.create({ data: { userId: 'catalog-browser-denied', permission: 'service.read', allowed: false } });
}
