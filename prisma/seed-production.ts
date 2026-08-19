import { PrismaClient } from "@prisma/client";
import { initialAiAgentConfigs } from "./ai-agent-configs";
import { seedAiAgentConfig } from "./seed-ai-agent";
import { FAI_SERVICE_CATALOG } from "../src/lib/service-catalog";

const prisma = new PrismaClient();

async function seedAiAgentConfigs() {
  for (const config of initialAiAgentConfigs) {
    await seedAiAgentConfig(prisma, config);
  }
}

async function seedServiceCatalog() {
  for (const service of FAI_SERVICE_CATALOG) {
    const basePrice = service.netPriceCents === null
      ? null
      : (service.netPriceCents / 100).toFixed(2);
    await prisma.serviceCatalog.upsert({
      where: { code: service.code },
      update: {
        name: service.name,
        description: service.description,
        category: service.category,
        basePrice,
        active: true,
        displayOrder: service.displayOrder,
      },
      create: {
        code: service.code,
        name: service.name,
        description: service.description,
        category: service.category,
        basePrice,
        active: true,
        displayOrder: service.displayOrder,
      },
    });
  }
  await prisma.serviceCatalog.updateMany({
    where: {
      code: { in: ["supporto_finanza_ordinaria", "supporto_finanza_agevolata"] },
    },
    data: { active: false },
  });
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
