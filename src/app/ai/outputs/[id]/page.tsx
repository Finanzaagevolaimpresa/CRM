import { Card, PageHeader, StatusBadge, TimestampMeta, formatDateTime } from '@/components/ui';
import { DisabledAction, PrimaryButton, SecondaryLink } from '@/components/actions';
import { prisma } from '@/lib/prisma';
import { hasPermission, requirePermission } from '@/lib/auth';
import { canViewClient } from '@/lib/access-control';
import { createClientDossierFromAiOutputAndRedirect } from '@/lib/form-actions';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const session = await requirePermission('ai.review');
  const { id } = await params;
  const output = await prisma.aiOutput.findUnique({ where: { id } });
  if (!output) return <h1 className="text-3xl font-bold text-fai-navy">Output AI non trovato</h1>;
  const [run, client, service, project, agent] = await Promise.all([
    prisma.aiRun.findUnique({ where: { id: output.aiRunId } }),
    output.clientId ? prisma.client.findUnique({ where: { id: output.clientId } }) : null,
    output.clientServiceId ? prisma.clientService.findUnique({ where: { id: output.clientServiceId } }) : null,
    output.projectId ? prisma.project.findUnique({ where: { id: output.projectId } }) : null,
    prisma.aiRun.findUnique({ where: { id: output.aiRunId } }).then((r) => r ? prisma.aiAgent.findUnique({ where: { id: r.agentId } }) : null),
  ]);
  if (client && !canViewClient(session, client)) return <h1 className="text-3xl font-bold text-fai-navy">Output AI non accessibile</h1>;
  const canCreateDossier = hasPermission(session, 'dossier.write');
  const canCreateFromOutput = canCreateDossier && !!client && output.status === 'approved';
  const createDisabledReason = !canCreateDossier ? 'Permesso dossier.write richiesto' : !client ? 'Output AI non collegato a un cliente' : output.status === 'archived' ? 'Output AI archiviato' : output.status !== 'approved' ? 'Output AI non ancora approvato/revisionato' : '';
  return <div className="space-y-6">
    <PageHeader title={output.title} description="Dettaglio output AI interno generato con provider mock e soggetto a revisione umana." />
    <div className="flex flex-wrap gap-2"><SecondaryLink href={client ? `/clients/${client.id}#output-ai` : '/ai/outputs-to-review'}>← Torna al fascicolo</SecondaryLink><StatusBadge status={output.status} /></div>
    <Card title="Contesto output">
      <div className="grid gap-3 text-sm md:grid-cols-2">
        <p><strong>Agente:</strong> {agent?.name ?? run?.agentId ?? '—'}</p>
        <p><strong>Generato il:</strong> {formatDateTime(output.createdAt)}</p>
        <p><strong>Cliente:</strong> {client?.displayName ?? '—'}</p>
        <p><strong>Pratica/servizio:</strong> {service?.practiceType ?? service?.id ?? 'Fascicolo generale'}</p>
        <p><strong>Progetto:</strong> {project?.title ?? '—'}</p>
        <p><strong>Revisione umana:</strong> {output.requiresHumanReview ? 'Obbligatoria' : 'Non richiesta'}</p>
      </div>
      <TimestampMeta createdAt={output.createdAt} updatedAt={output.updatedAt} />
    </Card>
    <Card title="Azione dossier">
      {canCreateFromOutput ? <form action={createClientDossierFromAiOutputAndRedirect} className="flex flex-wrap items-center gap-3"><input type="hidden" name="id" value={output.id}/><PrimaryButton type="submit">Crea bozza dossier da questo output</PrimaryButton><p className="text-sm text-slate-500">Verrà creata una bozza interna ClientDossier con metadati, output AI, nota di revisione e disclaimer FAI.</p></form> : <div className="flex flex-wrap items-center gap-3"><DisabledAction reason={createDisabledReason}>Crea bozza dossier da questo output</DisabledAction><p className="text-sm text-slate-500">{createDisabledReason}</p></div>}
    </Card>
    <Card title="Contenuto mock"><pre className="whitespace-pre-wrap text-sm leading-6 text-slate-700">{output.content}</pre></Card>
  </div>;
}
