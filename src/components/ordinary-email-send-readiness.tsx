import Link from 'next/link';
import { ordinaryEmailSenderNotice, type OrdinaryEmailUiChannel } from '@/lib/ordinary-email-send-readiness';

export function OrdinaryEmailSendReadiness(props: {
  isAdmin: boolean; selectedMailboxId: string; selectedAddress: string;
  authority: OrdinaryEmailUiChannel | null | undefined;
}) {
  const notice = ordinaryEmailSenderNotice(props);
  if (!notice) return null;
  return <section aria-label="Disponibilità invio email" className="my-3 space-y-2 rounded-xl border border-amber-300 p-4">
    <h3 className="font-bold">Invio dal CRM non disponibile per questo mittente</h3>
    <p>Mittente del messaggio: <b>{notice.selectedAddress}</b>.</p>
    {notice.availableAddress
      ? <p>Il canale attualmente abilitato usa <b>{notice.availableAddress}</b>. Per mantenere il mittente del messaggio serve la qualificazione e l’abilitazione del relativo canale di invio.</p>
      : <p>Per questa sessione non risulta un canale di invio utilizzabile. Verifica l’accesso Admin e l’abilitazione del canale associato alla casella.</p>}
    <p>Una casella registrata non equivale a un canale di invio attivo. La bozza e la lettura CRM restano distinte dall’invio email; questo avviso non modifica mittente o destinatari.</p>
    <Link className="font-semibold underline" href="/settings/communications">Consulta le caselle registrate</Link>
  </section>;
}
