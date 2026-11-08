import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { assertLocalLinuxDocker, canonicalSnapshotBytes, posixRunArgs, safeSnapshotPath, tapCounts, unitTestFiles } = require('../scripts/unit-test-plan.mjs');

test('unit runner includes every native and POSIX test group without skip filters', () => {
  const files = unitTestFiles(process.cwd());
  assert.ok(files.native.length > 200);
  assert.equal(files.posix.length, 8);
  const args = posixRunArgs('sha256:' + 'a'.repeat(64), files.posix);
  assert.deepEqual(args.slice(-files.posix.length), files.posix);
  for (const required of ['none', '--read-only', 'ALL', 'no-new-privileges=true', '1000:1000']) assert.ok(args.includes(required));
  assert.equal(args.some((arg: string) => /^--(?:test-skip-pattern|privileged|mount|volume|publish)(?:=|$)|^\/var\/run\/docker\.sock$/u.test(arg)), false);
  assert.throws(() => posixRunArgs('unqualified:latest', files.posix), /INPUT_INVALID/);
  assert.throws(() => posixRunArgs('sha256:' + 'a'.repeat(64), ['../other.test.ts']), /INPUT_INVALID/);
  assert.ok(args.includes('/home/node:rw,exec,nosuid,nodev,size=33554432,mode=0700,uid=1000,gid=1000'));
  assert.ok(args.includes('/tmp:rw,exec,nosuid,nodev,size=536870912,mode=1777'));
});

test('unit POSIX source admission excludes private inputs, traversal and untracked namespaces', () => {
  for (const name of ['src/lib/storage.ts', 'tests/posix/storage-permissions.test.ts', '.env.production.example', 'package-lock.json']) {
    assert.equal(safeSnapshotPath(name), true, name);
  }
  for (const name of ['../src/x', '/src/x', 'src/../secret', 'src/.env', 'src/.env.production',
    'src/CRM TXT.txt', 'src/FAI-Custodia/key', 'C:/secret', 'src\\x', '.env', '.env.production', '.git/config',
    'node_modules/x', 'storage/private/file', 'outputs/evidence', 'CRM TXT.txt']) {
    assert.equal(safeSnapshotPath(name), false, name);
  }
  const original = Buffer.from('first\r\nsecond\r\n');
  assert.equal(canonicalSnapshotBytes('scripts/example.sh', original).toString(), 'first\nsecond\n');
  assert.equal(original.toString(), 'first\r\nsecond\r\n');
  assert.deepEqual(canonicalSnapshotBytes('tests/fixture.bin', Buffer.from([0, 13, 10, 255])), Buffer.from([0, 13, 10, 255]));
});

test('unit POSIX runner refuses remote or non-Linux Docker targets', () => {
  const local = { Name: 'desktop-linux', Endpoints: { docker: { Host: 'npipe:////./pipe/dockerDesktopLinuxEngine' } } };
  assert.doesNotThrow(() => assertLocalLinuxDocker(local, { OSType: 'linux' }));
  for (const host of ['tcp://remote:2375', 'ssh://fai-crm-prod', 'unix:///var/run/docker.sock', 'npipe:////./pipe/other']) {
    assert.throws(() => assertLocalLinuxDocker({ ...local, Endpoints: { docker: { Host: host } } }, { OSType: 'linux' }), /REQUIRED/);
  }
  assert.throws(() => assertLocalLinuxDocker(local, { OSType: 'windows' }), /REQUIRED/);
});

test('unit evidence rejects missing, contradictory or duplicated TAP summaries', () => {
  const valid = '# tests 4\n# pass 3\n# fail 0\n# cancelled 0\n# skipped 1\n# todo 0\n';
  assert.deepEqual(tapCounts(valid), { tests: 4, pass: 3, fail: 0, cancelled: 0, skipped: 1, todo: 0 });
  assert.deepEqual(tapCounts(valid.replaceAll('\n', '\r\n')), tapCounts(valid));
  assert.throws(() => tapCounts(valid + valid), /SUMMARY_INVALID/);
  assert.throws(() => tapCounts(valid.replace('# tests 4', '# tests 5')), /COUNTS_INVALID/);
  assert.throws(() => tapCounts('# pass 1\n'), /SUMMARY_INVALID/);
});
