import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const repoRoot = process.cwd();
const lib = path.join(repoRoot, 'scripts/n05/lib.sh');
const verifier = path.join(repoRoot, 'scripts/n05/verify-backup-manifest.sh');
const sourceCommit = '1'.repeat(40);
const sourceTree = '2'.repeat(40);
const appImageId = `sha256:${'3'.repeat(64)}`;

function shell(script: string, env: Record<string, string | undefined> = {}) {
  return spawnSync('bash', ['-c', script], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}

function sha256(file: string) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

test('N05 stays migration-free and introduces the complete release-safety surface', () => {
  assert.equal(readdirSync('prisma/migrations').filter((name) => /^\d/.test(name)).length, 35);
  const expected = [
    '.env.staging.example',
    'docker-compose.staging.example.yml',
    'docker-compose.restore-drill.yml',
    'scripts/n05/lib.sh',
    'scripts/n05/backup-compose.sh',
    'scripts/n05/verify-backup-manifest.sh',
    'scripts/n05/restore-drill.sh',
    'scripts/n05/release-gate.sh',
    'scripts/n05/staging-preflight.sh',
  ];
  for (const file of expected) assert.doesNotThrow(() => readFileSync(file), file);

  const backup = readFileSync('scripts/n05/backup-compose.sh', 'utf8');
  assert.match(backup, /APPLICATION_NOT_QUIESCED/);
  assert.match(backup, /pg_restore --list/);
  assert.match(backup, /FAI_CRM_N05_BACKUP_V1/);
  assert.doesNotMatch(backup, /down\s+-v|system\s+prune|volume\s+prune|rm\s+-rf/);

  const restore = readFileSync('scripts/n05/restore-drill.sh', 'utf8');
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
});

test('restore Compose commands use the generated synthetic env over inherited CI values', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'n05-restore-env-'));
  try {
    const envFile = path.join(root, 'restore.env');
    writeFileSync(envFile, [
      'DATABASE_URL=postgresql://synthetic:secret@postgres:5432/fai_crm_n05_source?schema=public',
      'FAI_ENVIRONMENT=restore-source',
      '',
    ].join('\n'), { mode: 0o600 });
    const command = `source "${lib}"; n05_run_with_env_file "${envFile}" bash -c 'printf "%s|%s" "$DATABASE_URL" "$FAI_ENVIRONMENT"'`;
    const result = shell(command, {
      DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/fai_crm_test?schema=public',
      FAI_ENVIRONMENT: 'production',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'postgresql://synthetic:secret@postgres:5432/fai_crm_n05_source?schema=public|restore-source');

    writeFileSync(envFile, 'DATABASE_URL=synthetic\nDATABASE_URL=forged\n');
    assert.equal(shell(`source "${lib}"; n05_run_with_env_file "${envFile}" true`).status, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('environment identity accepts only an explicit isolated staging identity', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'n05-identity-'));
  try {
    const compose = path.join(repoRoot, 'docker-compose.staging.example.yml');
    const envFile = path.join(root, '.env.staging');
    writeFileSync(envFile, 'SYNTHETIC_ONLY=true\n');
    const command = `source "${lib}"; n05_assert_environment_identity staging; printf PASS`;
    const base = {
      FAI_ENVIRONMENT: 'staging',
      FAI_ENVIRONMENT_SENTINEL: 'FAI_CRM_STAGING_ISOLATED_V1',
      COMPOSE_PROJECT_NAME: 'fai-crm-staging-n05-test',
      COMPOSE_FILE: compose,
      ENV_FILE: envFile,
      APP_ORIGIN: 'https://staging.invalid',
      APP_IMAGE: 'fai-crm:staging-1111111111111111111111111111111111111111',
    };
    assert.equal(shell(command, base).status, 0);
    assert.equal(shell(command, { ...base, COMPOSE_PROJECT_NAME: 'fai-crm' }).status, 1);
    assert.equal(shell(command, { ...base, APP_ORIGIN: 'https://desk.finanzaagevolaimpresa.it' }).status, 1);
    assert.equal(shell(command, { ...base, FAI_ENVIRONMENT_SENTINEL: 'unknown' }).status, 1);
    assert.equal(shell(command, { ...base, APP_IMAGE: 'fai-crm:pr91-3736f91b1787' }).status, 1);
    const forgedRoot = path.join(root, 'forged');
    mkdirSync(forgedRoot);
    const forgedCompose = path.join(forgedRoot, 'docker-compose.staging.example.yml');
    writeFileSync(forgedCompose, 'services: {}\n');
    assert.equal(shell(command, { ...base, COMPOSE_FILE: forgedCompose }).status, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('staging env contract denies production database reuse and open gates without exposing values', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'n05-staging-env-'));
  try {
    const envFile = path.join(root, '.env.staging');
    const commit = '3'.repeat(40);
    const tree = '4'.repeat(40);
    const project = 'fai-crm-staging-n05-contract';
    const origin = 'https://staging.crm.example.test';
    const image = `fai-crm:staging-${commit}`;
    const rows = [
      'FAI_ENVIRONMENT=staging',
      'FAI_ENVIRONMENT_SENTINEL=FAI_CRM_STAGING_ISOLATED_V1',
      'APP_ENV=staging',
      'NODE_ENV=production',
      `COMPOSE_PROJECT_NAME=${project}`,
      `APP_ORIGIN=${origin}`,
      `NEXT_PUBLIC_APP_URL=${origin}`,
      `APP_IMAGE=${image}`,
      `SOURCE_COMMIT=${commit}`,
      `SOURCE_TREE=${tree}`,
      `APP_ENV_FILE=${envFile}`,
      'APP_PORT=3101',
      'POSTGRES_DB=fai_crm_staging_contract',
      'POSTGRES_USER=fai_crm_staging_contract',
      'POSTGRES_PASSWORD=synthetic-staging-password',
      'DATABASE_URL=postgresql://fai_crm_staging_contract:synthetic-staging-password@postgres:5432/fai_crm_staging_contract?schema=public',
      'AUTH_SECRET=synthetic-staging-auth-secret-at-least-32-bytes',
      'AUTH_COOKIE_NAME=fai_crm_staging_contract_session',
      'STORAGE_PROVIDER=local',
      'LOCAL_DOCUMENT_STORAGE_ROOT=/var/lib/fai-crm/documents',
      'FEATURE_INTEGRATIONS_ENABLED=false',
      'FEATURE_CUSTOMER_PORTAL_ENABLED=false',
      'FEATURE_PAYMENTS_ENABLED=false',
      'FEATURE_AI_WORKER_ENABLED=false',
      'FEATURE_AI_DISPATCH_ENABLED=false',
      'FEATURE_AI_EGRESS_ENABLED=false',
      'AI_EXTERNAL_PROVIDERS_ENABLED=false',
      'AI_ALLOWED_MODELS=',
      'AI_API_KEY=',
      'PRIVILEGED_STEP_UP_KEY_VERSION=',
      'PRIVILEGED_STEP_UP_SECRET=',
      'WEBSITE_LEAD_WEBHOOK_SECRET=',
      'INTERNAL_SESSION_MODE=legacy',
      'PRIVILEGED_ACCESS_MODE=disabled',
      'LOGIN_THROTTLE_MODE=disabled',
      'SECURITY_HEADERS_MODE=report-only',
      'AI_PROVIDER=mock',
      'AI_ORCHESTRATOR_WORKER_ENABLED=0',
      'WEBSITE_LEAD_MODE=disabled',
      '',
    ];
    writeFileSync(envFile, rows.join('\n'), { mode: 0o600 });
    const command = `source "${lib}"; n05_assert_staging_env_file`;
    const env = {
      ENV_FILE: envFile,
      COMPOSE_PROJECT_NAME: project,
      APP_ORIGIN: origin,
      APP_IMAGE: image,
      EXPECTED_DATABASE_NAME: 'fai_crm_staging_contract',
      EXPECTED_DATABASE_USER: 'fai_crm_staging_contract',
      EXPECTED_SOURCE_COMMIT: commit,
      EXPECTED_SOURCE_TREE: tree,
    };
    assert.equal(shell(command, env).status, 0);
    writeFileSync(envFile, rows.map((row) => row.startsWith('DATABASE_URL=')
      ? 'DATABASE_URL=postgresql://user:password@production-db:5432/fai_crm?schema=public'
      : row).join('\n'));
    const denied = shell(command, env);
    assert.equal(denied.status, 1);
    assert.equal(denied.stderr.includes('password'), false);
    writeFileSync(envFile, rows.map((row) => row.startsWith('AUTH_SECRET=')
      ? 'AUTH_SECRET=${PRODUCTION_AUTH_SECRET_MUST_NOT_EXPAND}'
      : row).join('\n'));
    assert.equal(shell(command, env).status, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('backup manifest is strict, checksum-bound and rejects corruption', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'n05-manifest-'));
  try {
    chmodSync(root, 0o700);
    writeFileSync(path.join(root, 'postgres.dump'), 'synthetic postgres dump');
    const docsRoot = path.join(root, 'docs-source');
    mkdirSync(path.join(docsRoot, 'n05'), { recursive: true });
    writeFileSync(path.join(docsRoot, 'n05', 'document.txt'), 'synthetic document');
    const tar = spawnSync('tar', ['-czf', path.join(root, 'documents.tar.gz'), '-C', docsRoot, '.']);
    assert.equal(tar.status, 0);
    writeFileSync(path.join(root, 'MANIFEST.txt'), [
      'schema=FAI_CRM_N05_BACKUP_V1',
      'environment=restore-source',
      'environment_sentinel=FAI_CRM_N05_RESTORE_SOURCE_V1',
      'compose_project=fai-crm-restore-unit-test-source',
      'created_at=20260817T120000Z',
      'consistency=application-quiesced',
      `source_commit=${sourceCommit}`,
      `source_tree=${sourceTree}`,
      `app_image_id=${appImageId}`,
      'image_provenance=oci-labels',
      'migration_count=35',
      'database_file=postgres.dump',
      'documents_file=documents.tar.gz',
      '',
    ].join('\n'));
    writeFileSync(path.join(root, 'SHA256SUMS'), [
      `${sha256(path.join(root, 'postgres.dump'))}  postgres.dump`,
      `${sha256(path.join(root, 'documents.tar.gz'))}  documents.tar.gz`,
      '',
    ].join('\n'));
    for (const file of ['postgres.dump', 'documents.tar.gz', 'MANIFEST.txt', 'SHA256SUMS']) {
      chmodSync(path.join(root, file), 0o600);
    }
    const env = {
      EXPECTED_ENVIRONMENT: 'restore-source',
      EXPECTED_PROJECT: 'fai-crm-restore-unit-test-source',
      EXPECTED_SOURCE_COMMIT: sourceCommit,
      EXPECTED_SOURCE_TREE: sourceTree,
      EXPECTED_APP_IMAGE_ID: appImageId,
      EXPECTED_IMAGE_PROVENANCE: 'oci-labels',
      EXPECTED_MIGRATION_COUNT: '35',
    };
    assert.equal(shell(`"${verifier}" "${root}"`, env).status, 0);
    writeFileSync(path.join(root, 'postgres.dump'), 'corrupted');
    assert.equal(shell(`"${verifier}" "${root}"`, env).status, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('archive validation rejects traversal and symlink entries before extraction', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'n05-archive-'));
  try {
    writeFileSync(path.join(root, 'safe'), 'synthetic');
    const traversal = path.join(root, 'traversal.tar.gz');
    assert.equal(spawnSync('tar', ['-czf', traversal, '--transform=s|safe|../escape|', '-C', root, 'safe']).status, 0);
    assert.equal(shell(`source "${lib}"; n05_assert_archive_safe "${traversal}"`).status, 1);

    const target = path.join(root, 'target');
    writeFileSync(target, 'synthetic');
    const link = path.join(root, 'link');
    assert.equal(shell(`ln -s "${target}" "${link}" && tar -czf "${root}/link.tar.gz" -C "${root}" link`).status, 0);
    assert.equal(shell(`source "${lib}"; n05_assert_archive_safe "${root}/link.tar.gz"`).status, 1);

    const truncated = path.join(root, 'truncated.tar.gz');
    assert.equal(spawnSync('tar', ['-czf', truncated, '-C', root, 'safe']).status, 0);
    truncateSync(truncated, Math.max(1, readFileSync(truncated).length - 8));
    assert.equal(shell(`source "${lib}"; n05_assert_archive_safe "${truncated}"`).status, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
