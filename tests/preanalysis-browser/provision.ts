import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';

const db = new PrismaClient();
const password = process.env.PREANALYSIS_BROWSER_PASSWORD;
export const ids = { owner: 'preanalysis-browser-owner', foreign: 'preanalysis-browser-foreign', noRead: 'preanalysis-browser-no-read', client: 'preanalysis-browser-client', project: 'preanalysis-browser-project' };

async function main() {
  assert.equal(process.env.PREANALYSIS_BROWSER_SYNTHETIC_CONFIRMED, '1');
  assert.ok(password && password.length >= 24);
  const passwordHash = await bcrypt.hash(password, 12);
  await db.user.createMany({ data: [
    { id: ids.owner, email: 'preanalysis-owner@invalid.test', name: 'Consulente Preanalisi', passwordHash, role: 'consulente' },
    { id: ids.foreign, email: 'preanalysis-foreign@invalid.test', name: 'Consulente Estraneo', passwordHash, role: 'consulente' },
    { id: ids.noRead, email: 'preanalysis-no-read@invalid.test', name: 'Consulente Senza Dossier', passwordHash, role: 'consulente' },
  ] });
  await db.userPermissionOverride.create({ data: { userId: ids.noRead, permission: 'dossier.read', allowed: false } });
  await db.client.create({ data: { id: ids.client, type: 'societa', displayName: 'Cliente Sintetico Preanalisi', consultantId: ids.owner } });
  await db.project.create({ data: { id: ids.project, clientId: ids.client, title: 'Progetto Sintetico Preanalisi', consultantId: ids.noRead } });
  process.stdout.write('{"preanalysisBrowserProvision":"ready"}\n');
}
void main().catch(() => { process.stderr.write('PREANALYSIS_BROWSER_PROVISION_FAILED\n'); process.exitCode = 1; }).finally(() => db.$disconnect());
