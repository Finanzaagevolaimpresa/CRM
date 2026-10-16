import { z } from 'zod';
import type { ProjectStatus } from '@prisma/client';

export type ProjectLifecycleState = 'active' | 'archived' | 'trash';
export type ProjectLifecycleAction = 'archive' | 'trash' | 'restore' | 'reactivate';
export const projectLifecycleSchema = z.object({
  id: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/),
  updatedAt: z.string().datetime(),
  action: z.enum(['archive', 'trash', 'restore', 'reactivate']),
  confirmed: z.literal('yes'),
}).strict();
export function projectLifecycleState(project: { status: ProjectStatus; deletedAt: Date | null }): ProjectLifecycleState {
  return project.deletedAt ? 'trash' : project.status === 'archiviato' ? 'archived' : 'active';
}
export function lifecycleActionAllowed(state: ProjectLifecycleState, action: ProjectLifecycleAction) {
  return (action === 'archive' && state === 'active') || (action === 'trash' && state !== 'trash')
    || (action === 'restore' && state === 'trash') || (action === 'reactivate' && state === 'archived');
}
export const lifecycleActionCopy: Record<ProjectLifecycleAction, { label: string; consequence: string }> = {
  archive: { label: 'Archivia', consequence: 'Il progetto e le risorse collegate non saranno disponibili nei percorsi ordinari. Documenti e collegamenti restano conservati. Le condivisioni richiederanno una nuova conferma personale dopo la riattivazione.' },
  trash: { label: 'Sposta nel cestino', consequence: 'Il progetto e le risorse collegate non saranno accessibili. Potrai ripristinarlo in archivio. Nessun documento o collegamento verrà cancellato.' },
  restore: { label: 'Ripristina in archivio', consequence: 'Il progetto torna in archivio e resta sospeso. Le concessioni precedenti non vengono riattivate; revoche e scadenze restano conservate.' },
  reactivate: { label: 'Riattiva come idea', consequence: 'Il progetto torna nei progetti operativi in stato Idea. I gestori già autorizzati potranno lavorarlo. Le condivisioni selettive richiedono una nuova anteprima e conferma personale.' },
};
