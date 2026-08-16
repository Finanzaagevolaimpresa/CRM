import { PrismaClient } from '@prisma/client';
import { resolveInternalSession } from '../../src/lib/internal-session-registry';
const db = new PrismaClient();
try {
  const resolved = await resolveInternalSession(db, process.env.N02_SYNTHETIC_COOKIE);
  process.exitCode = Boolean(resolved) === (process.env.N02_EXPECT_VALID === '1') ? 0 : 3;
} catch { process.exitCode = 4; }
finally { await db.$disconnect(); }
