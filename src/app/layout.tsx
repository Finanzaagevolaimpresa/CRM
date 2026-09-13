import "./globals.css";
import Link from "next/link";
import { Nav } from "@/components/ui";
import { getEffectivePermissions, getSession } from "@/lib/auth";
import { getInternalNotificationCount } from "@/lib/internal-notifications";
export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSession();
  const notificationCount = session
    ? await getInternalNotificationCount(session)
    : 0;
  const effectivePermissions = session ? getEffectivePermissions(session) : [];
  return (
    <html lang="it" data-scroll-behavior="smooth">
      <body>
        <div className="flex min-h-screen min-w-0 flex-col md:h-screen md:overflow-hidden md:flex-row">
          <Nav effectivePermissions={effectivePermissions} notificationCount={notificationCount} role={session?.role} />
          <div className="min-h-0 min-w-0 flex-1 md:overflow-y-auto">
            <div className="sticky top-0 z-20 hidden border-b border-slate-200/80 bg-white/95 px-6 py-3 backdrop-blur-xl md:block">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-black text-fai-navy">Area operativa riservata</p>
                  <p className="text-xs font-medium text-slate-500">Output AI soggetti a revisione umana</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Link href="/search" className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-bold text-fai-navy focus:outline-none focus:ring-2 focus:ring-fai-lime">Ricerca</Link>
                  <Link href="/notifications" className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-bold text-fai-navy focus:outline-none focus:ring-2 focus:ring-fai-lime">Notifiche{notificationCount > 0 ? ` · ${notificationCount > 99 ? "99+" : notificationCount}` : ""}</Link>
                  <span className="rounded-xl bg-fai-green/10 px-4 py-2 text-sm font-extrabold capitalize text-fai-green ring-1 ring-fai-green/15">
                    {session ? session.role.replaceAll("_", " ") : "Utente interno"}
                  </span>
                </div>
              </div>
            </div>
            <main className="p-4 md:p-6 xl:p-8">{children}</main>
          </div>
        </div>
      </body>
    </html>
  );
}
