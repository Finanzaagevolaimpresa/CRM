import type { RoleCode } from '@prisma/client';
// Cross-record supervision is a read scope, never an operational permission.
export function hasGlobalReadAccess(actor: { role: RoleCode }) {
  return ['admin', 'direzione', 'amministrazione'].includes(actor.role);
}
