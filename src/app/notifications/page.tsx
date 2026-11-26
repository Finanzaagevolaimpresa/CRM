import { withTechnicalPage } from '@/lib/technical-surface-guards';
import { RefreshReadOnlyNotices } from '@/components/live-notifications';
import { formatRecordNoticeTime } from '@/lib/record-notice-time';
import Link from "next/link";
import { Badge, Card, EmptyState, PageHeader } from "@/components/ui";
import { requireSession } from "@/lib/auth";
import { getInternalNotifications } from "@/lib/internal-notifications";
import { openInternalNotification } from '@/lib/internal-notification-actions';

export const dynamic = "force-dynamic";

const priorityTone = {
  alta: "orange",
  media: "blue",
  bassa: "gray",
} as const;

  async function NotificationsPage({ searchParams }: { searchParams: Promise<{ state?: string }> }) {
  const read = (await searchParams).state === 'read';
  const session = await requireSession();
  const notifications = await getInternalNotifications(session, { state: read ? 'read' : 'active' });

  return (
    <div className="crm-space-y-6">
      <RefreshReadOnlyNotices />
      <PageHeader
        title="Notifiche"
        description="Priorità operative, aggiornamenti selezionati dall’Admin e richieste AI, con accesso verificato per ogni scheda. Orari Europe/Rome."
      />
      <Link href="/notifications/updates" className="inline-block font-bold text-fai-blue underline">Aggiornamenti selezionati e stato di lettura</Link>
      {session.role === 'admin' && <Link href="/notifications/reminders" className="block font-bold text-fai-blue underline">I miei promemoria programmati</Link>}

      <nav aria-label="Stato notifiche" className="flex gap-4">
        <Link href="/notifications" aria-current={!read ? 'page' : undefined} className="font-bold underline">Attive</Link>
        <Link href="/notifications?state=read" aria-current={read ? 'page' : undefined} className="font-bold underline">Lette</Link>
      </nav>
      <Card
        title={read ? 'Notifiche lette' : 'Notifiche attive'}
        action={<Badge tone={notifications.length > 0 ? "orange" : "green"}>{notifications.length} {read ? 'lette' : 'attive'}</Badge>}
      >
        {notifications.length === 0 ? (
          <EmptyState title={read ? 'Nessuna notifica letta' : 'Nessuna notifica attiva'}>
            Non risultano autorizzazioni AI da decidere, task scaduti, attività in scadenza oggi, comunicazioni da gestire, pratiche tecniche aperte o follow-up commerciali per il tuo ruolo.
          </EmptyState>
        ) : (
          <div className="crm-space-y-3">
            {notifications.map((notification) => (
              <article
                className="grid gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-xs shadow-slate-200/70 md:grid-cols-[1.4fr_0.9fr_0.7fr_0.9fr_auto] md:items-center"
                key={notification.id}
                data-notification-id={notification.id}
                data-notification-href={notification.href}
              >
                <div>
                  <h2 className="font-extrabold text-fai-navy">{notification.title}</h2>
                  <p className="mt-1 text-xs font-semibold text-slate-500">
                    {notification.related ?? "Nessun cliente o pratica collegata"}
                  </p>
                </div>
                <div className="crm-space-y-1">
                  <p className="text-[0.65rem] font-black uppercase tracking-wide text-slate-400">Categoria</p>
                  <Badge tone="purple">{notification.category}</Badge>
                </div>
                <div className="crm-space-y-1">
                  <p className="text-[0.65rem] font-black uppercase tracking-wide text-slate-400">Priorità</p>
                  <Badge tone={priorityTone[notification.priority]}>{notification.priority}</Badge>
                </div>
                <div>
                  <p className="text-[0.65rem] font-black uppercase tracking-wide text-slate-400">Data / scadenza</p>
                  <p className="mt-1 text-sm font-bold text-slate-700">{formatRecordNoticeTime(notification.date)}</p>
                </div>
                <form action={openInternalNotification}>
                  <input type="hidden" name="id" value={notification.id} />
                  <button type="submit" className="inline-flex justify-center rounded-xl bg-fai-green px-4 py-2 text-xs font-black uppercase tracking-wide text-white shadow-xs transition hover:bg-fai-navy">Apri</button>
                </form>
              </article>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

export default withTechnicalPage("/notifications", NotificationsPage);
