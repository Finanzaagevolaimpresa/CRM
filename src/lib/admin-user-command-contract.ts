import { z } from 'zod';
import { canonicalSha256 } from './canonical-json';

export const adminUserOperation = z.enum(['CREATE', 'ROLE', 'ACTIVATE', 'DEACTIVATE', 'OVERRIDES', 'RESET_OVERRIDES']);
export type AdminUserOperation = z.infer<typeof adminUserOperation>;
export const adminUserCommandIdentity = z.object({ commandId: z.string().uuid(), operation: adminUserOperation,
  userId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/), expectedVersion: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export type AdminUserCommandIdentity = z.infer<typeof adminUserCommandIdentity>;
export type AdminUserCommandState = { ok: boolean; message: string; stepUpRequired?: boolean; uncertain?: boolean;
  closed?: boolean; userId?: string; commandId?: string };
export type AdminUserVersionInput = { id: string; name: string; email: string; role: string; active: boolean;
  deletedAt: Date | null; permissionOverrides: { permission: string; allowed: boolean }[] };
export function adminUserVersion(user: AdminUserVersionInput | null) {
  return canonicalSha256(user ? { id: user.id, name: user.name, email: user.email, role: user.role, active: user.active,
    deletedAt: user.deletedAt?.toISOString() ?? null,
    overrides: user.permissionOverrides.map(({ permission, allowed }) => ({ permission, allowed })).sort((a, b) => a.permission.localeCompare(b.permission)) } : null);
}
