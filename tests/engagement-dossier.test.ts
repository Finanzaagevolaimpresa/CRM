import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { AuthSession } from '../src/lib/auth';
import { engagementDossierHash, EngagementDossierError, exportApprovedEngagementDossier, authorizeEngagementDossierDelivery, recordEngagementDossierDelivery } from '../src/lib/engagement-dossier';

test('dossier hashes are canonical and bind exact version content and recipients', () => {
  assert.equal(engagementDossierHash({ b: 2, a: 1 }), engagementDossierHash({ a: 1, b: 2 }));
  assert.notEqual(engagementDossierHash({ version: 1, content: 'A' }), engagementDossierHash({ version: 2, content: 'A' }));
  assert.notEqual(engagementDossierHash([{ address: 'a@invalid.test' }]), engagementDossierHash([{ address: 'b@invalid.test' }]));
});

test('migration 47 is additive and preserves the immutable 46-file prefix', () => {
  const migrations = readdirSync('prisma/migrations').filter((name) => /^\d/.test(name)).sort();
  assert.equal(migrations.length, 49);
  assert.equal(migrations[46], '20260920090000_engagement_dossier_approval_delivery_v1');
  const sql = readFileSync(`prisma/migrations/${migrations[46]}/migration.sql`, 'utf8');
  assert.match(sql, /ALTER TABLE "ClientDossier"/);
  assert.match(sql, /CREATE TABLE "EngagementDossierVersion"/);
  assert.match(sql, /CREATE TABLE "EngagementDossierDeliveryReceipt"/);
  assert.doesNotMatch(sql, /DROP\s+(TABLE|COLUMN)|TRUNCATE|DELETE\s+FROM/i);
});

test('approval, export authorization and delivery are distinct audited operations', () => {
  const source = readFileSync('src/lib/engagement-dossier.ts', 'utf8');
  assert.match(source, /engagement_dossier_version_approve/);
  assert.match(source, /engagement_dossier_export/);
  assert.match(source, /engagement_dossier_delivery_authorize/);
  assert.match(source, /engagement_dossier_delivery_record/);
  assert.match(source, /dossier\.approvedVersionId !== authorization\.versionId/);
  assert.doesNotMatch(source, /sendMail|smtp|provider|worker/i);
});

for (const operation of ['export', 'authorize', 'record'] as const) test(operation + ' retries only known serialization aborts, at most three times', async () => {
  const input = { dossierId: 'synthetic-retry', versionId: '10000000-0000-4000-8000-000000000001', format: 'markdown' };
  const invoke = (db: Pick<PrismaClient, '$transaction'>) => operation === 'export'
    ? exportApprovedEngagementDossier(db, {} as AuthSession, input, 'synthetic')
    : operation === 'authorize'
      ? authorizeEngagementDossierDelivery(db, {} as AuthSession, { ...input, versionHash: 'a'.repeat(64),
        recipients: [{ kind: 'CLIENT', name: 'Synthetic recipient', address: 'synthetic@invalid.test', synthetic: true }] })
      : recordEngagementDossierDelivery(db, {} as AuthSession, { authorizationId: input.versionId, outcome: 'DELIVERED',
        evidence: { reference: 'SYNTHETIC_RECEIPT', deliveredAt: new Date().toISOString(), synthetic: true } });
  for (const error of [
    new Prisma.PrismaClientKnownRequestError('synthetic serialization', { code: 'P2034', clientVersion: 'test' }),
    new Prisma.PrismaClientKnownRequestError('synthetic raw serialization', { code: 'P2010', clientVersion: 'test', meta: { code: '40001' } }),
    new Prisma.PrismaClientKnownRequestError('synthetic raw deadlock', { code: 'P2010', clientVersion: 'test', meta: { code: '40P01' } }),
  ]) {
    let attempts = 0;
    const db = { $transaction: async () => { attempts += 1; throw error; } } as unknown as Pick<PrismaClient, '$transaction'>;
    await assert.rejects(invoke(db),
      (caught: unknown) => caught instanceof EngagementDossierError && caught.code === 'CONFLICT');
    assert.equal(attempts, 3);
  }
  for (const error of [new Error('connection outcome uncertain'), new EngagementDossierError('DENIED'), new EngagementDossierError('CONFLICT'),
    new Prisma.PrismaClientKnownRequestError('synthetic unrelated database error', { code: 'P2002', clientVersion: 'test' })]) {
    let attempts = 0;
    const db = { $transaction: async () => { attempts += 1; throw error; } } as unknown as Pick<PrismaClient, '$transaction'>;
    await assert.rejects(invoke(db), caught => caught === error);
    assert.equal(attempts, 1);
  }
});
