import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const migration = readFileSync('prisma/migrations/20260920090000_engagement_dossier_approval_delivery_v1/migration.sql', 'utf8');
const diff = readFileSync(process.argv[2], 'utf8');
const expected = [...migration.matchAll(/ADD CONSTRAINT "([^"]+)" FOREIGN KEY/g)].map((match) => match[1]);
assert.equal(expected.length, 17, 'All migration47 foreign keys must be covered');
const dropped = new Set([...diff.matchAll(/DROP CONSTRAINT "([^"]+)"/g)].map((match) => match[1]));
assert.deepEqual(expected.filter((name) => dropped.has(name)), [], 'Prisma datamodel would remove dossier foreign keys');
console.log(JSON.stringify({ dossierForeignKeySchemaParity: 'PASS', constraints: expected.length }));
