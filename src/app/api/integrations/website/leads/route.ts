import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';

const MAX_PAYLOAD_BYTES = 16 * 1024;
const RECENT_DUPLICATE_DAYS = 30;

const optionalText = z.string().trim().max(1000).optional().nullable().transform((value) => value || undefined);
const phoneSchema = z.string().trim().max(50).optional().nullable().transform((value) => value ? value.replace(/\s+/g, '') : undefined);

const websiteLeadSchema = z.object({
  firstName: optionalText,
  lastName: optionalText,
  companyName: optionalText,
  email: z.string().trim().email().max(254).optional().nullable().transform((value) => value?.toLowerCase() || undefined),
  phone: phoneSchema,
  city: optionalText,
  region: optionalText,
  interest: optionalText,
  requestedAmount: z.union([z.number(), z.string().trim()]).optional().nullable(),
  message: z.string().trim().max(4000).optional().nullable().transform((value) => value || undefined),
  sourcePage: z.string().trim().max(500).optional().nullable().transform((value) => value || undefined),
  serviceInterest: optionalText,
  privacyAccepted: z.literal(true),
  marketingAccepted: z.boolean().optional().default(false),
  submittedAt: z.string().datetime({ offset: true }).optional().nullable(),
}).refine((data) => data.email || data.phone, { message: 'contact_required' });

type WebsiteLeadInput = z.infer<typeof websiteLeadSchema>;

function genericError(status: number) {
  return NextResponse.json({ ok: false, message: status >= 500 ? 'Errore temporaneo del servizio' : 'Richiesta non valida' }, { status });
}

function normalizeRequestedAmount(value: Exclude<WebsiteLeadInput['requestedAmount'], null | undefined>) {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? String(value) : null;

  const withoutCurrency = value.replace(/[^\d.,+-]/g, '');
  if (!withoutCurrency || withoutCurrency === '-' || withoutCurrency === '+') return null;

  const lastComma = withoutCurrency.lastIndexOf(',');
  const lastDot = withoutCurrency.lastIndexOf('.');
  const decimalSeparator = lastComma > lastDot ? ',' : lastDot > lastComma ? '.' : null;

  if (!decimalSeparator) return withoutCurrency.replace(/[^\d+-]/g, '');

  const separatorCount = (withoutCurrency.match(new RegExp(`\\${decimalSeparator}`, 'g')) ?? []).length;
  if (separatorCount === 1) {
    const [integerPart, decimalPart] = withoutCurrency.split(decimalSeparator);
    if (decimalPart.length > 0 && decimalPart.length <= 2) {
      return `${integerPart.replace(/[^\d+-]/g, '')}.${decimalPart.replace(/[^\d]/g, '')}`;
    }
  }

  const digitsOnly = withoutCurrency.replace(/[^\d+-]/g, '');
  return digitsOnly || null;
}

function parseRequestedAmount(value: WebsiteLeadInput['requestedAmount']) {
  if (value === undefined || value === null || value === '') return undefined;
  const normalized = normalizeRequestedAmount(value);
  if (!normalized) return null;
  const amount = Number(normalized);
  return Number.isFinite(amount) && amount >= 0 ? new Prisma.Decimal(normalized) : null;
}

function buildNotes(data: WebsiteLeadInput, duplicate = false) {
  const rows = [
    duplicate ? 'Nuova richiesta dal sito web rilevata come possibile duplicato.' : 'Richiesta ricevuta dal sito web FAI.',
    data.message ? `Messaggio: ${data.message}` : null,
    data.sourcePage ? `Pagina origine: ${data.sourcePage}` : null,
    data.serviceInterest ? `Servizio richiesto: ${data.serviceInterest}` : null,
    data.interest ? `Interesse dichiarato: ${data.interest}` : null,
    `Privacy accettata: ${data.privacyAccepted ? 'sì' : 'no'}`,
    `Marketing accettato: ${data.marketingAccepted ? 'sì' : 'no'}`,
    data.submittedAt ? `Data invio sito: ${data.submittedAt}` : null,
    data.region ? `Regione: ${data.region}` : null,
    data.requestedAmount !== undefined && data.requestedAmount !== null && data.requestedAmount !== '' ? `Importo richiesto originale: ${data.requestedAmount}` : null,
  ].filter(Boolean);
  return rows.join('\n');
}

