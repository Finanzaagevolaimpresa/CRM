import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const baseline = '9508d0da1b9642b02609d7431a984ced7b501e2e';
export const migration = '20260927010000_approved_manual_communications_v1';
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const hash = path => createHash('sha256').update(readFileSync(path, 'utf8').replaceAll('\r\n', '\n')).digest('hex');
export function verifyCommunicationSchema() {
  const binding = JSON.parse(readFileSync('scripts/m4/schema-binding.json', 'utf8'));
  assert.equal(binding.baseline, baseline); assert.equal(binding.migration, migration);
  git('merge-base', '--is-ancestor', baseline, 'HEAD');
  const prior = git('ls-tree', '-d', '--name-only', `${baseline}:prisma/migrations`).split('\n');
  assert.equal(prior.length, 48, 'M4_BASELINE_COUNT');
  const names = readdirSync('prisma/migrations', { withFileTypes: true }).filter(item => item.isDirectory()).map(item => item.name).sort();
  assert.deepEqual(names, [...prior, migration], 'M4_EXACT_MIGRATION_SET');
  const path = `prisma/migrations/${migration}/migration.sql`;
  assert.equal(git('diff', '--name-only', baseline, 'HEAD', '--', 'prisma/migrations'), path, 'M4_HISTORICAL_PREFIX');
  assert.equal(git('diff', '--name-only', 'HEAD', '--', 'prisma/schema.prisma', 'prisma/migrations'), '', 'M4_SCHEMA_DIRTY');
  assert.equal(hash('prisma/schema.prisma'), binding.schemaSha256, 'M4_SCHEMA_HASH');
  assert.equal(hash(path), binding.migrationSha256, 'M4_MIGRATION_HASH');
  return { protocol: 'M4_SCHEMA49_BINDING', sourceCommit: git('rev-parse', 'HEAD'), sourceTree: git('rev-parse', 'HEAD^{tree}'),
    baseline, migrations: 49, historicalMigrationPrefixUnchanged: 48, additiveMigration: migration,
    schemaSha256: binding.schemaSha256, migrationSha256: binding.migrationSha256, productionContact: false };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.stdout.write(JSON.stringify(verifyCommunicationSchema()) + '\n');
