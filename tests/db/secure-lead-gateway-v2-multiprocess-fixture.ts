import { NextRequest } from 'next/server';
import { handleSecureLeadGatewayRequest } from '../../src/app/api/integrations/website/leads/v2/route';
import { canonicalJson } from '../../src/lib/canonical-json';
import { createLeadSubmittedEventV1 } from '../../src/lib/lead-event-contract';
import { prisma } from '../../src/lib/prisma';
import {
  createSecureLeadGatewaySignature,
  createSecureLeadGatewaySignedBytes,
  SECURE_LEAD_GATEWAY_PROTOCOL,
} from '../../src/lib/secure-lead-gateway-protocol';
import { syntheticLeadEventInputV1 } from '../fixtures/n10-lead-event-v1';
import {
  N12_SYNTHETIC_KEY_ID,
  N12_SYNTHETIC_NONCE,
  N12_SYNTHETIC_SECRET,
} from '../fixtures/n12-secure-lead-gateway-v2';

const [scenario, rawWorker, keyringPath, keyringRoot, timestamp] = process.argv.slice(2);
const worker = Number(rawWorker);
if (!['same', 'conflict', 'different'].includes(scenario)
  || !Number.isInteger(worker)
  || worker < 0
  || worker > 7
  || !keyringPath
  || !keyringRoot
  || !timestamp
  || !/^\d{10}$/u.test(timestamp)) process.exit(2);

function uuid(ordinal: number) {
  return `00000000-0000-4000-8000-${ordinal.toString(16).padStart(12, '0')}`;
}

function event(variant: number) {
  const input = syntheticLeadEventInputV1();
  if (variant === 0) return createLeadSubmittedEventV1(input);
  return createLeadSubmittedEventV1({
    ...input,
    eventId: uuid(80_000 + variant * 2),
    businessCorrelationId: uuid(80_001 + variant * 2),
    source: {
      ...input.source,
      submissionId: `N12-MULTIPROCESS-${variant}`,
    },
    payload: {
      ...input.payload,
      email: `multiprocess-${variant}@n12.invalid`,
      message: `Synthetic N12 multiprocess variant ${variant}.`,
    },
  });
}

function request() {
  const variant = scenario === 'conflict' ? worker % 2 : 0;
  const body = Buffer.from(canonicalJson(event(variant)), 'utf8');
  const nonce = scenario === 'different'
    ? worker.toString(16).padStart(32, '0')
    : N12_SYNTHETIC_NONCE;
  const signed = createSecureLeadGatewaySignedBytes({
    keyId: N12_SYNTHETIC_KEY_ID,
    timestamp,
    nonce,
  }, body);
  return new NextRequest(`http://local${SECURE_LEAD_GATEWAY_PROTOCOL.path}`, {
    method: 'POST',
    headers: {
      'content-type': SECURE_LEAD_GATEWAY_PROTOCOL.contentType,
      'content-length': String(body.byteLength),
      'x-fai-key-id': N12_SYNTHETIC_KEY_ID,
      'x-fai-timestamp': timestamp,
      'x-fai-nonce': nonce,
      'x-fai-signature': createSecureLeadGatewaySignature(N12_SYNTHETIC_SECRET, signed),
    },
    body,
    duplex: 'half',
  } as unknown as ConstructorParameters<typeof NextRequest>[1]);
}

async function main() {
  try {
    const result = await handleSecureLeadGatewayRequest(request(), {
      db: prisma,
      environment: {
        SECURE_LEAD_GATEWAY_MODE: 'enforced',
        FEATURE_INTEGRATIONS_ENABLED: 'true',
      },
      keyringPath,
      allowedKeyringRoot: keyringRoot,
    });
    process.stdout.write(JSON.stringify({ status: result.status }));
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch(() => {
  process.exitCode = 1;
});