function auditDetails(data: WebsiteLeadInput) {
  return {
    source: 'website',
    email: data.email,
    phonePresent: Boolean(data.phone),
    sourcePage: data.sourcePage,
    serviceInterest: data.serviceInterest,
    privacyAccepted: data.privacyAccepted,
    marketingAccepted: data.marketingAccepted,
    submittedAt: data.submittedAt,
  };
}

export async function POST(request: NextRequest) {
  const configuredSecret = process.env.WEBSITE_LEAD_WEBHOOK_SECRET;
  const receivedSecret = request.headers.get('x-fai-webhook-secret');
  if (!configuredSecret || !receivedSecret || receivedSecret !== configuredSecret) return genericError(401);

  const contentLength = request.headers.get('content-length');
  if (contentLength && Number(contentLength) > MAX_PAYLOAD_BYTES) return genericError(413);

  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return genericError(400);
  }
  if (Buffer.byteLength(rawBody, 'utf8') > MAX_PAYLOAD_BYTES) return genericError(413);

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return genericError(400);
  }

  const parsed = websiteLeadSchema.safeParse(body);
  if (!parsed.success) return genericError(400);
  const data = parsed.data;
  const requestedAmount = parseRequestedAmount(data.requestedAmount);
  if (requestedAmount === null) return genericError(400);

  try {
    const duplicateSince = new Date(Date.now() - RECENT_DUPLICATE_DAYS * 24 * 60 * 60 * 1000);
    const duplicateChecks: Prisma.LeadWhereInput[] = [];
    if (data.email) duplicateChecks.push({ email: { equals: data.email, mode: 'insensitive' } });
    if (data.phone) duplicateChecks.push({ phone: data.phone });

    const duplicate = await prisma.lead.findFirst({
      where: {
        deletedAt: null,
        createdAt: { gte: duplicateSince },
        OR: duplicateChecks,
      },
      orderBy: { updatedAt: 'desc' },
    });

    if (duplicate) {
      const duplicateNotes = buildNotes(data, true);
      const lead = await prisma.lead.update({
        where: { id: duplicate.id },
        data: {
          notes: [duplicate.notes, duplicateNotes].filter(Boolean).join('\n\n---\n'),
          nextActionNote: 'Verificare nuova richiesta sito web potenzialmente duplicata',
          interest: duplicate.interest ?? data.serviceInterest ?? data.interest ?? data.message,
        },
      });
      await prisma.auditLog.create({ data: { event: 'website_lead_duplicate_detected', entityType: 'Lead', entityId: lead.id, after: auditDetails(data) as Prisma.InputJsonValue } });
      return NextResponse.json({ ok: true, duplicate: true, leadId: lead.id }, { status: 200 });
    }

    const lead = await prisma.lead.create({
      data: {
        firstName: data.firstName ?? 'Contatto',
        lastName: data.lastName ?? 'Sito web',
        companyName: data.companyName,
        contactPerson: [data.firstName, data.lastName].filter(Boolean).join(' ') || undefined,
        email: data.email,
        phone: data.phone,
        city: data.city,
        region: data.region,
        source: 'finanzaagevolaimpresa.it',
        leadSource: 'sito',
        priority: 'media',
        status: 'nuovo',
        interest: data.serviceInterest ?? data.interest ?? data.message,
        requestedAmount,
        notes: buildNotes(data),
        nextActionNote: 'Contattare lead ricevuto dal sito web',
      },
    });
    await prisma.auditLog.create({ data: { event: 'website_lead_received', entityType: 'Lead', entityId: lead.id, after: auditDetails(data) as Prisma.InputJsonValue } });
    return NextResponse.json({ ok: true, leadId: lead.id }, { status: 201 });
  } catch {
    return genericError(503);
  }
}
