export const dynamic = 'force-dynamic';
import { notFound } from 'next/navigation';
import { Card, PageHeader } from '@/components/ui';
import { PrimaryButton, SecondaryLink } from '@/components/actions';
import { requirePermission } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { createEngagementDossierAction } from '@/lib/engagement-dossier-actions';
import { listAccessiblePracticeReadiness } from '@/lib/practice-readiness';

export default async function Page({ params, searchParams }: { params: Promise<{ practiceId: string }>; searchParams: Promise<{ dossierError?: string }> }) {
  const { practiceId } = await params; const session = await requirePermission('dossier.write');
  const { dossierError } = await searchParams;
  const practice = (await listAccessiblePracticeReadiness(prisma, session)).find((row) => row.id === practiceId);
  if (!practice?.startedAt || !practice.projectId || !practice.clientServiceId) notFound();
  const preanalyses = await prisma.preAnalysis.findMany({ where: { clientId: practice.clientId, projectId: practice.projectId }, orderBy: { updatedAt: 'desc' } });
  if (!preanalyses.length) return <div className="space-y-6"><PageHeader title="Nuovo dossier di pratica" description="Serve una preanalisi manuale nello stesso progetto prima di creare il dossier."/><SecondaryLink href={`/preanalyses/new?clientId=${practice.clientId}&projectId=${practice.projectId}`}>Crea preanalisi</SecondaryLink></div>;
  void session;
  return <div className="space-y-6"><PageHeader title="Nuovo dossier di pratica" description="Crea la prima versione collegata alla pratica già avviata. Nessuna consegna viene effettuata automaticamente."/>{dossierError ? <p className="rounded-xl bg-red-50 p-3 font-semibold text-red-700">Operazione non completata ({dossierError}). Verifica stato, ambito e riferimenti.</p> : null}<Card title="Contenuto iniziale"><form action={createEngagementDossierAction} className="grid gap-3"><input type="hidden" name="practiceReadinessId" value={practice.id}/><label>Preanalisi<select name="preAnalysisId" className="w-full rounded-xl border p-3">{preanalyses.map((p) => <option key={p.id} value={p.id}>{p.internalSummary?.slice(0,80) || `Preanalisi ${p.id}`}</option>)}</select></label><label>Titolo<input name="title" required maxLength={200} className="w-full rounded-xl border p-3"/></label><label>Contenuto<textarea name="content" required className="min-h-96 w-full rounded-xl border p-3 font-mono"/></label><PrimaryButton type="submit">Crea dossier versionato</PrimaryButton></form></Card></div>;
}
