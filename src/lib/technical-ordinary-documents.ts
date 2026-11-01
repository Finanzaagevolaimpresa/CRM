import { lockTechnicalAssignmentContext } from './technical-assignment-context';
import type { Prisma, PrismaClient, DocumentVersion } from '@prisma/client';
import { z } from 'zod';
import type { AuthSession } from './auth';
import { canViewDocument, canViewProject, canViewTechnicalPractice } from './access-control';
import { lockAuthoritativeInternalSession } from './internal-session-registry';
import { lockCommunicationDirectory } from './communication-directory-lock';
import { internalSessionMode } from './session';
import { withSerializableTransaction } from './serializable';
import { loadClientReadScope } from './client-read-perimeter';
import { loadSelectiveProjectScope } from './selective-project-scope';
import { loadTechnicalPracticeAccessContext } from './technical-practice-access';
import { guardProjectResources } from './project-resource-guard';
import { hasPermission } from './permission-evaluator';
import { isTechnicalAccount } from './technical-confidentiality';
import { filterFinancialDocuments } from './financial-document-access';
import { technicalVersionDisclosuresAllowed } from './technical-document-disclosure';
import { privateDocumentExists } from './storage';

function denied(): never { throw new Error('TECHNICAL_DOCUMENT_LIST_UNAVAILABLE'); }
type Target = { kind: 'Project' | 'TechnicalPractice'; targetId: string };
/** Ordinary ownership is not a disclosure classification. This read exposes
 * only classified current versions with the same current ordinary scope as
 * the byte route. Personal/selective grants keep their dedicated version URLs. */
export async function listOrdinaryTechnicalDocuments(db: PrismaClient, claimed: AuthSession, target: Target) {
  z.object({ kind: z.enum(['Project', 'TechnicalPractice']), targetId: z.string().min(1).max(128) }).strict().parse(target);
  return withSerializableTransaction(db, async tx => {
    if (internalSessionMode() !== 'registry' || !z.string().uuid().safeParse(claimed.sessionId).success) denied();
    await lockCommunicationDirectory(tx);
    const live = await lockAuthoritativeInternalSession(tx, { userId: claimed.userId, sessionId: claimed.sessionId! });
    if (!live?.active || live.deletedAt || live.revokedAt || !live.live) denied();
    const actor = { ...claimed, role: live.role, active: live.active, technicalRestricted: live.technicalRestricted,
      permissionOverrides: [...live.permissionOverrides], clientReadScope: await loadClientReadScope(tx, claimed.userId),
      ...await loadSelectiveProjectScope(tx, claimed.userId) };
    if (!isTechnicalAccount(actor) || !hasPermission(actor, 'document.download')) denied();
    if (!await lockTechnicalAssignmentContext(tx, target)) denied();
    let clientId: string, projectId: string | null, serviceId: string | null = null;
    if (target.kind === 'Project') {
      const project = await tx.project.findUnique({ where: { id: target.targetId } });
      const client = project ? await tx.client.findUnique({ where: { id: project.clientId } }) : null;
      if (!project || !client || project.deletedAt || project.status === 'archiviato' || !canViewProject(actor, { ...project, client })) denied();
      clientId = project.clientId; projectId = project.id;
    } else {
      const practice = await tx.technicalPractice.findUnique({ where: { id: target.targetId } });
      if (!practice || practice.deletedAt || practice.status === 'archiviata'
        || !canViewTechnicalPractice(actor, { ...practice, ...await loadTechnicalPracticeAccessContext(tx, practice) })) denied();
      clientId = practice.clientId; projectId = practice.projectId; serviceId = practice.clientServiceId;
    }
    await guardProjectResources(tx, actor.userId, [{ clientId, projectId, clientServiceId: serviceId }]);
    const scopes: Prisma.DocumentWhereInput[] = [
      ...(projectId ? [{ projectId }] : []), ...(serviceId ? [{ clientServiceId: serviceId }] : []),
    ];
    if (!scopes.length) return { items: [], limited: false };
    const rows = await tx.document.findMany({ where: { clientId, OR: scopes, deletedAt: null, visibilityLevel: 'interno',
      status: { notIn: ['archiviato', 'respinto', 'scaduto'] } }, orderBy: { id: 'asc' }, take: 257 });
    if (rows.length > 256) return { items: [], limited: true };
    const ids = (values: Array<string | null>) => [...new Set(values.filter((id): id is string => !!id))];
    const services = await tx.clientService.findMany({ where: { id: { in: ids(rows.map(row => row.clientServiceId)) }, deletedAt: null } });
    const projects = await tx.project.findMany({ where: { id: { in: ids([...rows, ...services].map(row => row.projectId)) }, deletedAt: null, status: { not: 'archiviato' } } });
    const clients = new Map((await tx.client.findMany({ where: { id: { in: ids([...rows, ...services, ...projects].map(row => row.clientId)) }, deletedAt: null } })).map(row => [row.id, row]));
    const projectById = new Map(projects.map(row => [row.id, { ...row, client: clients.get(row.clientId) ?? null }]));
    const serviceById = new Map(services.map(row => [row.id, { ...row, client: clients.get(row.clientId) ?? null,
      project: row.projectId ? projectById.get(row.projectId) ?? null : null }]));
    const eligible = (await filterFinancialDocuments(tx, actor, rows))
      .filter(row => (!row.projectId || projectById.has(row.projectId)) && (!row.clientServiceId || serviceById.has(row.clientServiceId))
        && canViewDocument(actor, { ...row, client: row.clientId ? clients.get(row.clientId) ?? null : null,
          project: row.projectId ? projectById.get(row.projectId) ?? null : null,
          clientService: row.clientServiceId ? serviceById.get(row.clientServiceId) ?? null : null }, hasPermission(actor, 'document.sensitive.read')));
    const documentIds = eligible.map(row => row.id);
    if (!documentIds.length) return { items: [], limited: false };
    await guardProjectResources(tx, actor.userId, documentIds.map(documentId => ({ documentId })));
    await tx.$queryRawUnsafe('SELECT id FROM "Document" WHERE id=ANY($1::text[]) ORDER BY id FOR SHARE', documentIds);
    const versions = await tx.$queryRawUnsafe<DocumentVersion[]>('SELECT v.* FROM "Document" d JOIN LATERAL (SELECT * FROM "DocumentVersion" v WHERE v."documentId"=d.id AND v."storagePath"=d."storagePath" AND v.checksum=d.checksum ORDER BY v.version DESC LIMIT 1) v ON true WHERE d.id=ANY($1::text[])', documentIds);
    const entries = versions.map(version => ({ document: eligible.find(row => row.id === version.documentId)!, version }));
    const allowed = await technicalVersionDisclosuresAllowed(tx, actor, entries);
    const items = [];
    for (const { document, version } of entries) {
      if (!allowed.has(version.id)) continue;
      // Availability never grants access; the byte route rechecks independently.
      if (!await privateDocumentExists(version.storagePath)) continue;
      items.push({ id: document.id, versionId: version.id, version: version.version,
        title: document.title, fileName: document.fileName, validUntil: document.validUntil });
    }
    const [clock] = await tx.$queryRawUnsafe<Array<{ now: Date }>>('SELECT clock_timestamp() AS now');
    if (!clock || !Number.isFinite(claimed.expiresAt) || claimed.expiresAt * 1000 <= clock.now.getTime() || live.expiresAt <= clock.now) denied();
    return { items: items.filter(row => !row.validUntil || row.validUntil > clock.now).map(({ validUntil, ...row }) => { void validUntil; return row; }), limited: false };
  });
}
