import assert from 'node:assert/strict';
import test from 'node:test';
import { engagementFeatureEnabled, internalEngagementEnabled } from '../src/lib/internal-engagement-mode';

test('internal engagement stays closed without both explicit admission and registry sessions', () => {
  for (const mode of [undefined, '', 'true', 'synthetic', 'disabled', 'controlled ']) {
    assert.equal(internalEngagementEnabled({ INTERNAL_ENGAGEMENT_MODE: mode, INTERNAL_SESSION_MODE: 'registry' }), false);
    assert.equal(engagementFeatureEnabled('internal', { INTERNAL_ENGAGEMENT_MODE: mode, INTERNAL_SESSION_MODE: 'registry' }), false);
  }
  for (const session of [undefined, 'legacy', 'REGISTRY', 'registry '])
    assert.equal(engagementFeatureEnabled('internal', { INTERNAL_ENGAGEMENT_MODE: 'controlled', INTERNAL_SESSION_MODE: session }), false);
});

test('feature modes require explicit internal selection and preserve the separate synthetic path', () => {
  const env = { INTERNAL_ENGAGEMENT_MODE: 'controlled', INTERNAL_SESSION_MODE: 'registry' };
  assert.equal(engagementFeatureEnabled('internal', env), true);
  for (const mode of [undefined, '', 'enabled', 'production', 'true', 'INTERNAL'])
    assert.equal(engagementFeatureEnabled(mode, env), false);
  assert.equal(engagementFeatureEnabled('synthetic', {}), true);
});
