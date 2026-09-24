'use client';

import { useActionState } from 'react';
import { purchasedServiceHandoffAction } from '@/lib/purchased-service-handoff-actions';

export function PurchasedServiceHandoffForm({ serviceId, expectedHash, users }: { serviceId: string; expectedHash: string; users: Array<{ id: string; name: string }> }) {
  const [result, action, pending] = useActionState(purchasedServiceHandoffAction, { ok: false, message: '' });
  return <form action={action} aria-label="Passaggio al tecnico" className="grid gap-4">
    <input type="hidden" name="serviceId" value={serviceId} /><input type="hidden" name="expectedHash" value={expectedHash} />
    <label>Variante prevista dall’incarico<input aria-label="Variante prevista dall’incarico" name="variantCode" minLength={2} maxLength={120} required className="ml-2 rounded-lg border p-2" /></label>
    <label>Reparto tecnico<input aria-label="Reparto tecnico" name="departmentCode" minLength={2} maxLength={80} required className="ml-2 rounded-lg border p-2" /></label>
    <label>Referente tecnico<select aria-label="Referente tecnico" name="technicalOwnerId" required className="ml-2 rounded-lg border p-2" defaultValue=""><option value="">Seleziona il referente individuale</option>{users.map(user => <option value={user.id} key={user.id}>{user.name}</option>)}</select></label>
    <label>Scadenza delle attività<input aria-label="Scadenza delle attività" type="date" name="dueDate" required className="ml-2 rounded-lg border p-2" /></label>
    <label>Attività incluse, una per riga<textarea aria-label="Attività incluse, una per riga" name="activities" required rows={5} className="block w-full rounded-lg border p-2" /></label>
    <label>Motivazione<textarea aria-label="Motivazione" name="reason" required minLength={10} maxLength={500} className="block w-full rounded-lg border p-2" /></label>
    <label className="flex items-start gap-2"><input type="checkbox" name="confirmed" required />Confermo che variante e attività corrispondono all’incarico e che il pagamento documentato soddisfa le condizioni per affidare il lavoro.</label>
    <p>Il referente riceve la pratica e il relativo servizio. La successiva riassegnazione dalla scheda responsabilità aggiorna entrambi.</p>
    {result.message && <p role="status">{result.message}</p>}<button className="rounded-lg border p-3 font-bold" disabled={pending}>{pending ? 'Registrazione…' : 'Affida il servizio al tecnico'}</button>
  </form>;
}
