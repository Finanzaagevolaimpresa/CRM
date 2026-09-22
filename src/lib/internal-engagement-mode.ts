/** Internal operation is a separate, explicit admission; synthetic guards stay intact. */
type EngagementEnvironment = {
  INTERNAL_ENGAGEMENT_MODE?: string;
  INTERNAL_SESSION_MODE?: string;
};

export function internalEngagementEnabled(env: EngagementEnvironment = process.env) {
  return env.INTERNAL_ENGAGEMENT_MODE === 'controlled'
    && env.INTERNAL_SESSION_MODE === 'registry';
}

export function engagementFeatureEnabled(value: string | undefined, env: EngagementEnvironment = process.env) {
  return value === 'synthetic' || (value === 'internal' && internalEngagementEnabled(env));
}
