/** Internal operation is a separate, explicit admission; synthetic guards stay intact. */
export function internalEngagementEnabled(env: NodeJS.ProcessEnv = process.env) {
  return env.INTERNAL_ENGAGEMENT_MODE === 'controlled'
    && env.INTERNAL_SESSION_MODE === 'registry';
}

export function engagementFeatureEnabled(value: string | undefined, env: NodeJS.ProcessEnv = process.env) {
  return value === 'synthetic' || (value === 'internal' && internalEngagementEnabled(env));
}
