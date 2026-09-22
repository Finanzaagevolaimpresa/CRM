import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { engagementDossierHash } from '../src/lib/engagement-dossier';

test('dossier hashes are canonical and bind exact version content and recipients', () => {
  assert.equal(engagementDossierHash({ b: 2, a: 1 }), engagementDossierHash({ a: 1, b: 2 }));
  assert.notEqual(engagementDossierHash({ version: 1, content: 'A' }), engagementDossierHash({ version: 2, content: 'A' }));
  assert.notEqual(engagementDossierHash([{ address: 'a@invalid.test' }]), engagementDossierHash([{ address: 'b@invalid.test' }]));
});

test('migration 47 is additive and preserves the immutable 46-file prefix', () => {
  const migrations = readdirSync('prisma/migrations').filter((name) => /^\d/.test(name)).sort();
  assert.equal(migrations.length, 47);
  assert.equal(migrations.at(-1), '20260920090000_engagement_dossier_approval_delivery_v1');
  const sql = readFileSync(`prisma/migrations/${migrations.at(-1)}/migration.sql`, 'utf8');
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
