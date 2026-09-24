import { z } from 'zod';

export const responsibilityKind = z.enum(['Lead', 'TechnicalPractice']);
export type ResponsibilityKind = z.infer<typeof responsibilityKind>;
const id = z.string().min(1).max(128), optionalId = id.nullable();
export const responsibilityState = z.object({
  clientId: optionalId, projectId: optionalId, clientServiceId: optionalId,
  commercialOwnerId: optionalId, technicalOwnerId: optionalId,
}).strict();
export const responsibilityDecision = z.object({
  type: z.literal('R05_RESPONSIBILITY_V1'), version: z.number().int().positive(),
  state: responsibilityState, departmentCode: z.string().trim().min(1).max(80).nullable(),
  allowed: z.boolean(), reason: z.string().min(3).max(500),
}).strict();
export const responsibilityAcceptance = z.object({
  type: z.literal('R05_RESPONSIBILITY_ACCEPTANCE_V1'), decisionId: id,
  role: z.enum(['commerciale', 'tecnico']), userId: id,
}).strict();
export type ResponsibilityState = z.infer<typeof responsibilityState>;
export const responsibilityEvents = ['responsibility_assigned', 'responsibility_accepted'] as const;
export function sameResponsibility(a: ResponsibilityState, b: ResponsibilityState) {
  return (Object.keys(a) as Array<keyof ResponsibilityState>).every(key => a[key] === b[key]);
}
