import Link from 'next/link';
import { notFound } from 'next/navigation';
import { z } from 'zod';
import { requireSession } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { readProjectHandoff } from '@/lib/project-handoff';
import { ProjectHandoffForm } from '@/components/project-handoff-form';
import { Card, PageHeader, StatusBadge } from '@/components/ui';
import { SecondaryLink } from '@/components/actions';
export const dynamic = 'force-dynamic';
export default async function Page({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ command?: string }> }) {
  const session = await requireSession(), { id } = await params, query = await searchParams;
  if (session.role !== 'admin') notFound();
  const resume = query.command ? z.string().uuid().safeParse(query.command) : null;
  if (resume && !resume.success) notFound();
  const setup = await readProjectHandoff(prisma, session, id).catch(() => null);
  if (!setup) notFound();
  return <div className="crm-space-y-6"><PageHeader title="Passaggio all’Ufficio Tecnico" description="Apri la pratica collegata o prepara il contesto iniziale dal progetto."/>
    <SecondaryLink href={`/projects/${id}`}>← Torna al progetto</SecondaryLink>
    {setup.practices.length > 0 && <Card title="Pratiche già collegate"><p>Non occorre creare un’altra pratica. Scegli quella pertinente; le pratiche archiviate richiedono il loro percorso di gestione.</p>
      <ul className="crm-space-y-3">{setup.practices.map(p => <li key={p.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border p-3">
        <span>{p.title} · <StatusBadge status={p.status}/></span>{p.available ? <Link className="font-bold underline" href={`/technical-office/practices/${p.id}`}>Apri pratica</Link> : <span>Archiviata o nel cestino</span>}</li>)}</ul></Card>}
    {(setup.practices.length === 0 || resume?.success) && <Card title={resume?.success ? 'Verifica preparazione precedente' : 'Prepara pratica'}>
      <ProjectHandoffForm setup={setup} resumeCommandId={resume?.success ? resume.data : undefined}/></Card>}
  </div>;
}
