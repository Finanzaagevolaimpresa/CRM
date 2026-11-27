import assert from 'node:assert/strict';
import test from 'node:test';
import type { PrismaClient } from '@prisma/client';
import { NextRequest } from 'next/server';
import { middleware } from '../src/middleware';
import { marketingWithdrawalHandlers } from '../src/lib/workflow-marketing-withdrawal';

test('public withdrawal is unavailable by default without consulting credentials or the database', async () => {
  const old = process.env.WORKFLOW_MARKETING_WITHDRAWAL_MODE;
  try {
    delete process.env.WORKFLOW_MARKETING_WITHDRAWAL_MODE;
    const handlers = marketingWithdrawalHandlers({} as PrismaClient, async () => { throw new Error('CREDENTIAL_MUST_NOT_BE_READ'); });
    assert.equal((await handlers.GET(new Request('https://example.test/preferenze-email'))).status, 503);
    assert.equal((await handlers.POST(new Request('https://example.test/preferenze-email', { method: 'POST' }))).status, 503);
  } finally {
    if (old === undefined) delete process.env.WORKFLOW_MARKETING_WITHDRAWAL_MODE; else process.env.WORKFLOW_MARKETING_WITHDRAWAL_MODE = old;
  }
});

test('only the exact preference route bypasses the CRM login perimeter', async () => {
  for (const path of ['/preferenze-email', '/preferenze-email/']) {
    const response = await middleware(new NextRequest('https://example.test' + path));
    assert.equal(response.headers.get('x-middleware-next'), '1');
  }
  for (const path of ['/preferenze-email-admin', '/preferenze-email/clienti', '/leads', '/notifications']) {
    const response = await middleware(new NextRequest('https://example.test' + path));
    assert.equal(response.status, 307);
    assert.equal(new URL(response.headers.get('location')!).pathname, '/login');
  }
});
