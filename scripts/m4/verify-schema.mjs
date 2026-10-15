import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const baseline = '8cf688f58f02b71ebe169f489b5c3c04f6a648b8';
export const qualifiedBaseline = '9508d0da1b9642b02609d7431a984ced7b501e2e';
export const migration = '20260927010000_approved_manual_communications_v1';
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const hash = path => createHash('sha256').update(readFileSync(path, 'utf8').replaceAll('\r\n', '\n')).digest('hex');
export function verifyCommunicationSchema() {
  const binding = JSON.parse(readFileSync('scripts/m4/schema-binding.json', 'utf8'));
  assert.equal(binding.baseline, baseline); assert.equal(binding.qualifiedBaseline, qualifiedBaseline);
  assert.equal(binding.migration, migration);
  // The reviewed M3 was squash-merged; bind its integrated commit and unchanged schema.
  assert.equal(git('diff', '--name-only', qualifiedBaseline, baseline, '--', 'prisma/schema.prisma', 'prisma/migrations'), '', 'M4_INTEGRATED_BASELINE_SCHEMA');
  git('merge-base', '--is-ancestor', baseline, 'HEAD');
  const prior = git('ls-tree', '-d', '--name-only', `${baseline}:prisma/migrations`).split('\n');
  assert.equal(prior.length, 48, 'M4_BASELINE_COUNT');
  const names = readdirSync('prisma/migrations', { withFileTypes: true }).filter(item => item.isDirectory()).map(item => item.name).sort();
  const selective = JSON.parse(readFileSync('scripts/selective-sharing/schema-binding.json', 'utf8'));
  assert.equal(selective.baseline, 'c2948f387dfe7235bbdaf19f501b676cbf36aba2');
  assert.equal(selective.historicalMigrationCount, 49);
  assert.equal(selective.migration, '20261015090000_selective_project_access_v1');
  const selectivePath = `prisma/migrations/${selective.migration}/migration.sql`;
  assert.deepEqual(names, [...prior, migration, selective.migration], 'M4_EXACT_MIGRATION_SET');
  const path = `prisma/migrations/${migration}/migration.sql`;
  assert.equal(git('diff', '--name-only', baseline, 'HEAD', '--', 'prisma/migrations'), `${path}\n${selectivePath}`, 'M4_HISTORICAL_PREFIX');
  assert.equal(git('rev-parse', `${selective.baseline}^{tree}`), selective.baselineTree, 'SELECTIVE_BASELINE_TREE');
  git('merge-base', '--is-ancestor', selective.baseline, 'HEAD');
  assert.equal(hash(path), binding.migrationSha256, 'M4_MIGRATION_HASH');
  assert.equal(git('diff', '--name-only', selective.baseline, 'HEAD', '--', 'prisma/migrations'), selectivePath, 'SELECTIVE_PREFIX49_UNCHANGED');
  assert.equal(git('diff', '--name-only', 'HEAD', '--', 'prisma/schema.prisma', 'prisma/migrations'), '', 'M4_SCHEMA_DIRTY');
  assert.equal(hash('prisma/schema.prisma'), selective.schemaSha256, 'M4_SCHEMA_HASH');
  assert.equal(hash(path), binding.migrationSha256, 'M4_MIGRATION_HASH');
  assert.equal(hash(selectivePath), selective.migrationSha256, 'SELECTIVE_MIGRATION_HASH');
  return { protocol: 'SELECTIVE_PROJECT_SCHEMA50_BINDING', sourceCommit: git('rev-parse', 'HEAD'), sourceTree: git('rev-parse', 'HEAD^{tree}'),
    baseline: selective.baseline, qualifiedBaseline, migrations: 50, historicalMigrationPrefixUnchanged: 49, additiveMigration: selective.migration,
    schemaSha256: selective.schemaSha256, migrationSha256: selective.migrationSha256, productionContact: false };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.stdout.write(JSON.stringify(verifyCommunicationSchema()) + '\n');
