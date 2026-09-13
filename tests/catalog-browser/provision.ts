import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
const db = new PrismaClient();
const password = process.env.CATALOG_BROWSER_PASSWORD;
async function main() {
  assert.equal(process.env.CATALOG_BROWSER_SYNTHETIC_CONFIRMED, '1'); assert.ok(password && password.length >= 24);
  const passwordHash = await bcrypt.hash(password, 12);
  await db.user.createMany({ data: [
    { id: 'catalog-browser-viewer', email: 'catalog-viewer@invalid.test', name: 'Catalogo Sintetico', passwordHash, role: 'backoffice' },
    { id: 'catalog-browser-denied', email: 'catalog-denied@invalid.test', name: 'Catalogo Negato', passwordHash, role: 'consulente' },
  ] });
  await db.userPermissionOverride.create({ data: { userId: 'catalog-browser-denied', permission: 'service.read', allowed: false } });
}
void main().catch(() => { process.stderr.write('CATALOG_BROWSER_PROVISION_FAILED\n'); process.exitCode = 1; }).finally(() => db.$disconnect());
