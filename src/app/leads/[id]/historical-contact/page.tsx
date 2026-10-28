import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { requirePermission } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { PageHeader } from '@/components/ui';
import { SecondaryLink } from '@/components/actions';
import { CommercialLeadHistoricalContact } from '@/components/commercial-lead-historical-contact';
import { readHistoricalLeadContactManagement } from '@/lib/commercial-lead-historical-contact-storage';
import { prepareHistoricalContactAction, saveHistoricalContactAction, checkHistoricalContactAction } from '@/lib/commercial-lead-historical-actions';

export const dynamic = 'force-dynamic';
export default async function Page({ params, searchParams }: {
  params: Promise<{ id: string }>; searchParams: Promise<{ historicalContactCommand?: string | string[] }>;
}) {
  const session = await requirePermission('lead.read'), { id } = await params, query = await searchParams;
  let scope;
  try {
    if (!session.sessionId) throw new Error('N14_HISTORY_UNAVAILABLE');
    scope = await readHistoricalLeadContactManagement(prisma, { userId: session.userId, sessionId: session.sessionId }, id);
  } catch {
    return <PageHeader title="Contatto precedente non disponibile" description="Il percorso richiede il referente commerciale corrente, la sua presa in carico e un lead manuale aperto senza una prima risposta già registrata." />;
  }
  const requested = query.historicalContactCommand === undefined ? null : z.string().uuid().safeParse(query.historicalContactCommand);
  if (requested && !requested.success) return <PageHeader title="Riferimento della decisione non valido" description="Non avviare un nuovo salvataggio. Riprendi il riferimento della decisione originale." />;
  const recoverCommandId = requested?.success ? requested.data : scope.receipt?.id;
  const initialReceipt = scope.receipt?.id === recoverCommandId ? scope.receipt : null;
  return <div className="crm-space-y-6 min-w-0">
    <PageHeader title="Registra un contatto precedente" description="Mantieni distinte la data dell’evento reale e quella di registrazione nel CRM." />
    <SecondaryLink href={`/leads/${id}`}>Torna al lead</SecondaryLink>
    <CommercialLeadHistoricalContact context={{ leadId: scope.leadId, leadLabel: scope.leadLabel,
      commandId: randomUUID(), expectedInboxVersion: scope.expectedInboxVersion, expectedAssignmentId: scope.expectedAssignmentId,
      initializedAt: scope.initializedAt, recoverCommandId }} initialReceipt={initialReceipt}
      conversionHref={scope.canCreateClient ? `/leads/${id}/historical-conversion` : undefined}
      previewAction={prepareHistoricalContactAction} confirmAction={saveHistoricalContactAction} outcomeAction={checkHistoricalContactAction} />
  </div>;
}
