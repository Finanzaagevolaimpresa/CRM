export const applicationFeatureGateCodes = [
  'INTEGRATIONS',
  'CUSTOMER_PORTAL',
  'PAYMENTS',
  'AI_WORKER',
  'AI_DISPATCH',
  'AI_EGRESS',
] as const;

export type ApplicationFeatureGateCode = (typeof applicationFeatureGateCodes)[number];
export type ContainmentMode = 'disabled' | 'enforced';
export type SecurityHeadersMode = 'report-only' | 'enforced';

const featureEnvironmentNames: Record<ApplicationFeatureGateCode, string> = {
  INTEGRATIONS: 'FEATURE_INTEGRATIONS_ENABLED',
  CUSTOMER_PORTAL: 'FEATURE_CUSTOMER_PORTAL_ENABLED',
  PAYMENTS: 'FEATURE_PAYMENTS_ENABLED',
  AI_WORKER: 'FEATURE_AI_WORKER_ENABLED',
  AI_DISPATCH: 'FEATURE_AI_DISPATCH_ENABLED',
  AI_EGRESS: 'FEATURE_AI_EGRESS_ENABLED',
};

export class ApplicationSecurityConfigurationError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export function containmentMode(value: string | undefined, name: string): ContainmentMode {
  if (value === 'disabled' || value === 'enforced') return value;
  throw new ApplicationSecurityConfigurationError(`${name}_NOT_CANONICAL`);
}

export function privilegedAccessMode(value = process.env.PRIVILEGED_ACCESS_MODE) {
  return containmentMode(value, 'PRIVILEGED_ACCESS_MODE');
}

export function loginThrottleMode(value = process.env.LOGIN_THROTTLE_MODE) {
  return containmentMode(value, 'LOGIN_THROTTLE_MODE');
}

export function securityHeadersMode(value = process.env.SECURITY_HEADERS_MODE): SecurityHeadersMode {
  return value === 'enforced' ? 'enforced' : 'report-only';
}

export function environmentFeatureGateEnabled(
  code: ApplicationFeatureGateCode,
  environment: Readonly<Record<string, string | undefined>> = process.env,
) {
  return environment[featureEnvironmentNames[code]] === 'true';
}

export function featureEnvironmentName(code: ApplicationFeatureGateCode) {
  return featureEnvironmentNames[code];
}

function canonicalOrigin(value: string | undefined) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    if (url.pathname !== '/' || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function isAllowedMutationOrigin(input: {
  origin: string | null | undefined;
  configuredOrigin: string | undefined;
  secFetchSite?: string | null;
}) {
  const expected = canonicalOrigin(input.configuredOrigin);
  const received = canonicalOrigin(input.origin ?? undefined);
  if (!expected || !received || expected !== received) return false;
  return !input.secFetchSite || input.secFetchSite === 'same-origin';
}

export const contentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "media-src 'none'",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
].join('; ');

export function applicationSecurityHeaders(mode = securityHeadersMode()) {
  return [
    {
      key: mode === 'enforced' ? 'Content-Security-Policy' : 'Content-Security-Policy-Report-Only',
      value: contentSecurityPolicy,
    },
    { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'Referrer-Policy', value: 'no-referrer' },
    {
      key: 'Permissions-Policy',
      value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()',
    },
    { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
    { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
    { key: 'X-Permitted-Cross-Domain-Policies', value: 'none' },
  ] as const;
}
