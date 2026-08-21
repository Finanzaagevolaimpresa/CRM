import { NextRequest, NextResponse } from 'next/server';
import type { PrismaClient } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import {
  admitSecureLeadGatewayEvent,
  authenticateSecureLeadGatewayRequest,
  consumeSecureLeadGatewayRateLimit,
  isSecureLeadGatewayIntegrationEnabled,
  SecureLeadGatewayError,
} from '@/lib/secure-lead-gateway';
import {
  createSecureLeadGatewaySignedBytes,
  parseCanonicalSecureLeadGatewayEnvelope,
  readSecureLeadGatewayHeaders,
  readSecureLeadGatewayRawBody,
  secureLeadGatewayMode,
  SecureLeadGatewayDeadline,
  SecureLeadGatewayProtocolError,
} from '@/lib/secure-lead-gateway-protocol';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const responseHeaders = Object.freeze({
  'Cache-Control': 'no-store',
  Pragma: 'no-cache',
});

function errorResponse(
  status: 400 | 401 | 409 | 413 | 429 | 503,
  code: 'INVALID_REQUEST' | 'UNAUTHORIZED' | 'CONFLICT' | 'RATE_LIMITED'
    | 'TEMPORARILY_UNAVAILABLE',
  retryAfter: number | null = null,
) {
  const headers: Record<string, string> = { ...responseHeaders };
  if (status === 429 && retryAfter !== null) headers['Retry-After'] = String(retryAfter);
  return NextResponse.json({ ok: false, error: code }, { status, headers });
}

function unavailable() {
  return errorResponse(503, 'TEMPORARILY_UNAVAILABLE');
}

export async function handleSecureLeadGatewayRequest(
  request: NextRequest,
  options: {
    readonly db?: PrismaClient;
    readonly environment?: Readonly<Record<string, string | undefined>>;
    readonly keyringPath?: string;
    readonly allowedKeyringRoot?: string;
  } = {},
) {
  const db = options.db ?? prisma;
  const environment = options.environment ?? process.env;
  const deadline = new SecureLeadGatewayDeadline();
  const mode = secureLeadGatewayMode(environment.SECURE_LEAD_GATEWAY_MODE);
  if (mode === 'disabled') return unavailable();

  let integrationsEnabled = false;
  try {
    integrationsEnabled = await isSecureLeadGatewayIntegrationEnabled(
      db,
      deadline,
      environment,
    );
  } catch {
    return unavailable();
  }
  if (!integrationsEnabled) return unavailable();

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    deadline.assertRemaining();
    const headers = readSecureLeadGatewayHeaders(request);
    const controller = new AbortController();
    timer = setTimeout(() => controller.abort(), deadline.remainingMs());
    const rawBody = await readSecureLeadGatewayRawBody(
      request,
      controller.signal,
      headers.contentLength,
    );
    deadline.assertRemaining();
    const signedBytes = createSecureLeadGatewaySignedBytes(headers, rawBody);
    const key = await authenticateSecureLeadGatewayRequest(
      db,
      headers,
      signedBytes,
      deadline,
      {
        keyringPath: options.keyringPath,
        allowedKeyringRoot: options.allowedKeyringRoot,
      },
    );
    deadline.assertRemaining();

    if (mode === 'shadow') {
      parseCanonicalSecureLeadGatewayEnvelope(rawBody);
      deadline.assertRemaining();
      return unavailable();
    }

    const rate = await consumeSecureLeadGatewayRateLimit(
      db,
      key.producerCode,
      deadline,
    );
    if (!rate.allowed) return errorResponse(429, 'RATE_LIMITED', rate.retryAfter);
    deadline.assertRemaining();
    const event = parseCanonicalSecureLeadGatewayEnvelope(rawBody);
    const result = await admitSecureLeadGatewayEvent(db, {
      key,
      headers,
      signedBytes,
      event,
      deadline,
    });
    deadline.assertRemaining();
    return NextResponse.json(
      { ok: true, receipt: result.receipt },
      { status: 202, headers: responseHeaders },
    );
  } catch (error) {
    if (error instanceof SecureLeadGatewayProtocolError) {
      return errorResponse(error.status, error.code);
    }
    if (error instanceof SecureLeadGatewayError) {
      return errorResponse(error.status, error.code, error.retryAfter);
    }
    return unavailable();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function POST(request: NextRequest) {
  return handleSecureLeadGatewayRequest(request);
}
