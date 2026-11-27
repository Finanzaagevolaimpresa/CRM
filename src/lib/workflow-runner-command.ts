import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import type { AuthSession } from './auth';
import { resolveInternalSession } from './internal-session-registry';
import { internalSessionMode } from './session';
import { loadClientReadScope } from './client-read-perimeter';
import { loadSelectiveProjectScope } from './selective-project-scope';
import { prepareWorkflowPendingOnce } from './workflow-native-runner';
import { prepareNativeWorkflowNewsletter } from './workflow-newsletter-native';

const input = z.object({
  sessionToken: z.string().min(32).max(2048),
  mailboxId: z.string().uuid().optional(), replyTo: z.string().email().max(254).optional(),
  automationId: z.string().uuid().optional(), limit: z.number().int().min(1).max(50).default(20),
  newsletterRunId: z.string().uuid().optional(),
}).strict().refine(value => Boolean(value.mailboxId) === Boolean(value.replyTo))
  .refine(value => !value.newsletterRunId || (Boolean(value.mailboxId) && !value.automationId));

/** A one-shot invocation uses the same genuine login session as the UI. No
 * user/session identifiers, rule author or OS account can substitute its token.
 * This module creates no identity, approval, sender authority, timer or socket. */
export async function runWorkflowPreparationCommand(db: PrismaClient, raw: unknown) {
  if (process.env.WORKFLOW_NATIVE_PREPARATION_MODE !== 'enabled' || internalSessionMode() !== 'registry')
    throw new Error('WORKFLOW_RUNNER_DENIED');
  const { sessionToken, ...command } = input.parse(raw);
  const registry = await resolveInternalSession(db, sessionToken);
  if (!registry || registry.user.role !== 'admin' || registry.user.technicalRestricted)
    throw new Error('WORKFLOW_RUNNER_DENIED');
  const session: AuthSession = {
    userId: registry.userId, sessionId: registry.id, expiresAt: Math.floor(registry.expiresAt.getTime() / 1000),
    role: registry.user.role, active: registry.user.active, technicalRestricted: registry.user.technicalRestricted,
    permissionOverrides: registry.user.permissionOverrides,
    clientReadScope: await loadClientReadScope(db, registry.userId),
    ...await loadSelectiveProjectScope(db, registry.userId),
  };
  // The native runner revalidates session/user/permissions and current sender
  // authority inside each transaction, including after a concurrent revocation.
  if (command.newsletterRunId) {
    const result = await prepareNativeWorkflowNewsletter(db, session, { runId: command.newsletterRunId,
      mailboxId: command.mailboxId!, replyTo: command.replyTo! });
    return { status: 'PREPARED' as const, examined: result.examined, prepared: result.prepared, held: 0, providerCalls: 0 as const };
  }
  const individualCommand = { mailboxId: command.mailboxId, replyTo: command.replyTo, automationId: command.automationId, limit: command.limit };
  const result = await prepareWorkflowPendingOnce(db, session, individualCommand);
  return { status: result.results.some(row => row.error) ? 'REVIEW_REQUIRED' : 'PREPARED',
    examined: result.results.length, prepared: result.prepared,
    held: result.results.filter(row => row.error).length, providerCalls: result.providerCalls } as const;
}

/** Credential-bearing input is bounded and never included in diagnostics. */
export async function readWorkflowPreparationInput(stream: AsyncIterable<Uint8Array | string>) {
  const parts: Buffer[] = []; let bytes = 0;
  for await (const chunk of stream) {
    const part = Buffer.from(chunk); bytes += part.length;
    if (bytes > 16_384) throw new Error('WORKFLOW_RUNNER_INPUT_DENIED');
    parts.push(part);
  }
  if (!bytes) throw new Error('WORKFLOW_RUNNER_INPUT_DENIED');
  return input.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts))));
}
