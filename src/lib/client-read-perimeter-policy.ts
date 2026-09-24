import type { RoleCode } from '@prisma/client';

export const perimeterRoles: readonly RoleCode[] = ['commerciale', 'consulente', 'backoffice', 'revisore', 'amministrazione', 'collaboratore_limitato'];
export type ClientReadScope = { clientReadScope?: readonly string[] };
export function hasClientReadGrant(actor: ClientReadScope & { role: RoleCode }, clientId?: string) {
  return !!clientId && perimeterRoles.includes(actor.role) && !!actor.clientReadScope?.includes(clientId);
}
