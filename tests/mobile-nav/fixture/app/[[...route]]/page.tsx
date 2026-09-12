import Link from "next/link";
import { Nav } from "@/components/ui";
import { DashboardOverview } from "@/components/dashboard-overview";
import { buildDashboardCounterGroups } from "@/lib/dashboard-counter-groups";
import type { Permission } from "@/lib/permissions";

const adminPermissions: Permission[] = [
  "service.read", "document.download", "lead.read", "lead.duplicate.resolve",
  "contract.read", "payment.read", "client.read", "project.read", "dossier.read",
  "technical.read", "ai.review", "ai.execution.request", "ai.execution.audit",
  "ai_agents.read", "legal.read", "privacy.evidence.read", "user.read",
  "settings.manage", "ai.orchestrator.read", "audit.read",
  "practice_communications.read", "practice_communications.review",
];

const commercialPermissions: Permission[] = [
  "service.read", "document.download", "lead.read", "contract.read", "payment.read",
];

const technicalPermissions: Permission[] = ["service.read", "technical.read", "document.download", "practice_communications.read", "practice_communications.review"];
const communicationPermissions: Permission[] = ["practice_communications.read", "practice_communications.review"];

// The fourteen entries and their order match the dashboard caller's pipelineStatuses.
const operationalPipelineStatuses = [
  "nuova", "pre_analisi", "documenti_richiesti", "documenti_ricevuti",
  "in_valutazione", "proposta_inviata", "domanda_in_preparazione", "domanda_presentata",
  "in_istruttoria", "approvata_deliberata", "respinta_non_procedibile", "rendicontazione",
  "chiusa", "archiviata",
];

export default async function MobileNavFixture({ searchParams }: { searchParams: Promise<{ profile?: string; priorities?: string; counters?: string; pipeline?: string }> }) {
  const params = await searchParams;
  const profile = ["commercial", "technical", "communications", "restricted"].includes(params.profile ?? "") ? params.profile : "admin";
  const permissions = profile === "commercial" ? commercialPermissions : profile === "technical" ? technicalPermissions : profile === "communications" ? communicationPermissions : profile === "restricted" ? [] : adminPermissions;
  const can = (permission: Permission) => permissions.includes(permission);
  const count = (value: number) => params.counters === "zero" ? 0 : params.counters === "large" ? 1234567 : value;
  const pipeline = params.pipeline === "actual-sparse" || params.pipeline === "actual-all"
    ? operationalPipelineStatuses.map((status, index) => ({
      label: status.replaceAll("_", " "),
      value: count(params.pipeline === "actual-all" ? index + 1 : index === 0 ? 4 : index === 6 ? 3 : index === 12 ? 2 : 0),
    }))
    : [{ label: "in valutazione", value: count(4) }, { label: "documenti richiesti", value: count(3) }, { label: "in istruttoria", value: count(2) }];
  const counterGroups = buildDashboardCounterGroups({
    canReadLeads: can("lead.read"), canReadTechnical: can("technical.read"),
    canReadPracticeCommunications: can("practice_communications.read"),
    canReviewPracticeCommunications: can("practice_communications.review"),
    canReadClients: can("client.read"), canReadProjects: can("project.read"),
    canReadServices: can("service.read"), canReadPayments: can("payment.read"),
    canReadDossiers: can("dossier.read"), canReadAiOutputs: can("ai.review") || can("ai.approve"),
    canReviewAiOutputs: can("ai.review"),
    isAdmin: profile === "admin",
  }, {
    leadDaContattare: count(24), trattativeAperte: count(8), offerteInviate: count(6), offerteAccettate: count(3),
    activeTechnicalPracticesCount: count(11), overdueClientUpdates: count(2), commsToReview: count(5), approvedUnusedComms: count(4),
    clientiAttivi: count(38), progettiAttivi: count(16), serviziAcquistati: count(52),
    tasks: count(19), todayTasksCount: count(6), overdueTasks: count(2), dueSoonTasks: count(9), payments: count(7),
    preReview: count(3), dossierBozza: count(4), aiReview: count(5), pendingAiAuthorizationRequestCount: count(47),
  });
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
              ...(can("lead.read") ? [{ label: "Lead nuovi", value: count(7), description: "Nuovi contatti visibili da qualificare", href: "/leads", tone: "blue" as const }] : []),
              ...(can("technical.read") ? [{ label: "Pratiche tecniche attive", value: count(11), description: "Pratiche accessibili in stato operativo", href: "/technical-office/practices", tone: "green" as const }] : []),
              ...(can("service.read") ? [{ label: "Task scaduti", value: count(2), description: "Attività aperte oltre la scadenza", href: "/tasks", tone: "orange" as const }] : []),
              ...(profile === "admin" ? [{ label: "Autorizzazioni AI in attesa", value: count(47), description: "Richieste complete da decidere separatamente", href: "/settings/ai-authorizations", tone: "purple" as const }] : []),
            ]}
            counterGroups={counterGroups}
            priorities={priorities}
            pipeline={pipeline}
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
