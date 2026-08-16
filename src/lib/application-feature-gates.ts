import type { PrismaClient } from '@prisma/client';
import {
  applicationFeatureGateCodes,
  environmentFeatureGateEnabled,
  type ApplicationFeatureGateCode,
} from './application-security-policy';

type FeatureGateDb = Pick<PrismaClient, 'applicationFeatureGate'>;

export async function isApplicationFeatureEnabled(
  db: FeatureGateDb,
  code: ApplicationFeatureGateCode,
  environment: Readonly<Record<string, string | undefined>> = process.env,
) {
  if (!environmentFeatureGateEnabled(code, environment)) return false;
  try {
    const gate = await db.applicationFeatureGate.findUnique({
      where: { code },
      select: { enabled: true },
    });
    return gate?.enabled === true;
  } catch {
    return false;
  }
}

export async function applicationFeatureGateSnapshot(
  db: FeatureGateDb,
  environment: Readonly<Record<string, string | undefined>> = process.env,
) {
  let rows: Array<{ code: string; enabled: boolean; version: number }> = [];
  try {
    rows = await db.applicationFeatureGate.findMany({
      where: { code: { in: [...applicationFeatureGateCodes] } },
      select: { code: true, enabled: true, version: true },
    });
  } catch {
    // A missing or unavailable registry keeps every effective feature OFF.
  }
  const byCode = new Map(rows.map((row) => [row.code, row]));
  return applicationFeatureGateCodes.map((code) => {
    const row = byCode.get(code);
    const environmentEnabled = environmentFeatureGateEnabled(code, environment);
    return {
      code,
      databaseEnabled: row?.enabled === true,
      environmentEnabled,
      effectiveEnabled: row?.enabled === true && environmentEnabled,
      version: row?.version ?? null,
    };
  });
}
