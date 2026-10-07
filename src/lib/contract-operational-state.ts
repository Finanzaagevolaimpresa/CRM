import type { Contract, Payment } from '@prisma/client';
import { financialReadAccess, type FinancialActor } from './financial-access';

type ContractState = Pick<Contract, 'id' | 'clientId' | 'status' | 'signedAt' | 'signedDocumentId'>;
type PaymentState = Pick<Payment, 'contractId' | 'clientId' | 'status' | 'collectedAt' | 'accountingDocumentId'>;

// This describes the next verification, never grants permission to start work.
// A database status or a linked ID alone is not documentary payment evidence.
export function contractOperationalState(contract: ContractState, payments: readonly PaymentState[], now = new Date()) {
  if (['annullato', 'archiviato', 'non_firmato'].includes(contract.status)) return 'CLOSED' as const;
  if (contract.status !== 'firmato' || !contract.signedAt || contract.signedAt > now || !contract.signedDocumentId) return 'SIGNATURE_PENDING' as const;
  const collected = payments.some(payment => payment.clientId === contract.clientId && payment.contractId === contract.id
    && payment.status === 'incassato' && payment.collectedAt && payment.collectedAt <= now && payment.accountingDocumentId);
  return collected ? 'PAYMENT_EVIDENCE_TO_VERIFY' as const : 'PAYMENT_PENDING' as const;
}

export function contractOperationalLabel(actor: FinancialActor, state: ReturnType<typeof contractOperationalState>) {
  const access = financialReadAccess(actor);
  if (!access.contract || !access.payment) return 'Operatività sospesa · verifica interna richiesta';
  return {
    CLOSED: 'Operatività sospesa · contratto non operativo',
    SIGNATURE_PENDING: 'Operatività sospesa · firma da raccordare e pagamento da verificare',
    PAYMENT_PENDING: 'Operatività sospesa · in attesa di pagamento verificato',
    PAYMENT_EVIDENCE_TO_VERIFY: 'Incasso registrato · verificare la prova e autorizzare separatamente l’avvio',
  }[state];
}

export const CLIENT_OPERATIONAL_HOLD_MESSAGE = 'Operatività sospesa. Rivolgiti al responsabile per la verifica interna.';
export function clientHasOperationalHold(status: string) { return status === 'sospeso'; }
