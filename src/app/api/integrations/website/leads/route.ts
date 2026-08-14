import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { authenticateWebsiteLead, readBoundedBody, runWebsiteLeadTransactionWithRetry, sha256, WebsiteLeadBodyError, WebsiteLeadDeadline, WebsiteLeadDeadlineError, websiteLeadMode } from '@/lib/website-lead-security';

const NAMESPACE = 'website-lead:legacy:v1';
const RECENT_DUPLICATE_DAYS = 30;
const optionalText = z.string().trim().max(1000).optional().nullable().transform((v) => v || undefined);
const websiteLeadSchema = z.object({
  firstName: optionalText, lastName: optionalText, companyName: optionalText,
  email: z.string().trim().email().max(254).optional().nullable().transform((v) => v?.toLowerCase() || undefined),
  phone: z.string().trim().max(50).optional().nullable().transform((v) => v ? v.replace(/\s+/g, '') : undefined),
  city: optionalText, region: optionalText, interest: optionalText,
  requestedAmount: z.union([z.number(), z.string().trim()]).optional().nullable(),
  message: z.string().trim().max(4000).optional().nullable().transform((v) => v || undefined),
  sourcePage: z.string().trim().max(500).optional().nullable().transform((v) => v || undefined),
  serviceInterest: optionalText, privacyAccepted: z.literal(true),
  marketingAccepted: z.boolean().optional().default(false), submittedAt: z.string().datetime({ offset: true }).optional().nullable(),
}).strict().refine((data) => data.email || data.phone);
type Input = z.infer<typeof websiteLeadSchema>;

const response = (status: number, body: Record<string, unknown> = { ok: false, message: status >= 500 ? 'Servizio non disponibile' : 'Richiesta non valida' }, headers?: HeadersInit) =>
  NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
const unavailable = () => response(503);

