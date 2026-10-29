export type UploadContextQuery = { clientId?: unknown; projectId?: unknown; clientServiceId?: unknown };
export type WritableDocumentContext = { clients: Array<{ id: string; generalUploadAllowed?: boolean }>;
  projects: Array<{ id: string; clientId: string }>; services: Array<{ id: string; clientId: string; projectId?: string | null }> };
export class DocumentUploadContextError extends Error { constructor() { super('DOCUMENT_CONTEXT_UNAVAILABLE'); } }

/** Query values only select from already authorized choices; they never confer access. */
export function selectDocumentUploadContext(query: UploadContextQuery, allowed: WritableDocumentContext) {
  const validId = (value: unknown) => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
  if (!validId(query.clientId) || (query.projectId !== undefined && !validId(query.projectId))
    || (query.clientServiceId !== undefined && !validId(query.clientServiceId))) throw new DocumentUploadContextError();
  const client = allowed.clients.find(row => row.id === query.clientId);
  const project = query.projectId === undefined ? null : allowed.projects.find(row => row.id === query.projectId && row.clientId === query.clientId);
  const service = query.clientServiceId === undefined ? null : allowed.services.find(row => row.id === query.clientServiceId && row.clientId === query.clientId);
  if (!client || project === undefined || service === undefined || (project && service?.projectId && service.projectId !== project.id)
    || (client.generalUploadAllowed === false && !project && !service)) throw new DocumentUploadContextError();
  return { clientId: client.id, projectId: project?.id ?? '', clientServiceId: service?.id ?? '' };
}
