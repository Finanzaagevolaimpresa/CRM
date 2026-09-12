import Link from "next/link";
import { Nav } from "@/components/ui";
import { DashboardOverview } from "@/components/dashboard-overview";
import type { Permission } from "@/lib/permissions";

const adminPermissions: Permission[] = [
  "service.read", "document.download", "lead.read", "lead.duplicate.resolve",
  "contract.read", "payment.read", "client.read", "project.read", "dossier.read",
  "technical.read", "ai.review", "ai.execution.request", "ai.execution.audit",
  "ai_agents.read", "legal.read", "privacy.evidence.read", "user.read",
  "settings.manage", "ai.orchestrator.read", "audit.read",
];

const commercialPermissions: Permission[] = [
  "service.read", "document.download", "lead.read", "contract.read", "payment.read",
];

export default async function MobileNavFixture({ searchParams }: { searchParams: Promise<{ profile?: string; priorities?: string }> }) {
  const params = await searchParams;
  const profile = params.profile === "commercial" ? "commercial" : "admin";
  const permissions = profile === "commercial" ? commercialPermissions : adminPermissions;
  const priorities = Array.from({ length: params.priorities === "many" ? 8 : 3 }, (_, index) => ({
    id: `synthetic-${index + 1}`, title: `Attività sintetica ${index + 1}`, related: "Azienda di prova",
    type: "Task oggi", date: "Oggi, 10:30", href: "/tasks",
  }));
  return (
    <div className="flex min-h-screen min-w-0 flex-col md:h-screen md:overflow-hidden md:flex-row">
      <Nav role={profile === "admin" ? "admin" : "commerciale"} effectivePermissions={permissions} notificationCount={123} />
      <div data-testid="page-content" className="min-h-0 min-w-0 flex-1 md:overflow-y-auto">
        <header className="border-b bg-white px-4 py-2"><p className="break-words text-xs font-bold text-slate-500">Fixture sintetica isolata dei componenti reali — nessuna autenticazione o permission server verificata qui</p></header>
        <main className="space-y-6 p-4 md:p-6">
          <span className="sr-only">Contenuto commerciale raggiungibile</span>
          <DashboardOverview
            greeting="Buongiorno, Operatore."
            summary={`${priorities.length} priorità operative sintetiche nel perimetro della fixture.`}
            kpis={[
              { label: "Lead nuovi", value: 7, description: "Nuovi contatti visibili da qualificare", href: "/leads", tone: "blue" },
              ...(profile === "admin" ? [{ label: "Pratiche tecniche attive", value: 11, description: "Pratiche accessibili in stato operativo", href: "/technical-office/practices", tone: "green" as const }] : []),
              { label: "Task scaduti", value: 2, description: "Attività aperte oltre la scadenza", href: "/tasks", tone: "orange" },
              ...(profile === "admin" ? [{ label: "Autorizzazioni AI in attesa", value: 1, description: "Richieste complete da decidere separatamente", href: "/settings/ai-authorizations", tone: "purple" as const }] : []),
            ]}
            priorities={priorities}
            pipeline={[{ label: "in valutazione", value: 4 }, { label: "documenti richiesti", value: 3 }, { label: "in istruttoria", value: 2 }]}
            shortcuts={profile === "commercial" ? [{ label: "Commerciale", description: "Lead e offerte autorizzati", href: "/leads" }] : [{ label: "Commerciale", description: "Lead e offerte autorizzati", href: "/leads" }, { label: "Ufficio Tecnico", description: "Pratiche e comunicazioni", href: "/technical-office" }]}
          />
          <Link className="underline" href="/external">Destinazione esterna al menu</Link>
          <div className="h-[800px] pt-4 text-sm text-slate-500">Area lunga per verificare lo scorrimento del contenuto.</div>
          <button className="rounded border p-3">Fine contenuto</button>
        </main>
      </div>
    </div>
  );
}
