import Link from "next/link";
import { Nav } from "@/components/ui";
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

export default async function MobileNavFixture({ searchParams }: { searchParams: Promise<{ profile?: string }> }) {
  const profile = (await searchParams).profile === "commercial" ? "commercial" : "admin";
  const permissions = profile === "commercial" ? commercialPermissions : adminPermissions;
  return (
    <div className="flex min-h-screen min-w-0 flex-col md:h-screen md:overflow-hidden md:flex-row">
      <Nav role={profile === "admin" ? "admin" : "commerciale"} effectivePermissions={permissions} notificationCount={123} />
      <div data-testid="page-content" className="min-h-0 min-w-0 flex-1 md:overflow-y-auto">
        <header className="border-b p-4"><p className="break-words text-sm font-black">Fixture sintetica isolata dei componenti reali — nessuna autenticazione o permission server verificata qui</p></header>
        <main className="p-4"><h1 className="text-2xl font-black">Contenuto commerciale raggiungibile</h1><Link className="underline" href="/external">Destinazione esterna al menu</Link><div className="h-[1200px] pt-4">Area lunga per verificare lo scorrimento del contenuto.</div><button className="rounded border p-2">Fine contenuto</button></main>
      </div>
    </div>
  );
}
