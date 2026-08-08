import { createHash } from 'node:crypto';

const HASH_PATTERN = /^[0-9a-f]{64}$/;

function canonicalize(value: unknown, path: string): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`Valore numerico non JSON in ${path}.`);
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item, index) => canonicalize(item, `${path}[${index}]`)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`Oggetto non JSON in ${path}.`);
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => {
      const item = record[key];
      if (item === undefined) throw new TypeError(`Valore undefined non JSON in ${path}.${key}.`);
      return `${JSON.stringify(key)}:${canonicalize(item, `${path}.${key}`)}`;
    }).join(',')}}`;
  }
  throw new TypeError(`Valore non JSON in ${path}.`);
}

/** Stable JSON used only for hashes. Object keys are sorted; array order is preserved. */
export function canonicalJson(value: unknown) {
  return canonicalize(value, '$');
}

export function sha256(value: string) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function canonicalSha256(value: unknown) {
  return sha256(canonicalJson(value));
}

export function createAiRequestFingerprint(value: unknown) {
  return canonicalSha256(value);
}

export const AI_EXECUTION_HASH_CANONICALIZATION_VERSION = 2 as const;

/**
 * Dedicated JCS/ECMAScript canonicalization contract for PR86 authorization
 * bindings. Keep the legacy exports above byte-for-byte compatible with v1.
 */
export function canonicalAiExecutionJsonV2(value: unknown) {
  return canonicalize(value, '$');
}

function versionedAiExecutionValue(value: unknown) {
  return {
    hashCanonicalizationVersion: AI_EXECUTION_HASH_CANONICALIZATION_VERSION,
    value,
  };
}

export function aiExecutionCanonicalSha256V2(value: unknown) {
  return sha256(canonicalAiExecutionJsonV2(versionedAiExecutionValue(value)));
}

export function aiExecutionRequestFingerprintV2(value: unknown) {
  return aiExecutionCanonicalSha256V2(value);
}

export function assertSha256(value: string, label = 'Hash') {
  if (!HASH_PATTERN.test(value)) throw new TypeError(`${label} non valido.`);
  return value;
}
