import Link from "next/link";
import { Badge, Card, EmptyState, PageHeader, Stat } from "@/components/ui";
import { requireAuth } from "@/lib/auth";

export const dynamic = "force-dynamic";

const allowedRoles = [
  "admin",
  "direzione",
  "consulente",
  "revisore",
  "backoffice",
] as const;

const stages = [
  [
    "Pratiche da progettare",
    "0",
    "Analisi tecnica iniziale e raccolta perimetro intervento.",
    "blue",
  ],
  [
    "Pratiche in preparazione",
    "0",
    "Documenti, dati progetto e allegati in costruzione.",
    "orange",
  ],
  [
    "Pronte per presentazione",
    "0",
    "Checklist interna completata prima del deposito.",
    "green",
  ],
  [
    "Pratiche presentate",
    "0",
    "Presentazioni già effettuate su enti o portali competenti.",
    "purple",
  ],
  [
    "Integrazioni richieste",
    "0",
    "Richieste ente da gestire con responsabilità interna.",
    "orange",
  ],
] as const;

const links = [
  [
    "Clienti",
    "/clients",
    "Anagrafiche e referenti collegati alle pratiche tecniche.",
  ],
  [
    "Progetti",
    "/projects",
    "Contesto operativo, stato e responsabilità di lavorazione.",
  ],
  [
    "Servizi",
    "/clients",
    "Servizi FAI acquistati e stati della pipeline operativa.",
  ],
  [
    "Documenti",
    "/documents",
    "Archivio interno per allegati e documentazione sensibile.",
  ],
];

export default async function Page() {
  await requireAuth([...allowedRoles]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Ufficio Tecnico"
        description="Area interna per progettazione, gestione e preparazione alla presentazione delle pratiche verso enti e portali competenti. Nessun invio automatico è previsto in questa fase."
      />

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        {stages.map(([label, value, description, tone]) => (
          <Stat
            key={label}
            label={label}
            value={value}
            description={description}
            tone={tone}
          />
        ))}
      </section>

      <div className="grid gap-5 lg:grid-cols-[1.2fr_.8fr]">
        <Card title="Flusso operativo tecnico">
          <div className="space-y-3">
            {stages.map(([label, , description], index) => (
              <div
                key={label}
                className="flex gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-fai-lime/20 text-sm font-black text-fai-green">
                  {index + 1}
                </span>
                <div>
                  <p className="font-extrabold text-fai-navy">{label}</p>
                  <p className="mt-1 text-sm leading-6 text-slate-500">
                    {description}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </Card>

        <Card title="Collegamenti concettuali">
          <div className="grid gap-3">
            {links.map(([label, href, description]) => (
              <Link
                key={label}
                href={href}
                className="rounded-2xl border border-slate-200 bg-slate-50/80 p-4 transition hover:border-fai-blue/25 hover:bg-white"
              >
                <Badge tone="blue">{label}</Badge>
                <p className="mt-2 text-sm leading-6 text-slate-600">
                  {description}
                </p>
              </Link>
            ))}
          </div>
        </Card>
      </div>

      <Card title="Prossimi sviluppi">
        <EmptyState title="Skeleton predisposto">
          Questa area verrà collegata a clienti, progetti, servizi e documenti
          esistenti senza modifiche Prisma in questo step. Presentazioni a enti
          o portali resteranno azioni manuali e tracciate internamente.
        </EmptyState>
      </Card>
    </div>
  );
}
