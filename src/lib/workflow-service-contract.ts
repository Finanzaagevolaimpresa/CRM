import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { canonicalSha256, canonicalJson } from './canonical-json';
import { workflowEvents } from './workflow-automation-contract';

const uuid = z.string().uuid(), hash = z.string().regex(/^[a-f0-9]{64}$/);
export const serviceInvocationInput = z.object({ protocol: z.literal('FAI_WORKFLOW_SERVICE_INVOCATION_V1'),
  id: uuid, grantId: uuid, issuedAt: z.string().datetime(), expiresAt: z.string().datetime(), limit: z.number().int().min(1).max(50) }).strict();
export type ServiceInvocation = z.infer<typeof serviceInvocationInput>;
export type ServiceCredentialMaterial = Readonly<{ id: string; key: Uint8Array }>;
export const serviceGrantInput = z.object({ id: uuid, automationId: uuid, expectedVersion: z.number().int().positive(), credentialId: uuid,
  validFrom: z.string().datetime(), validUntil: z.string().datetime(), maxMessages: z.number().int().min(1).max(100000),
  maxPerDay: z.number().int().min(1).max(100000), approvalReference: z.string().trim().min(8).max(200),
  approved: z.literal(true) }).strict();
export const serviceCredentialInput = z.object({ id: uuid, keyFingerprint: hash, validUntil: z.string().datetime(),
  qualificationReference: z.string().trim().min(8).max(200), approved: z.literal(true) }).strict();
export const servicePolicySchema = z.object({ protocol: z.literal('FAI_WORKFLOW_SERVICE_POLICY_V1'),
  automationId: uuid, automationVersion: z.number().int().positive(), ruleHash: hash,
  event: z.enum(workflowEvents), action: z.enum(['EMAIL','INTERNAL_NOTICE']), templateHashes: z.array(z.object({ id: uuid, version: z.number().int().positive(), hash }).strict()).min(1).max(2),
  authorityRevision: z.number().int().positive(), mailboxId: uuid, mailboxRevision: z.number().int().positive(), channelRevision: z.number().int().positive(),
  qualificationReference: z.string().min(1), credentialId: uuid, credentialRevision: z.number().int().positive(), keyFingerprint: hash,
  approvalReference: z.string().min(8).max(200), scope: z.literal('LEAD_ONLY_ONE_RECIPIENT_NO_ATTACHMENTS'),
  newsletterPolicyHash: hash.nullable() }).strict();
export type ServicePolicy = z.infer<typeof servicePolicySchema>;
export const serviceFingerprint = (key: Uint8Array) => createHash('sha256').update(key).digest('hex');
export function serviceMac(domain: 'invocation'|'decision', value: unknown, key: Uint8Array) {
  if (key.length !== 32) throw new Error('WORKFLOW_SERVICE_KEY_INVALID');
  return createHmac('sha256',key).update('FAI_WORKFLOW_SERVICE_V1\0' + domain + '\0' + canonicalJson(value)).digest('hex');
}
export function verifyServiceMac(domain: 'invocation'|'decision', value: unknown, proof: string, key: Uint8Array) {
  if (!hash.safeParse(proof).success || !timingSafeEqual(Buffer.from(proof,'hex'),Buffer.from(serviceMac(domain,value,key),'hex')))
    throw new Error('WORKFLOW_SERVICE_PROOF_INVALID');
}
export function parseServiceInvocation(raw: unknown, proof: string, key: Uint8Array, now: Date) {
  const input = serviceInvocationInput.parse(raw), from = Date.parse(input.issuedAt), until = Date.parse(input.expiresAt);
  verifyServiceMac('invocation',input,proof,key);
  if (from > now.getTime() || now.getTime() >= until || until <= from || until-from > 300000)
    throw new Error('WORKFLOW_SERVICE_INVOCATION_EXPIRED');
  return { input, requestHash: canonicalSha256(input) };
}
