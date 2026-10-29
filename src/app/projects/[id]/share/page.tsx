export const dynamic = 'force-dynamic';
import { notFound } from 'next/navigation';
import { requireSession } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { mayManageSelectiveAccess } from '@/lib/selective-project-access';
import { SelectiveProjectSharing } from '@/components/selective-project-sharing';
import { filterFinancialDocuments } from '@/lib/financial-document-access';
import { selectiveSelectionSchema } from '@/lib/selective-project-policy';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!await mayManageSelectiveAccess(prisma, session)) notFound();
  const { id } = await params;
  const project = await prisma.project.findFirst({ where: { id, deletedAt: null, status: { not: 'archiviato' } } });
  if (!project || !await prisma.client.findFirst({ where: { id: project.clientId, deletedAt: null }, select: { id: true } })) notFound();
  const [recipients, candidates, grants] = await Promise.all([
    prisma.user.findMany({ where: { active: true, deletedAt: null, id: { not: session.userId } }, orderBy: [{ name: 'asc' }, { id: 'asc' }], select: { id: true, name: true, email: true, role: true } }),
    prisma.document.findMany({ where: { projectId: id, clientId: project.clientId, deletedAt: null, visibilityLevel: 'interno', mimeType: { in: ['application/pdf', 'text/plain', 'image/png', 'image/jpeg'] } } }),
    prisma.selectiveProjectGrant.findMany({ where: { projectId: id }, orderBy: { approvedAt: 'desc' }, select: { id: true, recipientId: true, revision: true, revokedAt: true, expiresAt: true, approvedAt: true, selection: true } }),
  ]);
  const lifecycle = await prisma.auditLog.findFirst({ where: { event: 'project_lifecycle_changed', entityType: 'Project', entityId: id }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
  const documents = await filterFinancialDocuments(prisma, { role: 'commerciale', active: true, permissionOverrides: [] }, candidates);
  const versions = await prisma.documentVersion.findMany({ where: { documentId: { in: documents.map(doc => doc.id) }, checksum: { not: null } }, orderBy: [{ documentId: 'asc' }, { version: 'desc' }] });
  const byId = new Map(documents.map(doc => [doc.id, doc]));
  return <div className="space-y-6"><h1 className="text-3xl font-bold">Condividi accesso — {project.title}</h1>
    <SelectiveProjectSharing projectId={id} recipients={recipients} documents={versions.flatMap(version => {
      const doc = byId.get(version.documentId);
      return doc ? [{ versionId: version.id, version: version.version, title: doc.title, fileName: doc.fileName }] : [];
    })} grants={grants.map(grant => {
      const selection = selectiveSelectionSchema.safeParse(grant.selection && typeof grant.selection === 'object' && !Array.isArray(grant.selection) ? grant.selection.input : null);
      return { id: grant.id, recipientId: grant.recipientId, revision: grant.revision, revoked: Boolean(grant.revokedAt), suspended: Boolean(lifecycle && lifecycle.createdAt >= grant.approvedAt), expiresAt: grant.expiresAt?.toISOString() ?? null,
        fields: selection.success ? selection.data.fields : [], documents: selection.success ? selection.data.documents : [] };
    })} />
  </div>;
}
