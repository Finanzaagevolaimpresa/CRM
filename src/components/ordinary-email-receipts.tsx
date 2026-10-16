import { ordinaryReceiptLabels, type OrdinaryEmailReceipt } from '@/lib/ordinary-email-receipt';

export function OrdinaryEmailReceipts({ receipts }: { receipts: OrdinaryEmailReceipt[] }) {
  if (!receipts.length) return null;
  return <section aria-label="Ricevute email ordinarie" className="my-4 rounded-xl border p-4">
    <h3 className="font-bold">Email ordinaria · ricevute del trasporto</h3>
    <p className="text-sm">L’accettazione SMTP conferma la presa in carico del server. Non prova la consegna o la lettura del destinatario.</p>
    <ol className="mt-3 space-y-3">{receipts.map(receipt => <li key={receipt.id}>
      <p className="font-bold">Versione {receipt.revision} · {ordinaryReceiptLabels[receipt.state]}</p>
      <p className="text-sm">{(receipt.recordedAt ?? receipt.createdAt).toISOString()}</p>
      {['RESERVED','CLAIMED','UNCERTAIN'].includes(receipt.state)
        ? <p className="text-sm">Il tentativo resta bloccato. Verifica l’esito prima di qualsiasi altro invio.</p> : null}
    </li>)}</ol>
  </section>;
}
