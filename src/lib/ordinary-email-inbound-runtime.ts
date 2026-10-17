import type { PrismaClient } from '@prisma/client';
import type { connect } from 'node:tls';
import { z } from 'zod';
import type { PrivilegedStepUpKey } from './privileged-step-up-token';
import { inboundDescriptorSchema, inboundDenied, OrdinaryInboundIdle, type InboundDescriptor } from './ordinary-email-inbound-contract';
import { createOrdinaryImapInboundAdapter } from './ordinary-email-inbound-imap';
import { createOrdinaryMimeInboundSource } from './ordinary-email-inbound-mime';
import { receiveStoredOrdinaryEmail } from './ordinary-email-inbound-store';

export type OrdinaryRegisterInboundRuntime = {
  readEnvironment(): Readonly<Record<string, string | undefined>>;
  connectTls: typeof connect;
};
const registerDescriptor = inboundDescriptorSchema.extend({
  protocol: z.literal('IMAP_UID'), host: z.literal('pop.securemail.pro'), port: z.literal(993),
  folder: z.literal('INBOX'), authenticationReference: z.literal('DIRECT_EMAIL_TEST_SMTP_PASSWORD'),
  generation: z.string().regex(/^[1-9][0-9]{0,9}$/).refine(value => Number(value) <= 4_294_967_295),
}).strict();

/** This existing credential was confirmed as the mailbox password. Destination
 * and reference are fixed: a mutable database host cannot receive the secret.
 * Every admission reads the source again; configuration drift invalidates the
 * independent inbound HMAC. SMTP evidence is never an inbound qualification. */
export function createOrdinaryRegisterInboundSource(key: PrivilegedStepUpKey, descriptorInput: InboundDescriptor,
  runtime: OrdinaryRegisterInboundRuntime) {
  const descriptor = registerDescriptor.safeParse(descriptorInput);
  if (!descriptor.success) inboundDenied();
  return createOrdinaryMimeInboundSource(key, createOrdinaryImapInboundAdapter(() => {
    const environment = runtime.readEnvironment(), credential = environment.DIRECT_EMAIL_TEST_SMTP_PASSWORD;
    if (environment.DIRECT_EMAIL_TEST_MODE !== 'enforced'
      || environment.DIRECT_EMAIL_TEST_REFERENCE !== 'R49_EMAIL_DIRECT_20260930_01'
      || environment.DIRECT_EMAIL_TEST_SMTP_HOST !== 'authsmtp.securemail.pro'
      || !credential || !/^[\x20-\x7e]{1,4096}$/.test(credential)) inboundDenied();
    return { descriptor: descriptor.data, credential };
  }, { connectTls: runtime.connectTls }));
}

/** One explicitly invoked page. The native store owns all locks, admission,
 * qualification, expiry and atomic cursor advancement. No session is forged,
 * no stream is created/enabled and there is no loop or automatic retry. */
export async function receiveOrdinaryRegisterEmailOnce(db: Pick<PrismaClient, '$transaction' | '$queryRaw'>,
  streamId: string, key: PrivilegedStepUpKey, runtime: OrdinaryRegisterInboundRuntime) {
  try {
    z.string().uuid().parse(streamId);
    const [row] = await db.$queryRaw<Array<{ descriptor: InboundDescriptor }>>`
      SELECT "descriptor" FROM "OrdinaryEmailInboundStream" WHERE "id"=${streamId}::uuid`;
    if (!row) inboundDenied();
    const source = createOrdinaryRegisterInboundSource(key, row.descriptor, runtime);
    try {
      const result = await receiveStoredOrdinaryEmail(db, streamId, key, source);
      return { status: 'COMMITTED' as const, cursorVersion: result.cursorVersion,
        insertedCount: result.insertedCount, duplicateCount: result.duplicateCount, conflictCount: result.conflictCount };
    } catch (error) {
      if (error instanceof OrdinaryInboundIdle) return { status: 'IDLE' as const };
      throw error;
    }
  } catch { inboundDenied(); }
}
