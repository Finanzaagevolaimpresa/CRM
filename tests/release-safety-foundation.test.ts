import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

test('N05 stays migration-free and introduces the complete release-safety surface', () => {
  assert.equal(readdirSync('prisma/migrations').filter((name) => /^\d/.test(name)).length, 76);
  const expected = [
    '.env.staging.example',
    'docker-compose.prod.legacy-resources.yml',
    'docker-compose.staging.example.yml',
    'docker-compose.restore-drill.yml',
    'scripts/n05/lib.sh',
    'scripts/n05/backup-compose.sh',
    'scripts/n05/verify-backup-manifest.sh',
    'scripts/n05/restore-drill.sh',
    'scripts/n05/release-gate.sh',
    'scripts/n05/staging-preflight.sh',
    'scripts/n05/switch-production-app-legacy.sh',
  ];
  for (const file of expected) assert.doesNotThrow(() => readFileSync(file), file);

  const backup = readFileSync('scripts/n05/backup-compose.sh', 'utf8');
  const releaseLib = readFileSync('scripts/n05/lib.sh', 'utf8');
  const resourceBridge = `${backup}\n${releaseLib}`;
  assert.match(backup, /APPLICATION_NOT_QUIESCED/);
  assert.match(backup, /pg_restore --list/);
  assert.match(backup, /FAI_CRM_N05_BACKUP_V1/);
  assert.match(backup, /DOCUMENTS_VOLUME_IDENTITY_MISMATCH/);
  assert.doesNotMatch(backup, /compose run/);
  for (const isolatedArchiveControl of [
    '--pull never',
    '--network none',
    '--read-only',
    '--cap-drop ALL',
    '--security-opt no-new-privileges=true',
    'dst=/var/lib/fai-crm/documents,readonly',
  ]) assert.match(backup, new RegExp(isolatedArchiveControl));
  assert.match(resourceBridge, /authorized-legacy-compose-identity/);
  assert.match(resourceBridge, /FAI_CRM_N05_LEGACY_RESOURCE_BRIDGE_V1/);
  assert.equal((releaseLib.match(/docker ps -aq --no-trunc/g) ?? []).length, 3);
  for (const certifiedIdentity of [
    'fai-crm-app-1',
    'fai-crm-postgres-1',
    'fai-crm_crm_documents',
    'fai-crm_postgres_data',
    'fai-crm_default',
  ]) assert.match(resourceBridge, new RegExp(certifiedIdentity));
  assert.match(resourceBridge, /LEGACY_RESOURCE_BRIDGE_PRODUCTION_ONLY/);
  assert.match(resourceBridge, /LEGACY_RESOURCE_BRIDGE_NOT_REQUIRED/);
  assert.doesNotMatch(backup, /down\s+-v|system\s+prune|volume\s+prune|rm\s+-rf/);

  const legacyOverride = readFileSync('docker-compose.prod.legacy-resources.yml', 'utf8');
  const legacySwitch = readFileSync('scripts/n05/switch-production-app-legacy.sh', 'utf8');
  for (const persistentResource of [
    'fai-crm_postgres_data',
    'fai-crm_crm_documents',
    'fai-crm_default',
  ]) assert.match(legacyOverride, new RegExp(persistentResource));
  assert.equal((legacyOverride.match(/:\s*!override$/gm) ?? []).length, 3);
  assert.equal((legacyOverride.match(/external: true/g) ?? []).length, 3);
  assert.match(legacySwitch, /n05_assert_authorized_legacy_compose_resources/);
  assert.match(legacySwitch, /n05_assert_authorized_legacy_compose_resources "\$postgres_id" running/);
  assert.match(legacySwitch, /COMPOSE_OVERRIDE_UNSUPPORTED/);
  assert.match(legacySwitch, /<\/dev\/null/);
  assert.match(legacySwitch, /LEGACY_SWITCH_DESTRUCTIVE_PROMPT_DETECTED/);
  assert.match(legacySwitch, /--no-deps --no-build --force-recreate app/);
  assert.doesNotMatch(legacySwitch, /(?:^|\s)(?:-y|--yes)(?:\s|$)/m);
  assert.doesNotMatch(legacySwitch, /down\s+-v|volume\s+rm|system\s+prune|volume\s+prune/);

  const restore = readFileSync('scripts/n05/restore-drill.sh', 'utf8').replaceAll('\r\n', '\n');
  assert.match(restore, /CORRUPTED_BACKUP_WAS_ACCEPTED/);
  assert.match(restore, /RESTORED_DOCUMENT_HASH_MISMATCH/);
  assert.match(restore, /ROLLBACK_PASS/);
  assert.match(restore, /--exit-on-error --no-owner --no-privileges/);
  assert.match(restore, /compose_source up -d postgres\nwait_for_postgres source/);
  assert.match(restore, /compose_target up -d postgres\nwait_for_postgres target/);
  assert.doesNotMatch(restore, /down\s+-v|system\s+prune|volume\s+prune/);

  const release = readFileSync('scripts/n05/release-gate.sh', 'utf8');
  for (const invariant of ['REMOTE_MAIN_MISMATCH', 'CI_SHA_MISMATCH', 'RELEASE_IMAGE_ID_MISMATCH', 'INCOMPATIBLE_PR_PRESENT']) {
    assert.match(release, new RegExp(invariant));
  }
  for (const migrationIdentity of [
    'EXPECTED_REPOSITORY_MIGRATION_COUNT',
    'EXPECTED_BACKUP_MIGRATION_COUNT',
    'INVALID_REPOSITORY_MIGRATION_COUNT',
    'INVALID_BACKUP_MIGRATION_COUNT',
  ]) assert.match(release, new RegExp(migrationIdentity));
  assert.match(release, /repo_migration_count" == "\$EXPECTED_REPOSITORY_MIGRATION_COUNT"/);
  assert.match(release, /EXPECTED_MIGRATION_COUNT="\$EXPECTED_BACKUP_MIGRATION_COUNT"/);
  assert.doesNotMatch(release, /repo_migration_count" == "\$\{EXPECTED_MIGRATION_COUNT/);
  assert.match(release, /BACKUP_RESOURCE_PROVENANCE/);
  assert.match(readFileSync('scripts/n05/verify-backup-manifest.sh', 'utf8'), /resource_provenance/);
});
