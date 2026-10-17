import assert from 'node:assert/strict';
import test from 'node:test';
import { ordinaryPreviewMatches, type OrdinaryEmailPreview } from '../src/lib/ordinary-email-ui-contract';

test('a preview returned after a concurrent edit or expiry cannot identify the older page revision', () => {
  const shown = { messageId: 'b2e84680-74d3-4665-a8f0-ddda82eed688', revision: 3, snapshotHash: 'a'.repeat(64) };
  const preview = { ...shown, sendAvailable: false, token: 'server-proof', expiresAt: '2026-10-16T18:00:00Z', summary: {
    from: 'comunicazioni@finanzaagevolaimpresa.it', replyTo: 'comunicazioni@finanzaagevolaimpresa.it', to: ['synthetic@invalid.test'],
    cc: [], bcc: [], subject: 'Synthetic', body: 'Synthetic', attachments: [] } } satisfies OrdinaryEmailPreview;
  const now = Date.parse('2026-10-16T17:59:59Z');
  assert.equal(ordinaryPreviewMatches(preview, shown, now), true);
  for (const changed of [{ revision: 4 }, { messageId: 'c2e84680-74d3-4665-a8f0-ddda82eed688' }, { snapshotHash: 'b'.repeat(64) },
    { expiresAt: '2026-10-16T17:59:59Z' }, { expiresAt: 'invalid' }]) assert.equal(ordinaryPreviewMatches({ ...preview, ...changed }, shown, now), false);
  assert.equal(ordinaryPreviewMatches(preview, shown, Number.NaN), false);
});
