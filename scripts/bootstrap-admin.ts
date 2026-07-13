import { randomBytes } from "node:crypto";
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

function generatePassword(): string {
  return `${randomBytes(24).toString("base64url")}aA1!`;
}

async function main() {
  const email = requiredEnv("BOOTSTRAP_ADMIN_EMAIL").toLowerCase();
  const name = requiredEnv("BOOTSTRAP_ADMIN_NAME");
  const providedPassword = process.env.BOOTSTRAP_ADMIN_PASSWORD;
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

  const password = providedPassword?.trim() || generatePassword();
  if (password.length < 16) {
    throw new Error("BOOTSTRAP_ADMIN_PASSWORD must be at least 16 characters when provided.");
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const user = await prisma.user.upsert({
    where: { email },
    update: { name, role: RoleCode.admin, active: true, passwordHash, deletedAt: null },
    create: { email, name, role: RoleCode.admin, active: true, passwordHash },
    select: { email: true, name: true },
  });

  console.log(`Admin ready: ${user.email} (${user.name})`);
  if (!providedPassword) {
    console.log("Generated admin password (shown once, store it now):");
    console.log(password);
  } else {
    console.log("Admin password loaded from BOOTSTRAP_ADMIN_PASSWORD and not printed.");
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
