import { canonicalSha256 } from './canonical-json';
import type { AdminUserVersionInput } from './admin-user-command-contract';

export function adminUserVersion(user: AdminUserVersionInput | null) {
  return canonicalSha256(user ? { id: user.id, name: user.name, email: user.email, role: user.role, active: user.active,
    deletedAt: user.deletedAt?.toISOString() ?? null, updatedAt: user.updatedAt.toISOString(),
    overrides: user.permissionOverrides.map(({ permission, allowed }) => ({ permission, allowed })).sort((a, b) => a.permission.localeCompare(b.permission)) } : null);
}
