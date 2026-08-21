import { canonicalJson } from '../../src/lib/canonical-json';
import {
  createSecureLeadGatewaySignature,
  createSecureLeadGatewaySignedBytes,
  SECURE_LEAD_GATEWAY_PROTOCOL,
} from '../../src/lib/secure-lead-gateway-protocol';
import { SYNTHETIC_LEAD_EVENT_V1 } from './n10-lead-event-v1';

export const N12_SYNTHETIC_KEY_ID = 'synthetic-wordpress-v1';
export const N12_SYNTHETIC_PRODUCER_CODE = 'SYNTHETIC_WORDPRESS';
export const N12_SYNTHETIC_SECRET = Buffer.from(
  '1111111111111111111111111111111111111111111111111111111111111111',
  'hex',
);
export const N12_SYNTHETIC_TIMESTAMP = String(
  Math.trunc(Date.parse('2026-08-21T12:00:00.000Z') / 1_000),
);
export const N12_SYNTHETIC_NONCE = '0123456789abcdef0123456789abcdef';
export const N12_SYNTHETIC_BODY = Buffer.from(
  canonicalJson(SYNTHETIC_LEAD_EVENT_V1),
  'utf8',
);

export function syntheticSecureLeadGatewayRequest(
  overrides: {
    readonly body?: Uint8Array;
    readonly keyId?: string;
    readonly timestamp?: string;
    readonly nonce?: string;
    readonly signature?: string;
    readonly path?: string;
    readonly contentType?: string;
    readonly contentEncoding?: string;
    readonly contentLength?: string;
  } = {},
) {
  const body = Buffer.from(overrides.body ?? N12_SYNTHETIC_BODY);
  const signedHeaders = {
    keyId: overrides.keyId ?? N12_SYNTHETIC_KEY_ID,
    timestamp: overrides.timestamp ?? N12_SYNTHETIC_TIMESTAMP,
    nonce: overrides.nonce ?? N12_SYNTHETIC_NONCE,
  };
  const signedBytes = createSecureLeadGatewaySignedBytes(signedHeaders, body);
  const signature = overrides.signature
    ?? createSecureLeadGatewaySignature(N12_SYNTHETIC_SECRET, signedBytes);
  const headers = new Headers({
    'content-type': overrides.contentType ?? SECURE_LEAD_GATEWAY_PROTOCOL.contentType,
    'content-length': overrides.contentLength ?? String(body.byteLength),
    'x-fai-key-id': signedHeaders.keyId,
    'x-fai-timestamp': signedHeaders.timestamp,
    'x-fai-nonce': signedHeaders.nonce,
    'x-fai-signature': signature,
  });
  if (overrides.contentEncoding !== undefined) {
    headers.set('content-encoding', overrides.contentEncoding);
  }
  return new Request(
    `http://local${overrides.path ?? SECURE_LEAD_GATEWAY_PROTOCOL.path}`,
    { method: 'POST', headers, body, duplex: 'half' } as RequestInit,
  );
}
