export const N15_SELF_CLAIM_SYNTHETIC_OPT_IN = 'N15_SYNTHETIC_SELF_CLAIM_V1' as const;
export const N15_SYNTHETIC_DATABASE_NAME = 'fai_crm_test' as const;
export const N15_SYNTHETIC_DATABASE_SENTINEL = 'FAI_CRM_EPHEMERAL_TEST_ONLY_V1' as const;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** Fail-closed process authority. This is deliberately not accepted from an HTTP/business input. */
export function isN15SyntheticSelfClaimAdmitted(
  environment: Readonly<Record<string, string | undefined>> = process.env,
) {
  const appEnvironment = environment.APP_ENV?.trim().toLowerCase();
  const nodeEnvironment = environment.NODE_ENV?.trim().toLowerCase();
  const qualifiedEnvironment = (appEnvironment === 'test' || appEnvironment === 'development')
    && (nodeEnvironment === 'test' || nodeEnvironment === 'development');
  if (!qualifiedEnvironment
    || environment.N15_SYNTHETIC_SELF_CLAIM_OPT_IN !== N15_SELF_CLAIM_SYNTHETIC_OPT_IN) return false;
  if (!(environment.RUN_DB_TESTS === '1'
    && environment.AI_ORCHESTRATOR_DB_TESTS_CONFIRMED === '1'
    && environment.AI_ORCHESTRATOR_DB_TEST_SENTINEL === N15_SYNTHETIC_DATABASE_SENTINEL
    && environment.DATABASE_URL)) throw new Error('N15_SYNTHETIC_DATABASE_CONFIGURATION_INVALID');
  try {
    const url = new URL(environment.DATABASE_URL);
    const valid = (url.protocol === 'postgresql:' || url.protocol === 'postgres:')
      && LOOPBACK_HOSTS.has(url.hostname.toLowerCase())
      && decodeURIComponent(url.pathname.replace(/^\//u, '')) === N15_SYNTHETIC_DATABASE_NAME;
    if (!valid) throw new Error('N15_SYNTHETIC_DATABASE_CONFIGURATION_INVALID');
    return true;
  } catch {
    throw new Error('N15_SYNTHETIC_DATABASE_CONFIGURATION_INVALID');
  }
}
