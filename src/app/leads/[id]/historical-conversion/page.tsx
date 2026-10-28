import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { requirePermission } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { PageHeader } from '@/components/ui';
import { SecondaryLink } from '@/components/actions';
import { CommercialLeadHistoricalConversion, HistoricalConversionReceipt } from '@/components/commercial-lead-historical-conversion';
import { readHistoricalLeadContactManagement, readHistoricalLeadConversionOutcome } from '@/lib/commercial-lead-historical-contact-storage';
import { prepareHistoricalConversionAction, saveHistoricalConversionAction, checkHistoricalConversionAction } from '@/lib/commercial-lead-historical-actions';
import type { HistoricalConversionViewReceipt } from '@/lib/commercial-lead-historical-view';

export const dynamic = 'force-dynamic';
export default async function Page({ params, searchParams }: {
  params: Promise<{ id: string }>; searchParams: Promise<{ historicalConversionCommand?: string | string[] }>;
}) {
  const session = await requirePermission('lead.read'), { id } = await params, query = await searchParams;
  const requested = query.historicalConversionCommand === undefined ? null : z.string().uuid().safeParse(query.historicalConversionCommand);
  if (requested && !requested.success) return <PageHeader title="Riferimento della conversione non valido" description="Riprendi la decisione originale senza avviarne una nuova." />;
  let scope;
  let completed: HistoricalConversionViewReceipt | null = null;
  try {
    if (!session.sessionId) throw new Error('N14_HISTORY_UNAVAILABLE');
    const actor = { userId: session.userId, sessionId: session.sessionId };
    if (requested?.success) {
      const result = await readHistoricalLeadConversionOutcome(prisma, actor, { leadId: id, commandId: requested.data });
      if (result.state === 'CONVERTED') completed = { commandId: requested.data,
        clientId: result.clientId, recordedAt: result.recordedAt, basis: result.basis };
    }
    if (!completed) scope = await readHistoricalLeadContactManagement(prisma, actor, id);
  } catch {
    scope = undefined;
    completed = null;
  }
  if (completed) return <HistoricalConversionReceipt receipt={completed} />;
  if (!scope?.canCreateClient || !scope.receipt) {
    return <PageHeader title="Conversione storica non disponibile" description="Servono il referente corrente con presa in carico, il contatto precedente registrato e i permessi correnti sul cliente. Un esito incerto va riconciliato senza ripetere il salvataggio." />;
  }
  return <div className="crm-space-y-6 min-w-0"><PageHeader title="Registra il cliente già contattato" description="Una decisione distinta dal contatto, senza modificare la data della prima risposta." />
    <SecondaryLink href={`/leads/${id}`}>Torna al lead</SecondaryLink>
    <CommercialLeadHistoricalConversion context={{ leadId: id, leadLabel: scope.leadLabel, commandId: randomUUID(),
      expectedInboxVersion: scope.expectedInboxVersion, expectedAssignmentId: scope.expectedAssignmentId,
      contactId: scope.receipt.id, recoverCommandId: requested?.success ? requested.data : undefined }}
      previewAction={prepareHistoricalConversionAction} confirmAction={saveHistoricalConversionAction} outcomeAction={checkHistoricalConversionAction} />
  </div>;
}
