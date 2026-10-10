import assert from 'node:assert/strict';

export function requireWpformsEdition(value: unknown): 'lite' | 'pro' {
  assert.ok(value === 'lite' || value === 'pro', 'VNX03_WPFORMS_EDITION_REQUIRED');
  return value;
}

export function assertWpformsSubmissionId(submissionId: string, edition: 'lite' | 'pro') {
  const expected = requireWpformsEdition(edition) === 'pro'
    ? /^WPFORM:900001:ENTRY:[1-9][0-9]*$/u
    : /^WPFORM:900001:EPHEMERAL:[0-9a-f]{32}$/u;
  assert.match(submissionId, expected, 'VNX03_SUBMISSION_ID_EDITION_MISMATCH');
}
