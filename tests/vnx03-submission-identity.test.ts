import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { assertWpformsSubmissionId, requireWpformsEdition } from './vnx03/submission-identity';

const ephemeral = 'WPFORM:900001:EPHEMERAL:0123456789abcdef0123456789abcdef';
const persisted = 'WPFORM:900001:ENTRY:700001';

test('VNX03 requires an explicit supported WPForms edition', () => {
  for (const value of [undefined, null, '', 'PRO', 'unknown', false]) {
    assert.throws(() => requireWpformsEdition(value), /VNX03_WPFORMS_EDITION_REQUIRED/u);
  }
  assert.equal(requireWpformsEdition('lite'), 'lite');
  assert.equal(requireWpformsEdition('pro'), 'pro');
});

test('VNX03 Pro admits the persisted ENTRY from the existing PHP contract fixture', () => {
  const source = readFileSync(resolve(import.meta.dirname, 'php/vnx02-wordpress-secure-lead-connector.test.php'), 'utf8');
  assert.ok(source.includes(persisted));
  assert.doesNotThrow(() => assertWpformsSubmissionId(persisted, 'pro'));
  assert.doesNotThrow(() => assertWpformsSubmissionId('WPFORM:900001:ENTRY:1', 'pro'));
});

test('VNX03 Lite retains the exact ephemeral identity predicate', () => {
  assert.doesNotThrow(() => assertWpformsSubmissionId(ephemeral, 'lite'));
});

test('VNX03 cannot satisfy one edition with the other identity mode', () => {
  assert.throws(() => assertWpformsSubmissionId(ephemeral, 'pro'), /VNX03_SUBMISSION_ID_EDITION_MISMATCH/u);
  assert.throws(() => assertWpformsSubmissionId(persisted, 'lite'), /VNX03_SUBMISSION_ID_EDITION_MISMATCH/u);
});

test('VNX03 Pro rejects a different form, zero, negative and malformed entry identifiers', () => {
  for (const id of ['WPFORM:900002:ENTRY:700001', 'WPFORM:900001:ENTRY:0',
    'WPFORM:900001:ENTRY:-1', 'WPFORM:900001:ENTRY:01', 'WPFORM:900001:ENTRY:1.5',
    'WPFORM:900001:ENTRY:1e5', 'WPFORM:900001:ENTRY:', 'WPFORM:900001:ENTRY:1:suffix',
    'WPFORM:900001:ENTRY:1\n', ' WPFORM:900001:ENTRY:1']) {
    assert.throws(() => assertWpformsSubmissionId(id, 'pro'), /VNX03_SUBMISSION_ID_EDITION_MISMATCH/u);
  }
});

test('VNX03 Lite rejects other forms, length and encoding deviations', () => {
  for (const id of [ephemeral.replace('900001', '900002'), ephemeral.slice(0, -1),
    ephemeral + '0', ephemeral.toUpperCase(), ephemeral + '\n', 'WPFORM:900001:EPHEMERAL:']) {
    assert.throws(() => assertWpformsSubmissionId(id, 'lite'), /VNX03_SUBMISSION_ID_EDITION_MISMATCH/u);
  }
});

test('VNX03 propagates the selected edition to every database assertion and verifies its receipt', () => {
  const browser = readFileSync(resolve(import.meta.dirname, 'vnx03/wpforms-https-e2e.spec.ts'), 'utf8');
  const database = readFileSync(resolve(import.meta.dirname, 'vnx03/assert-state.ts'), 'utf8');
  assert.match(browser, /'-e', `VNX03_WPFORMS_EDITION=\$\{wpformsEdition\}`/u);
  assert.match(browser, /"wpformsEdition":"\$\{wpformsEdition\}"/u);
  assert.match(database, /requireWpformsEdition\(process\.env\.VNX03_WPFORMS_EDITION\)/u);
  assert.match(database, /assertWpformsSubmissionId\(parsed\.source\.submissionId, edition\)/u);
  assert.match(database, /verifyBusinessEvents\(checkpoint, edition\)/u);
});
