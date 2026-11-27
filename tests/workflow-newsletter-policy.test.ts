import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseNativeNewsletterPolicy, readNativeNewsletterPolicy, readNewsletterWithdrawalCredential } from '../src/lib/workflow-newsletter-policy';
import { PROPOSED_POLICY } from '../src/lib/marketing-preferences/policy';

const key = Buffer.alloc(32, 123), now = new Date();
const manifest = { protocol: 'FAI_NEWSLETTER_NATIVE_POLICY_V1', policyVersion: PROPOSED_POLICY.version,
  approvalReference: 'SYNTHETIC_POLICY_APPROVAL', qualificationReference: 'SYNTHETIC_TRANSPORT_QUALIFICATION',
  effectiveFrom: new Date(now.getTime() - 60_000).toISOString(), effectiveUntil: new Date(now.getTime() + 60_000).toISOString(),
  purposeOpen: true, epoch: randomUUID(), keyFingerprint: createHash('sha256').update(key).digest('hex'), keyPath: '/synthetic/test-only',
  maxTicketAgeMs: 60_000, approvedEmailNotices: [{ noticeVersionId: randomUUID(), contentHash: 'a'.repeat(64) }],
  unsubscribeUrl: 'https://example.test/preferenze-email', unsubscribeQualificationReference: 'SYNTHETIC_WITHDRAWAL_QUALIFICATION' };
test('native marketing policy requires explicit exact authorization, key, time and withdrawal qualification', () => {
  assert.equal(parseNativeNewsletterPolicy(manifest, key, now).readiness.approvalReference, manifest.approvalReference);
  for (const change of [{ approvalReference: '' }, { qualificationReference: '' }, { unsubscribeQualificationReference: '' },
    { keyFingerprint: 'b'.repeat(64) }, { purposeOpen: false }, { unsubscribeUrl: 'http://example.test/' },
    { effectiveUntil: new Date(now.getTime() - 1).toISOString() }, { serviceIdentity: 'invented' }])
    assert.throws(() => parseNativeNewsletterPolicy({ ...manifest, ...change }, key, now));
  assert.throws(() => parseNativeNewsletterPolicy(manifest, Buffer.alloc(31), now));
});
test('native policy reader stays closed without explicit gate and private hash-bound POSIX files', async () => {
  const names = ['WORKFLOW_NATIVE_PREPARATION_MODE','WORKFLOW_MARKETING_WITHDRAWAL_MODE','APP_ORIGIN','WORKFLOW_NEWSLETTER_POLICY_FILE','WORKFLOW_NEWSLETTER_POLICY_SHA256'];
  const before = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    names.forEach(name => { delete process.env[name]; });
    await assert.rejects(readNativeNewsletterPolicy(now), /UNAVAILABLE/);
    process.env.WORKFLOW_NATIVE_PREPARATION_MODE = 'enabled';
    await assert.rejects(readNativeNewsletterPolicy(now), /UNAVAILABLE/);
    process.env.WORKFLOW_MARKETING_WITHDRAWAL_MODE = 'enabled'; process.env.APP_ORIGIN = 'https://example.test';
    const directory = await mkdtemp(join(tmpdir(), 'fai-newsletter-policy-test-'));
    const keyPath = join(directory, 'synthetic.key'), policyPath = join(directory, 'policy.json');
    const body = JSON.stringify({ ...manifest, keyPath });
    await writeFile(keyPath, key.toString('base64'), { mode: 0o600 }); await writeFile(policyPath, body, { mode: 0o600 });
    process.env.WORKFLOW_NEWSLETTER_POLICY_FILE = policyPath;
    process.env.WORKFLOW_NEWSLETTER_POLICY_SHA256 = createHash('sha256').update(body).digest('hex');
    if (process.platform === 'win32') { await assert.rejects(readNativeNewsletterPolicy(now), /UNAVAILABLE/); return; }
    assert.equal((await readNativeNewsletterPolicy(now)).readiness.epoch, manifest.epoch);
    delete process.env.WORKFLOW_NATIVE_PREPARATION_MODE;
    const closedBody = JSON.stringify({ ...manifest, keyPath, purposeOpen: false, effectiveUntil: new Date(now.getTime() - 1).toISOString() });
    await writeFile(policyPath, closedBody);
    process.env.WORKFLOW_NEWSLETTER_POLICY_SHA256 = createHash('sha256').update(closedBody).digest('hex');
    assert.equal((await readNewsletterWithdrawalCredential()).publicOrigin, 'https://example.test');
    await assert.rejects(readNativeNewsletterPolicy(now), /UNAVAILABLE/);
    process.env.WORKFLOW_NATIVE_PREPARATION_MODE = 'enabled';
    await assert.rejects(readNativeNewsletterPolicy(now), /UNAVAILABLE/);
    await writeFile(policyPath, body); process.env.WORKFLOW_NEWSLETTER_POLICY_SHA256 = createHash('sha256').update(body).digest('hex');
    await chmod(keyPath, 0o644); await assert.rejects(readNativeNewsletterPolicy(now), /UNAVAILABLE/);
    await chmod(keyPath, 0o600); await writeFile(keyPath, Buffer.alloc(32, 3).toString('base64'));
    await assert.rejects(readNativeNewsletterPolicy(now), /UNAVAILABLE/);
  } finally { for (const name of names) { if (before[name] === undefined) delete process.env[name]; else process.env[name] = before[name]; } }
});
