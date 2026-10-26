import { randomUUID } from 'node:crypto';
import { notFound } from 'next/navigation';
import { z } from 'zod';
import { PageHeader } from '@/components/ui';
import { SecondaryLink } from '@/components/actions';
import { TechnicalPrivateItemForm, TechnicalPrivateItemRecovery } from '@/components/technical-private-item-form';
import { requireSession } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { technicalTargetReference, technicalManagementPath, type TechnicalTargetReference } from '@/lib/technical-assignment-display';
import { loadTechnicalPrivateItemCreationContext } from '@/lib/technical-private-item-service';
import { preparePrivateTechnicalItem, savePrivateTechnicalItem, checkPrivateTechnicalItem } from '@/lib/technical-private-item-actions';

export async function TechnicalPrivateItemPage({ target: raw, query }: { target: TechnicalTargetReference; query: { privateItemDecision?: string } }) {
  const session = await requireSession(), target = technicalTargetReference.safeParse(raw);
  const recover = query.privateItemDecision ? z.string().uuid().safeParse(query.privateItemDecision) : null;
  if (!target.success || (recover && !recover.success)) notFound();
  const data = await loadTechnicalPrivateItemCreationContext(prisma, session, target.data).catch(() => null);
  if (!data) notFound();
  return <div className="min-w-0 space-y-6"><PageHeader title="Nuova attività o checklist privata"
    description="Prepara il lavoro per questo progetto o pratica. Dopo la creazione scegli separatamente le persone e le operazioni consentite." />
    <SecondaryLink href={technicalManagementPath(data.target)}>Torna agli incarichi tecnici</SecondaryLink>
    {recover?.success ? <TechnicalPrivateItemRecovery target={data.target} commandId={recover.data} action={checkPrivateTechnicalItem} />
      : <TechnicalPrivateItemForm {...data} initialCommandId={randomUUID()} initialItemId={randomUUID()}
        previewAction={preparePrivateTechnicalItem} confirmAction={savePrivateTechnicalItem} receiptAction={checkPrivateTechnicalItem} />}
  </div>;
}
