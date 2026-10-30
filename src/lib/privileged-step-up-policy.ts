/** The Admin window does not change the expiry of a decision or send preview. */
export const PRIVILEGED_STEP_UP_TTL_SECONDS = 5 * 60;
export const ADMIN_PRIVILEGED_STEP_UP_TTL_SECONDS = 30 * 60;

export function privilegedStepUpTtlSeconds(role: string | undefined) {
  return role === 'admin' ? ADMIN_PRIVILEGED_STEP_UP_TTL_SECONDS : PRIVILEGED_STEP_UP_TTL_SECONDS;
}
