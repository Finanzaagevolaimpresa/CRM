import assert from 'node:assert/strict';
import test from 'node:test';
import {
  aiExecutionCanonicalSha256V2,
  canonicalAiExecutionJsonV2,
  canonicalJson,
  canonicalSha256,
} from '../src/lib/canonical-json';

const vectors: Array<[unknown, string, string]> = [
  [1e-7, '1e-7', '5b33e02f2c5103a05d32f6ba9cb058294452bfbf393967f68bb30c1bdcbbab22'],
  [1e21, '1e+21', '241c4643fa70b1dcde1205b71be4e3bebb17e9f880c8e1a33d0ead6c27271d3c'],
  [1e-6, '0.000001', '159fb29a827ad04b260aa6c8ab6d8637f8f2b38af5c4f3cb49d6a21205e040f8'],
  [-42.5, '-42.5', '7fdd52337fecfc5812863fc0711337d3fee69c0238fe52b6057f340667dd3a56'],
  [-0, '0', '5feceb66ffc86f38d952786c6d696c79c2dbc239dd4e91b46729d73a27fb57e9'],
];

test('canonicalizzazione v1 resta invariata mentre il contratto v2 è version-bound', () => {
  for (const [value, canonical, legacyDigest] of vectors) {
    assert.equal(canonicalAiExecutionJsonV2(value), canonical);
    assert.equal(canonicalJson(value), canonical);
    assert.equal(canonicalSha256(value), legacyDigest);
    assert.notEqual(aiExecutionCanonicalSha256V2(value), legacyDigest);
  }
});

test('v2 ordina chiavi, preserva array/Unicode e normalizza ricorsivamente -0', () => {
  const first = { z: 1e21, '😀': 'astrale', é: 'combinante', a: [-0, true, null, { n: 1e-7 }] };
  const second = { a: [0, true, null, { n: 1e-7 }], é: 'combinante', '😀': 'astrale', z: 1e21 };
  assert.equal(canonicalAiExecutionJsonV2(first), canonicalAiExecutionJsonV2(second));
  assert.equal(aiExecutionCanonicalSha256V2(first), aiExecutionCanonicalSha256V2(second));
});

test('v2 respinge valori non JSON e numeri non finiti', () => {
  for (const value of [NaN, Infinity, -Infinity, undefined, { bad: undefined }]) {
    assert.throws(() => canonicalAiExecutionJsonV2(value), /non JSON|undefined/);
  }
});
