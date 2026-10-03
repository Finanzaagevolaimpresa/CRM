import type { Prisma } from '@prisma/client';

/** Load assignment context even when the actor cannot open the parent lists. */
export async function loadTechnicalPracticeAccessContext(
  db: Pick<Prisma.TransactionClient, 'client' | 'project' | 'clientService'>,
  practice: { clientId: string; projectId: string | null; clientServiceId: string | null },
) {
  const [client, project, service] = await Promise.all([
    db.client.findFirst({ where: { id: practice.clientId, deletedAt: null } }),
    practice.projectId ? db.project.findFirst({ where: { id: practice.projectId, deletedAt: null } }) : null,
    practice.clientServiceId ? db.clientService.findFirst({ where: { id: practice.clientServiceId, deletedAt: null } }) : null,
  ]);
  const serviceProject = service?.projectId
    ? service.projectId === project?.id ? project : await db.project.findFirst({ where: { id: service.projectId, deletedAt: null } })
    : null;
  return { client, project: project ? { ...project, client } : null,
    clientService: service ? { ...service, client, project: serviceProject ? { ...serviceProject, client } : null } : null };
}
