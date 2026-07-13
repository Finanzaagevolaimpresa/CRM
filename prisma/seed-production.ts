import { PrismaClient } from "@prisma/client";
import { initialAiAgentConfigs } from "./ai-agent-configs";

const prisma = new PrismaClient();

const services = [
  [
    "verifica_ai_essenziale",
    "Verifica AI Essenziale",
    "Screening interno preliminare con output AI in bozza da revisionare.",
    "ai",
  ],
  [
    "audit_ai_bancabilita",
    "Audit AI Bancabilità",
    "Analisi tecnica interna della bancabilità e delle criticità documentali.",
    "bancabilita",
  ],
  [
    "pre_analisi_ai_ammissibilita",
    "Pre-Analisi AI Ammissibilità",
    "Pre-analisi interna di coerenza rispetto a misure e requisiti da verificare.",
    "finanza_agevolata",
  ],
  [
    "supporto_finanza_ordinaria",
    "Supporto Finanza Ordinaria",
    "Supporto tecnico interno su strumenti ordinari ipotizzabili.",
    "finanza_ordinaria",
  ],
  [
    "supporto_finanza_agevolata",
    "Supporto Finanza Agevolata",
    "Supporto tecnico interno su bandi e misure da verificare.",
    "finanza_agevolata",
  ],
] as const;

async function seedAiAgentConfigs() {
  for (const config of initialAiAgentConfigs) {
    await prisma.aiAgent.upsert({
      where: { code: config.code },
      update: {
        name: config.name,
        description: config.description,
        operationalScope: config.operationalScope,
        systemPrompt: config.systemPrompt,
        requiredDataChecklist: config.requiredDataChecklist,
        expectedOutput: config.expectedOutput,
        toneStyle: config.toneStyle,
        active: config.active,
        provider: config.provider,
        futureModel: config.futureModel ?? null,
      },
      create: {
        code: config.code,
        name: config.name,
        description: config.description,
        operationalScope: config.operationalScope,
        systemPrompt: config.systemPrompt,
        requiredDataChecklist: config.requiredDataChecklist,
        expectedOutput: config.expectedOutput,
        toneStyle: config.toneStyle,
        active: config.active,
        provider: config.provider,
        futureModel: config.futureModel ?? null,
        promptVersion: "v1",
        inputSchema: {},
        outputSchema: { requiresHumanReview: true },
      },
    });
  }
}

async function seedServiceCatalog() {
  for (const [code, name, description, category] of services) {
    await prisma.serviceCatalog.upsert({
      where: { code },
      update: { name, description, category, active: true },
      create: {
        code,
        name,
        description,
        category,
        active: true,
        displayOrder: services.findIndex((service) => service[0] === code) + 1,
      },
    });
  }
}

async function main() {
  if ((process.env.APP_ENV ?? process.env.NODE_ENV) !== "production") {
    console.log(
      "Production seed skipped: set APP_ENV=production or NODE_ENV=production to run it.",
    );
    return;
  }

  await seedAiAgentConfigs();
  await seedServiceCatalog();
  console.log("Production seed completed: AI agent configs and service catalog are ready.");
}

main().finally(async () => prisma.$disconnect());
