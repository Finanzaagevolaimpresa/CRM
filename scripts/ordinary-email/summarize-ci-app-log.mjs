import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

assert.equal(process.env.CI, 'true');
assert.equal(process.env.GITHUB_ACTIONS, 'true');
assert.equal(process.env.ORDINARY_EMAIL_BROWSER_CONFIRMED, '1');
assert.ok(process.env.RUNNER_TEMP);
const [source, ...extra] = process.argv.slice(2);
assert.equal(extra.length, 0);
assert.equal(path.resolve(source), path.resolve(process.env.RUNNER_TEMP, 'ordinary-secrets', 'app.log'));
const lines = readFileSync(source, 'utf8').split(/\r?\n/);
const summary = {
  synthetic: true,
  smtpReady: lines.includes('SYNTHETIC_SMTP_READY'),
  healthHttp200: lines.some(line => /^\s*GET \/api\/health 200\b/.test(line)),
  healthHttp503: lines.some(line => /^\s*GET \/api\/health 503\b/.test(line)),
  errorLines: lines.filter(line => /\b(?:Error|error)\b/.test(line)).length,
  actionArgumentLinesOmitted: lines.filter(line => /ƒ .*Action\(/.test(line)).length,
  sourceLines: lines.length,
};
// No source strings, arguments, URLs, identifiers or credentials are emitted.
console.log(JSON.stringify(summary));
