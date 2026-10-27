// Only known in-app destinations may follow personal identity confirmation.
export function securityReturnPath(value: unknown): '/leads/inbox' | null {
  return value === 'lead-inbox' ? '/leads/inbox' : null;
}
