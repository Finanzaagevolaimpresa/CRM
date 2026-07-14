import { NextResponse } from 'next/server';
import { auditCommercialOfferExport } from '@/lib/actions';
import { canEditCommercialOffer } from '@/lib/access-control';
import { buildCommercialOfferDocx } from '@/lib/docx-export';
import { requirePermission } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';

function safeFileName(value: string) { return value.toLowerCase().replace(/[^a-z0-9-_]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'offerta-fai'; }
function leadName(lead: { companyName: string | null; firstName: string; lastName: string }) { return lead.companyName || `${lead.firstName} ${lead.lastName}`.trim(); }

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requirePermission('lead.read');
  const { id } = await params;
  const offer = await prisma.commercialOffer.findFirst({ where: { id, deletedAt: null } });
  if (!offer) return new NextResponse('Not found', { status: 404 });
  const [lead, client] = await Promise.all([
    offer.leadId ? prisma.lead.findFirst({ where: { id: offer.leadId, deletedAt: null } }) : null,
    offer.clientId ? prisma.client.findFirst({ where: { id: offer.clientId, deletedAt: null } }) : null,
  ]);
  if (!canEditCommercialOffer(session, { ...offer, lead, client })) return new NextResponse('Not found', { status: 404 });
  const docx = buildCommercialOfferDocx({
    title: offer.title,
    lead: lead ? { name: leadName(lead), email: lead.email, phone: lead.phone, interest: lead.interest } : null,
    client: client ? { displayName: client.displayName, type: client.type, status: client.status } : null,
    status: offer.status,
    description: offer.description,
    services: offer.services,
    includedActivities: offer.includedActivities,
    taxableAmount: Number(offer.taxableAmount),
    vatAmount: Number(offer.vatAmount),
    totalAmount: Number(offer.totalAmount),
    validUntil: offer.validUntil,
    operationalConditions: offer.operationalConditions,
    commercialProposal: offer.commercialProposal,
    exportedAt: new Date(),
  });
  await auditCommercialOfferExport(offer.id, 'docx');
  const party = client?.displayName || (lead ? leadName(lead) : offer.title);
  const date = new Date().toISOString().slice(0, 10);
  return new NextResponse(docx, { headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'Content-Disposition': `attachment; filename="${safeFileName(`offerta-fai-${party}-${date}`)}.docx"` } });
}
