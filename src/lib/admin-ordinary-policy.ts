export const ORDINARY_WINDOW_SECONDS = 24 * 60 * 60;
export const ORDINARY_IDLE_SECONDS = 60 * 60;
export const ordinaryCookie = 'fai_crm_admin_ordinary';
const actions = new Set(['N14_LEAD_INBOX_ASSIGN','N14_LEAD_INBOX_UNASSIGN','R05_ORDINARY_ASSIGNMENT']);
export function ordinaryWindowEnabled(value = process.env.ADMIN_ORDINARY_WINDOW_MODE) { return value === 'enabled'; }
export function ordinaryActionAllowed(action: string) { return actions.has(action); }
