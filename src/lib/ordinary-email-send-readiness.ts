export type OrdinaryEmailUiChannel = { mailboxId: string; mailboxAddress: string };

/** Explanation only. Matching this hint never authorizes preview or SMTP DATA. */
export function ordinaryEmailSenderNotice(input: {
  isAdmin: boolean; selectedMailboxId: string; selectedAddress: string;
  authority: OrdinaryEmailUiChannel | null | undefined;
}) {
  if (!input.isAdmin) return null;
  if (input.authority?.mailboxId === input.selectedMailboxId
    && input.authority.mailboxAddress === input.selectedAddress) return null;
  return {
    reason: input.authority ? 'DIFFERENT_QUALIFIED_SENDER' as const : 'NO_CURRENT_CHANNEL' as const,
    selectedAddress: input.selectedAddress,
    availableAddress: input.authority?.mailboxAddress ?? null,
  };
}
