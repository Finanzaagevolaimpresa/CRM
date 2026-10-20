import { z } from 'zod';

const id = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/);
export const contractActivitiesCommand = z.object({
  commandId: z.string().uuid(), clientId: id, contractId: id,
  activities: z.string().trim().min(1).max(5000), confirmed: z.literal(true),
}).strict();
export type ContractActivitiesCommand = z.infer<typeof contractActivitiesCommand>;
export type ContractActivitiesPreview = {
  digest: string; client: string; contract: string; service: string; activities: string; project: string | null;
};
export class ContractActivitiesError extends Error {
  constructor(readonly code: 'DENIED' | 'STALE' | 'INVALID' | 'CLOSED') { super(code); }
}
