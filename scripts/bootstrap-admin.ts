import { PrismaClient, RoleCode } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

async function main() {
  const email = requiredEnv("BOOTSTRAP_ADMIN_EMAIL").toLowerCase();
  const name = requiredEnv("BOOTSTRAP_ADMIN_NAME");
  const providedPassword = requiredEnv("BOOTSTRAP_ADMIN_PASSWORD");
  const allowAdditional = process.env.BOOTSTRAP_ADMIN_ALLOW_ADDITIONAL === "true";

  const existingActiveAdmin = await prisma.user.findFirst({
    where: { role: RoleCode.admin, active: true, deletedAt: null },
    select: { email: true },
  });

  if (existingActiveAdmin && !allowAdditional) {
    throw new Error(
      "An active admin already exists. Refusing to create another admin. Set BOOTSTRAP_ADMIN_ALLOW_ADDITIONAL=true only if this is intentional.",
    );
  }

  const password = providedPassword.trim();
  if (password.length < 16) {
    throw new Error("BOOTSTRAP_ADMIN_PASSWORD must be at least 16 characters.");
  }

  const passwordHash = await bcrypt.hash(password, 12);
  await prisma.user.upsert({
    where: { email },
    update: { name, role: RoleCode.admin, active: true, passwordHash, deletedAt: null },
    create: { email, name, role: RoleCode.admin, active: true, passwordHash },
    select: { id: true },
  });

  console.log("Admin bootstrap completed; identity and credentials were not printed.");
}

main()
  .catch(() => {
    console.error("Admin bootstrap failed. Review configuration without printing credentials or personal data.");
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
