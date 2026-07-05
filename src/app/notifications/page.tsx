import Link from "next/link";
import { Badge, Card, EmptyState, PageHeader, formatDateTime } from "@/components/ui";
import { requireSession } from "@/lib/auth";
import { getInternalNotifications } from "@/lib/internal-notifications";

export const dynamic = "force-dynamic";

const priorityTone = {
  alta: "orange",
  media: "blue",
  bassa: "gray",
} as const;

export default async function NotificationsPage() {
  const session = await requireSession();
  const notifications = await getInternalNotifications(session);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Notifiche"
        description="Priorità operative interne calcolate dai dati già presenti nel CRM, senza invii automatici o canali esterni."
      />

      <Card
        title="Notifiche attive"
        action={<Badge tone={notifications.length > 0 ? "orange" : "green"}>{notifications.length} attive</Badge>}
      >
        {notifications.length === 0 ? (
          <EmptyState title="Nessuna notifica attiva">
            Non risultano task scaduti, attività in scadenza oggi, comunicazioni da gestire, pratiche tecniche aperte o follow-up commerciali per il tuo ruolo.
          </EmptyState>
        ) : (
          <div className="space-y-3">
            {notifications.map((notification) => (
              <article
                className="grid gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm shadow-slate-200/70 md:grid-cols-[1.4fr_0.9fr_0.7fr_0.9fr_auto] md:items-center"
                key={notification.id}
              >
                <div>
                  <h2 className="font-extrabold text-fai-navy">{notification.title}</h2>
                  <p className="mt-1 text-xs font-semibold text-slate-500">
                    {notification.related ?? "Nessun cliente o pratica collegata"}
                  </p>
                </div>
                <div className="space-y-1">
                  <p className="text-[0.65rem] font-black uppercase tracking-wide text-slate-400">Categoria</p>
                  <Badge tone="purple">{notification.category}</Badge>
                </div>
                <div className="space-y-1">
                  <p className="text-[0.65rem] font-black uppercase tracking-wide text-slate-400">Priorità</p>
                  <Badge tone={priorityTone[notification.priority]}>{notification.priority}</Badge>
                </div>
                <div>
                  <p className="text-[0.65rem] font-black uppercase tracking-wide text-slate-400">Data / scadenza</p>
                  <p className="mt-1 text-sm font-bold text-slate-700">{formatDateTime(notification.date)}</p>
                </div>
                <Link
                  className="inline-flex justify-center rounded-xl bg-fai-green px-4 py-2 text-xs font-black uppercase tracking-wide text-white shadow-sm transition hover:bg-fai-navy"
                  href={notification.href}
                >
                  Apri
                </Link>
              </article>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
