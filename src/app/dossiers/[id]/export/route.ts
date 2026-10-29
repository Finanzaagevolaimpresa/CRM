import { NextResponse } from 'next/server';
import { createHash } from 'node:crypto';
import { getSession, requirePermission, hasPermission } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { getLegacyDossierReadAccess } from '@/lib/read-access';
import { buildMarkdownDocx } from '@/lib/docx-export';
import { canonicalSha256 } from '@/lib/canonical-json';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await requirePermission('dossier.read'), { id } = await params;
  const context = await getLegacyDossierReadAccess(actor, id);
  if (!context) return new NextResponse('Non disponibile', { status: 404 });
  const format = new URL(request.url).searchParams.get('format') ?? 'docx';
  if (!['docx', 'markdown'].includes(format)) return new NextResponse('Formato non disponibile', { status: 400 });
  const { dossier } = context, at = new Date();
  const content = [
    '# ' + dossier.title,
    'Documento interno di lavoro · versione ' + dossier.version + ' · stato ' + dossier.status,
    'Esportazione: ' + at.toISOString(),
    '',
    dossier.markdownContent ?? '',
    dossier.jsonContent == null ? '' : '\n## Dati strutturati\n' + JSON.stringify(dossier.jsonContent, null, 2),
  ].join('\n');
  const bytes = format === 'docx' ? buildMarkdownDocx({ title: dossier.title, content, exportedAt: at }) : Buffer.from(content, 'utf8');
  // An export does not widen the parent scope or survive a revoked session.
  const current = await getSession();
  const checked = current && current.userId === actor.userId && hasPermission(current, 'dossier.read')
    ? await getLegacyDossierReadAccess(current, id) : null;
  if (!checked || canonicalSha256(JSON.parse(JSON.stringify(checked.dossier))) !== canonicalSha256(JSON.parse(JSON.stringify(dossier)))) return new NextResponse('Scheda variata o accesso non disponibile', { status: 409 });
  const digest = createHash('sha256').update(bytes).digest('hex');
  await prisma.auditLog.create({ data: { actorId: actor.userId, event: 'legacy_dossier_export', entityType: 'Dossier', entityId: id,
    after: { format, version: dossier.version, contentHash: digest, sourceUpdatedAt: dossier.updatedAt.toISOString() } } });
  const name = dossier.title.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'dossier';
  return new NextResponse(bytes, { headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
    'Content-Type': format === 'docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'text/markdown; charset=utf-8',
    'Content-Disposition': 'attachment; filename="' + name + '-v' + dossier.version + (format === 'docx' ? '.docx' : '.md') + '"',
    'X-Dossier-Version': String(dossier.version), 'X-Dossier-Content-Hash': digest } });
}
