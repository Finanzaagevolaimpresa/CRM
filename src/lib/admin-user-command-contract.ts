import { z } from 'zod';

export const adminUserOperation = z.enum(['CREATE', 'ROLE', 'ACTIVATE', 'DEACTIVATE', 'OVERRIDES', 'RESET_OVERRIDES',
  'PROFILE', 'PASSWORD_RESET', 'REMOVE', 'RESTORE', 'REVOKE_SESSIONS', 'REVOKE_SESSION', 'APPLY_ROLE_PROFILE']);
export type AdminUserOperation = z.infer<typeof adminUserOperation>;
export const adminUserCommandIdentity = z.object({ commandId: z.string().uuid(), operation: adminUserOperation,
  userId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/), expectedVersion: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export type AdminUserCommandIdentity = z.infer<typeof adminUserCommandIdentity>;
export type AdminUserCommandState = { ok: boolean; message: string; stepUpRequired?: boolean; uncertain?: boolean;
  closed?: boolean; userId?: string; commandId?: string };
export type AdminUserVersionInput = { id: string; name: string; email: string; role: string; active: boolean;
  deletedAt: Date | null; updatedAt: Date; permissionOverrides: { permission: string; allowed: boolean }[] };
