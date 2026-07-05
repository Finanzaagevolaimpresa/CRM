import "./globals.css";
import { Nav } from "@/components/ui";
import { getSession } from "@/lib/auth";
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
  return (
    <html lang="it">
      <body>
        <div className="flex min-h-screen min-w-0 flex-col md:h-screen md:overflow-hidden md:flex-row">
          <Nav notificationCount={notificationCount} role={session?.role} />
          <div className="min-h-0 min-w-0 flex-1 md:overflow-y-auto">
            <div className="sticky top-0 z-20 border-b border-slate-200/80 bg-white/90 px-4 py-3 shadow-sm shadow-slate-200/50 backdrop-blur-xl md:px-6">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-sm font-black uppercase tracking-[0.2em] text-fai-green">
                    CRM interno FAI
                  </p>
                  <p className="text-xs font-medium text-slate-500">
                    Area operativa riservata · output AI sempre soggetti a
                    revisione umana
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <span className="hidden rounded-full bg-fai-lime/15 px-3 py-2 text-xs font-black uppercase tracking-wide text-fai-green ring-1 ring-fai-lime/25 sm:inline-flex">
                    Sistema protetto
                  </span>
                  <span className="rounded-full bg-white px-4 py-2 text-sm font-extrabold text-fai-navy shadow-sm ring-1 ring-slate-200">
                    {session
                      ? `Ruolo: ${session.role.replaceAll("_", " ")}`
                      : "Utente interno"}
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
