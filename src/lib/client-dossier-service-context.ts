import type { Client, ClientService, Project } from '@prisma/client';

/** Apply the same relationship checks wherever a link points into the client dossier. */
export function dossierServiceContexts(
  client: Client,
  services: ClientService[],
  projects: ReadonlyMap<string, Project & { client: Client }>,
  companies: { has(id: string): boolean },
) {
  return services.flatMap(service => {
    const project = service.projectId ? projects.get(service.projectId) ?? null : null;
    if (service.deletedAt || service.clientId !== client.id || (service.projectId && !project)
      || (service.companyId && !companies.has(service.companyId))
      || (project?.companyId && !companies.has(project.companyId))
      || (service.companyId && project?.companyId && service.companyId !== project.companyId)) return [];
    return [{ ...service, client, project }];
  });
}
