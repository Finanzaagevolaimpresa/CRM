import type { Permission } from './permissions';

export const privilegedAccessPermissions = [
  'user.write',
  'ai_agents.write',
  'settings.manage',
  'ai.execution.approve',
  'ai.execution.reject',
  'ai.execution.revoke',
  'ai.orchestrator.configure',
] as const satisfies readonly Permission[];
