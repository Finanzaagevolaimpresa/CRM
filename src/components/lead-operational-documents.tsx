import Link from 'next/link';
import type { AuthSession } from '@/lib/auth';
import { canUseOperationalDocuments } from '@/lib/operational-document-contract';
import { Card } from './ui';

export function LeadOperationalDocuments({ session, leadId, clientId }: { session: AuthSession; leadId: string; clientId?: string | null }) {
  if (!canUseOperationalDocuments(session)) return null;
  return <Card title="Documenti e Contratti" id="contratti-da-modello"><div className="space-y-3">
    <p>Usa un modello approvato e i dati della scheda per preparare una nuova bozza.</p>
    <Link className="font-bold text-fai-blue underline" href={'/document-library/new?lead=' + encodeURIComponent(leadId)}>Crea contratto da modello</Link>
    {clientId && <Link className="block font-bold text-fai-blue underline" href={'/clients/' + encodeURIComponent(clientId) + '#file-condivisi'}>Apri cartelle Drive del cliente</Link>}
  </div></Card>;
}
