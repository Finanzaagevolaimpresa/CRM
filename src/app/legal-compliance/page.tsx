import { Badge, Card, EmptyState, PageHeader, Stat } from "@/components/ui";
import { requireAuth } from "@/lib/auth";

export const dynamic = "force-dynamic";

const allowedRoles = [
  "admin",
  "direzione",
  "revisore",
  "amministrazione",
] as const;

const queues = [
  [
    "Bozze legali da revisionare",
    "0",
    "Testi interni da verificare prima di qualsiasi uso.",
    "purple",
  ],
  [
    "Contratti da controllare",
    "0",
    "Verifica di coerenza, allegati e clausole operative.",
    "blue",
  ],
  [
    "Contestazioni / reclami",
    "0",
    "Comunicazioni sensibili da gestire con presidio umano.",
    "orange",
  ],
  [
    "Privacy / consensi",
    "0",
    "Informative, autorizzazioni e consensi da monitorare.",
    "green",
  ],
  [
    "Output AI legali da approvare",
    "0",
    "Bozze AI bloccate fino ad approvazione interna.",
    "purple",
  ],
] as const;

export default async function Page() {
  await requireAuth([...allowedRoles]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Legale / Compliance AI"
        description="Area interna per revisione di contratti, PEC, contestazioni, privacy, disclaimer e comunicazioni sensibili. Non fornisce consulenza legale automatica al cliente."
      />

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        {queues.map(([label, value, description, tone]) => (
          <Stat
            key={label}
            label={label}
            value={value}
            description={description}
            tone={tone}
          />
        ))}
      </section>

      <div className="grid gap-5 lg:grid-cols-[1fr_1fr]">
        <Card title="Presidi di revisione">
          <div className="space-y-3">
            {queues.map(([label, , description]) => (
              <div
                key={label}
                className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"
              >
                <Badge tone={label.includes("AI") ? "purple" : "blue"}>
                  {label}
                </Badge>
                <p className="mt-2 text-sm leading-6 text-slate-600">
                  {description}
                </p>
              </div>
            ))}
          </div>
        </Card>

        <Card title="Regola fondamentale">
          <div className="rounded-3xl border border-fai-orange/30 bg-fai-orange/10 p-5 text-sm leading-7 text-slate-700">
            <p className="text-lg font-black text-fai-navy">
              Output sempre bozza interna.
            </p>
            <p className="mt-2">
              Ogni contenuto AI o comunicazione sensibile richiede revisione
              umana obbligatoria prima di approvazione, utilizzo operativo o
              invio manuale da parte di personale autorizzato.
            </p>
          </div>
          <div className="mt-4 grid gap-3 text-sm text-slate-600">
            <p className="rounded-2xl bg-slate-50 p-4 ring-1 ring-slate-200">
              Nessun invio automatico PEC o email.
            </p>
            <p className="rounded-2xl bg-slate-50 p-4 ring-1 ring-slate-200">
              Nessuna area cliente pubblica o esposizione esterna.
            </p>
            <p className="rounded-2xl bg-slate-50 p-4 ring-1 ring-slate-200">
              Nessuna consulenza legale automatica al cliente.
            </p>
          </div>
        </Card>
      </div>

      <Card title="Prossimi sviluppi">
        <EmptyState title="Skeleton compliance predisposto">
          In uno step successivo questa area potrà aggregare contratti,
          documenti, output AI e audit log esistenti mantenendo il principio di
          human review obbligatoria.
        </EmptyState>
      </Card>
    </div>
  );
}
