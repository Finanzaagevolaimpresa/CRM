import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { classifyProvisionFailure, writeProvisionFailureReceipt } from './n15-browser/provision-diagnostic';

test('N15 browser startup diagnostic emits only finite minimized markers', () => {
  const root = mkdtempSync(join(tmpdir(), 'n15-browser-diagnostic-'));
  try {
    const log = join(root, 'server.log');
    const output = join(root, 'diagnostic.json');
    const privateValue = 'PRIVATE_SYNTHETIC_PASSWORD_MUST_NOT_APPEAR';
    writeFileSync(log, `Error INTERNAL_SESSION_REGISTRY_ACTIVATION_BLOCKED ${privateValue}\n`);
    execFileSync(process.execPath, [
      'tests/n15-browser/write-startup-diagnostic.mjs', log, output, 'EARLY_EXIT', '1',
    ]);
    const raw = readFileSync(output, 'utf8');
    const diagnostic = JSON.parse(raw) as {
      reasonCode: string; processExitStatus: string;
      markers: { registryActivationBlocked: boolean };
    };
    assert.equal(diagnostic.reasonCode, 'EARLY_EXIT');
    assert.equal(diagnostic.processExitStatus, '1');
    assert.equal(diagnostic.markers.registryActivationBlocked, true);
    assert.doesNotMatch(raw, new RegExp(privateValue, 'u'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('N15 browser startup diagnostic rejects arbitrary reason and status fields', () => {
  assert.throws(() => execFileSync(process.execPath, [
    'tests/n15-browser/write-startup-diagnostic.mjs', '/missing', '/tmp/forbidden',
    'ARBITRARY_REASON', 'PRIVATE_STATUS',
  ], { stdio: 'pipe' }));
});

test('N15 browser provision failures produce a finite minimized receipt', () => {
  const root = mkdtempSync(join(tmpdir(), 'n15-browser-provision-'));
  try {
    const privateValue = 'PRIVATE_DATABASE_DETAIL_MUST_NOT_APPEAR';
    const error = Object.assign(new Error(privateValue), { code: 'P2004', meta: { detail: privateValue } });
    assert.equal(classifyProvisionFailure(error), 'PRISMA_P2004');
    assert.equal(classifyProvisionFailure({ code: 'P2999' }), 'PRISMA_OTHER');
    writeProvisionFailureReceipt(root, error);
    const raw = readFileSync(join(root, 'provision.json'), 'utf8');
    assert.deepEqual(JSON.parse(raw), {
      phase: 'provision', status: 'FAILED', code: 'PRISMA_P2004',
    });
    assert.doesNotMatch(raw, new RegExp(privateValue, 'u'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('N15 browser post-test server diagnostic redacts known synthetic secrets', () => {
  const root = mkdtempSync(join(tmpdir(), 'n15-browser-runtime-'));
  try {
    const log = join(root, 'server.log');
    const output = join(root, 'runtime.json');
    const password = 'SYNTHETIC_PASSWORD_PRIVATE';
    writeFileSync(log, `Error: Failed to find Server Action ${password}\n    at synthetic stack\n`);
    execFileSync(process.execPath, [
      'tests/n15-browser/write-runtime-diagnostic.mjs', log, output,
    ], { env: { ...process.env, N15_BROWSER_PASSWORD: password } });
    const raw = readFileSync(output, 'utf8');
    const diagnostic = JSON.parse(raw) as {
      phase: string; classifications: { missingOrUnknownAction: boolean }; frameworkExcerpt: string;
    };
    assert.equal(diagnostic.phase, 'POST_BROWSER_SERVER');
    assert.equal(diagnostic.classifications.missingOrUnknownAction, true);
    assert.match(diagnostic.frameworkExcerpt, /\[REDACTED\]/u);
    assert.doesNotMatch(raw, new RegExp(password, 'u'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('N15 server diagnostic retains the exact blocked dev-resource warning', () => {
  const root = mkdtempSync(join(tmpdir(), 'n15-browser-dev-origin-'));
  try {
    const log = join(root, 'server.log');
    const output = join(root, 'runtime.json');
    writeFileSync(log, 'Blocked cross-origin request to Next.js dev resource /_next/static/chunks/app.js\n');
    execFileSync(process.execPath, ['tests/n15-browser/write-runtime-diagnostic.mjs', log, output]);
    const diagnostic = JSON.parse(readFileSync(output, 'utf8')) as {
      classifications: { devResourceBlocked: boolean }; frameworkExcerpt: string;
    };
    assert.equal(diagnostic.classifications.devResourceBlocked, true);
    assert.match(diagnostic.frameworkExcerpt, /Blocked cross-origin request to Next\.js dev resource/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