function requestedAmount(value: Input['requestedAmount']) {
  if (value === undefined || value === null || value === '') return undefined;
  const text = typeof value === 'number' ? String(value) : value.replace(/[^\d.,+-]/g, '');
  const normalized = text.includes(',') ? text.replace(/\./g, '').replace(',', '.') : text;
  const number = Number(normalized);
  return Number.isFinite(number) && number >= 0 ? new Prisma.Decimal(normalized) : null;
}
function notes(data: Input, duplicate: boolean) {
  return [duplicate ? 'Nuova richiesta sito web potenzialmente duplicata.' : 'Richiesta ricevuta dal sito web FAI.', data.message, data.serviceInterest, data.interest].filter(Boolean).join('\n');
}
function canonicalPayload(data: Input) {
  return `website-lead-payload:v1\n${JSON.stringify({ firstName:data.firstName,lastName:data.lastName,companyName:data.companyName,email:data.email,phone:data.phone,city:data.city,region:data.region,interest:data.interest,requestedAmount:data.requestedAmount,message:data.message,sourcePage:data.sourcePage,serviceInterest:data.serviceInterest,privacyAccepted:data.privacyAccepted,marketingAccepted:data.marketingAccepted,submittedAt:data.submittedAt })}`;
}
function boundedInteger(value: string | undefined, min: number, max: number) {
  return value && /^\d+$/.test(value) && Number(value) >= min && Number(value) <= max ? Number(value) : null;
}
async function consumeRateLimit(callerDigest: string, deadline: WebsiteLeadDeadline) {
  const limit = boundedInteger(process.env.WEBSITE_LEAD_RATE_LIMIT_REQUESTS, 1, 10_000);
  const seconds = boundedInteger(process.env.WEBSITE_LEAD_RATE_LIMIT_WINDOW_SECONDS, 1, 86_400);
  if (!limit || !seconds) return null;
  deadline.assertRemaining();
  const timeout = deadline.remainingMs();
  const rows = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('statement_timeout', ${String(timeout)}, true)`;
    const result = await tx.$queryRaw<Array<{ requestCount: number; retryAfter: number }>>(Prisma.sql`
    INSERT INTO "WebsiteLeadRateLimitBucket" ("namespace", "callerDigest", "windowStartedAt", "requestCount", "updatedAt")
    VALUES (${NAMESPACE}, ${callerDigest}, CURRENT_TIMESTAMP, 1, CURRENT_TIMESTAMP)
    ON CONFLICT ("namespace") DO UPDATE SET
      "callerDigest" = EXCLUDED."callerDigest",
      "windowStartedAt" = CASE WHEN "WebsiteLeadRateLimitBucket"."windowStartedAt" + make_interval(secs => ${seconds}) <= CURRENT_TIMESTAMP THEN CURRENT_TIMESTAMP ELSE "WebsiteLeadRateLimitBucket"."windowStartedAt" END,
      "requestCount" = CASE WHEN "WebsiteLeadRateLimitBucket"."windowStartedAt" + make_interval(secs => ${seconds}) <= CURRENT_TIMESTAMP THEN 1 ELSE "WebsiteLeadRateLimitBucket"."requestCount" + 1 END,
      "updatedAt" = CURRENT_TIMESTAMP
    RETURNING "requestCount", GREATEST(1, CEIL(EXTRACT(EPOCH FROM ("windowStartedAt" + make_interval(secs => ${seconds}) - CURRENT_TIMESTAMP))))::int AS "retryAfter"`);
    deadline.assertRemaining();
    return result;
  }, { maxWait: timeout, timeout });
  return { allowed: (rows[0]?.requestCount ?? limit + 1) <= limit, retryAfter: rows[0]?.retryAfter ?? seconds };
}
class Conflict extends Error {}
async function processLegacy(data: Input, keyDigest: string, payloadHash: string, deadline: WebsiteLeadDeadline) {
  return runWebsiteLeadTransactionWithRetry(deadline, async (timeout) =>
    prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('statement_timeout', ${String(timeout)}, true), set_config('lock_timeout', ${String(timeout)}, true)`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${NAMESPACE}:${keyDigest}`}, 0))`;
      const existing = await tx.websiteLeadReceipt.findUnique({ where: { namespace_keyDigest: { namespace: NAMESPACE, keyDigest } } });
      if (existing) { if (existing.payloadHash !== payloadHash) throw new Conflict(); deadline.assertRemaining(); return { replay: true, receipt: existing.id }; }
      const receipt = await tx.websiteLeadReceipt.create({ data: { namespace: NAMESPACE, keyDigest, payloadHash, status: 'processing' } });
      const identityDigests = [data.email && sha256(`email:${data.email}`), data.phone && sha256(`phone:${data.phone}`)].filter(Boolean).sort() as string[];
      for (const identityDigest of identityDigests) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${NAMESPACE}:${identityDigest}`}, 0))`;
      const duplicateSince = new Date(Date.now() - RECENT_DUPLICATE_DAYS * 86400000);
      const duplicateConditions: Prisma.Sql[] = [];
      if (data.email) duplicateConditions.push(Prisma.sql`LOWER("email") = ${data.email}`);
      if (data.phone) duplicateConditions.push(Prisma.sql`"phone" = ${data.phone}`);
      const lockedCandidates = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id" FROM "Lead"
        WHERE "deletedAt" IS NULL AND "createdAt" >= ${duplicateSince}
          AND (${Prisma.join(duplicateConditions, ' OR ')})
        ORDER BY "updatedAt" DESC, "id" ASC
        LIMIT 1 FOR UPDATE`);
      const duplicate = lockedCandidates[0] ? await tx.lead.findUnique({ where: { id: lockedCandidates[0].id } }) : null;
      const amount = requestedAmount(data.requestedAmount); if (amount === null) throw new Error('invalid_amount');
      const lead = duplicate ? await tx.lead.update({ where: { id: duplicate.id }, data: { notes: [duplicate.notes, notes(data, true)].filter(Boolean).join('\n\n---\n'), nextActionNote: 'Verificare nuova richiesta sito web potenzialmente duplicata', interest: duplicate.interest ?? data.serviceInterest ?? data.interest ?? data.message } }) : await tx.lead.create({ data: { firstName:data.firstName ?? 'Contatto',lastName:data.lastName ?? 'Sito web',companyName:data.companyName,contactPerson:[data.firstName,data.lastName].filter(Boolean).join(' ') || undefined,email:data.email,phone:data.phone,city:data.city,region:data.region,source:'finanzaagevolaimpresa.it',leadSource:'sito',priority:'media',status:'nuovo',interest:data.serviceInterest ?? data.interest ?? data.message,requestedAmount:amount,notes:notes(data,false),nextActionNote:'Contattare lead ricevuto dal sito web' } });
      await tx.auditLog.create({ data: { event: duplicate ? 'website_lead_duplicate_detected' : 'website_lead_received', entityType: 'Lead', entityId: lead.id, after: { mode:'legacy', outcome:duplicate ? 'updated' : 'created', contractVersion:'v1', receipt:receipt.id } } });
      await tx.websiteLeadReceipt.update({ where: { id: receipt.id }, data: { status:'completed', completedAt:new Date() } });
      deadline.assertRemaining();
      return { replay:false, receipt:receipt.id };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: timeout, timeout }));
}

export async function POST(request: NextRequest) {
  const deadline = new WebsiteLeadDeadline();
  const mode = websiteLeadMode();
  if (mode === 'disabled') return unavailable();
  const secret = request.headers.get('x-fai-webhook-secret');
  if (!authenticateWebsiteLead(process.env.WEBSITE_LEAD_WEBHOOK_SECRET, secret)) return response(401);
  if (mode === 'legacy') {
    try {
      const rate = await consumeRateLimit(sha256(process.env.WEBSITE_LEAD_WEBHOOK_SECRET!), deadline);
      if (!rate) return unavailable();
      if (!rate.allowed) return response(429, undefined, { 'Retry-After': String(rate.retryAfter) });
    } catch { return unavailable(); }
  }
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? '')) return response(400);
  deadline.assertRemaining();
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), deadline.remainingMs());
  try {
    const raw = await readBoundedBody(request, controller.signal);
    let json: unknown; try { json = JSON.parse(raw); } catch { return response(400); }
    const parsed = websiteLeadSchema.safeParse(json); if (!parsed.success || requestedAmount(parsed.data.requestedAmount) === null) return response(400);
    if (mode === 'shadow') return unavailable();
    const key = request.headers.get('idempotency-key');
    if (!key || key.length > 200 || !/^[\x21-\x7E]+$/.test(key)) return response(400);
    const result = await processLegacy(parsed.data, sha256(key), sha256(canonicalPayload(parsed.data)), deadline);
    deadline.assertRemaining();
    return response(result.replay ? 200 : 201, { ok:true, receipt:result.receipt });
  } catch (error) {
    if (error instanceof WebsiteLeadBodyError) return response(error.status);
    if (error instanceof Conflict) return response(409);
    if (error instanceof WebsiteLeadDeadlineError) return unavailable();
    return unavailable();
  } finally { clearTimeout(timer); }
}
