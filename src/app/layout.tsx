import "./globals.css";
import { Nav } from "@/components/ui";
import { getSession } from "@/lib/auth";
export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSession();
  return (
    <html lang="it">
      <body>
        <div className="flex">
          <Nav />
          <div className="min-h-screen flex-1">
            <div className="sticky top-0 z-20 border-b border-white/70 bg-white/78 px-8 py-4 shadow-sm shadow-slate-200/60 backdrop-blur-xl">
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
            <main className="p-8 xl:p-10">{children}</main>
          </div>
        </div>
      </body>
    </html>
  );
}
