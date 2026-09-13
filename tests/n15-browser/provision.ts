import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { privilegedStepUpKeyDigest } from '../../src/lib/privileged-step-up-token';
import { initializeCommercialLeadInboxItem } from '../../src/lib/commercial-lead-inbox';
import { logoutInternalSession } from '../../src/lib/internal-session-registry';
import { createRegistrySessionToken, digestRegistrySessionToken } from '../../src/lib/session';
import { N15_BROWSER_IDENTITIES } from './fixture-identities';
import { writeProvisionFailureReceipt } from './provision-diagnostic';

const db = new PrismaClient();
const password = process.env.N15_BROWSER_PASSWORD;
const stepUpSecret = process.env.PRIVILEGED_STEP_UP_SECRET;
const commercialSessionId = '00000000-0000-4000-8000-000000150301';
const { manager, assignee, foreign } = N15_BROWSER_IDENTITIES;

async function main() {
  assert.equal(process.env.N15_BROWSER_SYNTHETIC_CONFIRMED, '1');
  assert.ok(password && password.length >= 24);
  assert.ok(stepUpSecret && stepUpSecret.length >= 32);
  const passwordHash = await bcrypt.hash(password, 12);
  await db.user.createMany({ data: [
    { id: manager.userId, email: manager.email, name: 'Responsabile Sintetico N15', passwordHash, role: 'admin', active: true },
    { id: assignee.userId, email: assignee.email, name: 'Commerciale Assegnatario N15', passwordHash, role: 'commerciale', active: true },
    { id: foreign.userId, email: foreign.email, name: 'Commerciale Non Assegnato N15', passwordHash, role: 'commerciale', active: true },
  ] });
  await db.commercialLeadSlaPolicyVersion.create({ data: {
    id: '00000000-0000-4000-8000-000000150302', version: 1, status: 'ACTIVE', responseTargetSeconds: 86_400,
  } });
  await db.applicationKeyVersion.create({ data: {
    id: '00000000-0000-4000-8000-000000150303', purpose: 'PRIVILEGED_STEP_UP', version: 1,
    keyDigest: privilegedStepUpKeyDigest(stepUpSecret), status: 'ACTIVE', activatedAt: new Date(),
    createdById: manager.userId,
  } });
  const commercialSession = createRegistrySessionToken();
  await db.internalSession.create({ data: {
    id: commercialSessionId, userId: assignee.userId,
    tokenDigest: Buffer.from(await digestRegistrySessionToken(commercialSession.bytes)),
    expiresAt: new Date('2099-01-01T00:00:00.000Z'),
  } });
  const lead = await db.lead.create({ data: {
    id: 'n15-browser-assignment-lead', firstName: 'Percorso', lastName: 'Assegnazione',
    companyName: 'Lead sintetico assegnazione N15', email: 'lead@n15-browser.invalid', source: 'CRM', leadSource: 'manuale',
  } });
  await initializeCommercialLeadInboxItem(db, {
    leadId: lead.id,
    actor: { userId: assignee.userId, sessionId: commercialSessionId },
    attribution: { originKind: 'MANUAL_CRM' }, reasonCode: 'MANUAL_INTAKE',
  });
  const loggedOut = await db.$transaction((tx) =>
    logoutInternalSession(tx, commercialSession.token));
  assert.equal(loggedOut?.id, commercialSessionId);
  assert.equal(await db.auditLog.count({
    where: {
      actorId: assignee.userId, event: 'logout',
      entityType: 'User', entityId: assignee.userId,
    },
  }), 1);
  assert.equal(await db.internalSession.count({
    where: { revokedAt: null, expiresAt: { gt: new Date() } },
  }), 0);
  process.stdout.write('{"n15BrowserProvision":"ready"}\n');
}

void main().catch((error: unknown) => {
  writeProvisionFailureReceipt(process.env.N15_BROWSER_EVIDENCE_DIR, error);
  process.stderr.write('N15_BROWSER_PROVISION_FAILED\n');
  process.exitCode = 1;
}).finally(async () => db.$disconnect());
