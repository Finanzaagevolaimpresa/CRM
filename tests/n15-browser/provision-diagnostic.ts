import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const admittedPrismaCodes = new Set(['P2002', 'P2003', 'P2004', 'P2021']);

export function classifyProvisionFailure(error: unknown) {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && admittedPrismaCodes.has(code)) return `PRISMA_${code}`;
    if (typeof code === 'string' && /^P\d{4}$/u.test(code)) return 'PRISMA_OTHER';
  }
  return 'N15_BROWSER_PROVISION_FAILED';
}

export function writeProvisionFailureReceipt(directory: string | undefined, error: unknown) {
  if (!directory) return;
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'provision.json'), `${JSON.stringify({
    phase: 'provision',
    status: 'FAILED',
    code: classifyProvisionFailure(error),
  })}\n`, { mode: 0o600 });
}
