import { notFound } from 'next/navigation';
import { requireSession } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { readSharedOperationalPanel } from '@/lib/shared-operational-updates';
import { sharedUpdateTarget } from '@/lib/shared-operational-update-contract';
import { SharedOperationalPanel } from '@/components/shared-operational-panel';
import { PageHeader } from '@/components/ui';
import { withTechnicalPage } from '@/lib/technical-surface-guards';
export const dynamic = 'force-dynamic';
async function Page({ params }: { params: Promise<{ kind: string; id: string }> }) {
  const session = await requireSession(), input = await params;
  const parsed = sharedUpdateTarget.safeParse({ kind: input.kind.toUpperCase(), id: input.id });
  if (!parsed.success) notFound();
  const admitted = await readSharedOperationalPanel(prisma, session, parsed.data).catch(() => null);
  if (!admitted) notFound();
  return <div><PageHeader title="Aggiornamento operativo" description="Scheda condivisa nel perimetro corrente; nessun accesso aggiuntivo a documenti o dati riservati." />
    <SharedOperationalPanel target={parsed.data} actorId={session.userId} /></div>;
}
export default withTechnicalPage('/operational-updates/[kind]/[id]', Page);
