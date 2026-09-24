import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const baseline = '8d87d7c0c1377e686ad9c3a9e15a48de6a7ec749';
export const perimeterMigration = '20260924100000_admin_client_read_perimeters_v1';
export const expectedSchemaHash = '5a4677a5bb4c24cdfd6881fa3d998e564f88efa7e9edcd6167585f566bd2964c';
export const expectedMigrationHash = '1ee4d6a47d397af815aca51355b6da4adba92e41abec7ee648ac814fefcf11a8';
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const hash = path => createHash('sha256').update(readFileSync(path, 'utf8').replaceAll('\r\n', '\n')).digest('hex');

export function verifyPerimeterSchema() {
  git('merge-base', '--is-ancestor', baseline, 'HEAD');
  const prior = git('ls-tree', '-d', '--name-only', `${baseline}:prisma/migrations`).split('\n');
  assert.equal(prior.length, 47, 'R05_SCHEMA_BASELINE_COUNT_INVALID');
  const names = readdirSync('prisma/migrations', { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  assert.deepEqual(names, [...prior, perimeterMigration], 'R05_SCHEMA_MIGRATION_SET_INVALID');
  const expectedPath = `prisma/migrations/${perimeterMigration}/migration.sql`;
  assert.equal(git('diff', '--name-only', baseline, 'HEAD', '--', 'prisma/migrations'), expectedPath, 'R05_SCHEMA_HISTORICAL_PREFIX_CHANGED');
  assert.equal(git('diff', '--name-only', 'HEAD', '--', 'prisma/schema.prisma', 'prisma/migrations'), '', 'R05_SCHEMA_WORKTREE_DIRTY');
  assert.equal(hash('prisma/schema.prisma'), expectedSchemaHash, 'R05_SCHEMA_HASH_MISMATCH');
  assert.equal(hash(expectedPath), expectedMigrationHash, 'R05_SCHEMA_MIGRATION_HASH_MISMATCH');
  return { sourceCommit: git('rev-parse', 'HEAD'), sourceTree: git('rev-parse', 'HEAD^{tree}'), migrations: 48,
    baseline, historicalMigrationPrefixUnchanged: 47, additiveMigration: perimeterMigration,
    schemaSha256: expectedSchemaHash, migrationSha256: expectedMigrationHash, productionContact: false };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${JSON.stringify(verifyPerimeterSchema())}\n`);
}
