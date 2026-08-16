import { createHmac } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { loginThrottleMode } from './application-security-policy';

type LoginThrottleDb = Pick<PrismaClient, '$queryRaw' | '$executeRaw'>;

export type LoginThrottleConfiguration = {
  maxFailures: number;
  windowSeconds: number;
  blockSeconds: number;
};

function boundedInteger(value: string | undefined, minimum: number, maximum: number) {
  if (!value || !/^[1-9][0-9]*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
}

export function loginThrottleConfiguration(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): LoginThrottleConfiguration | null {
  const maxFailures = boundedInteger(environment.LOGIN_THROTTLE_MAX_FAILURES, 3, 20);
  const windowSeconds = boundedInteger(environment.LOGIN_THROTTLE_WINDOW_SECONDS, 60, 3600);
  const blockSeconds = boundedInteger(environment.LOGIN_THROTTLE_BLOCK_SECONDS, 60, 86400);
  return maxFailures && windowSeconds && blockSeconds
    ? { maxFailures, windowSeconds, blockSeconds }
    : null;
}

export function loginThrottleKeyDigest(email: string, secret: string) {
  const normalized = email.trim().toLowerCase();
  const bounded = normalized.length >= 3 && normalized.length <= 254 ? normalized : '<invalid>';
  return createHmac('sha256', secret).update(`login-account-v1\0${bounded}`).digest('hex');
}

export function loginThrottleRuntime(
  email: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
) {
  const mode = loginThrottleMode(environment.LOGIN_THROTTLE_MODE);
  if (mode === 'disabled') return { mode } as const;
  const configuration = loginThrottleConfiguration(environment);
  const secret = environment.AUTH_SECRET;
  if (!configuration || !secret || secret.length < 32) return null;
  return {
    mode,
    configuration,
    keyDigest: loginThrottleKeyDigest(email, secret),
  } as const;
}

export async function loginAttemptAllowed(db: LoginThrottleDb, keyDigest: string) {
  const rows = await db.$queryRaw<Array<{ allowed: boolean }>>(Prisma.sql`
    SELECT COALESCE(
      (SELECT "blockedUntil" IS NULL OR "blockedUntil" <= CURRENT_TIMESTAMP
       FROM "LoginThrottleBucket" WHERE "keyDigest" = ${keyDigest}),
      TRUE
    ) AS allowed
  `);
  return rows[0]?.allowed === true;
}

export async function recordLoginFailure(
  db: LoginThrottleDb,
  keyDigest: string,
  configuration: LoginThrottleConfiguration,
) {
  const rows = await db.$queryRaw<Array<{ failedCount: number; blocked: boolean }>>(Prisma.sql`
    INSERT INTO "LoginThrottleBucket"
      ("keyDigest", "failedCount", "windowStartedAt", "blockedUntil", "createdAt", "updatedAt")
    VALUES (
      ${keyDigest},
      1,
      CURRENT_TIMESTAMP,
      CASE WHEN ${configuration.maxFailures} <= 1
        THEN CURRENT_TIMESTAMP + (${configuration.blockSeconds} * INTERVAL '1 second')
        ELSE NULL END,
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    )
    ON CONFLICT ("keyDigest") DO UPDATE SET
      "failedCount" = CASE
        WHEN "LoginThrottleBucket"."windowStartedAt" <= CURRENT_TIMESTAMP - (${configuration.windowSeconds} * INTERVAL '1 second')
          OR ("LoginThrottleBucket"."blockedUntil" IS NOT NULL AND "LoginThrottleBucket"."blockedUntil" <= CURRENT_TIMESTAMP)
          THEN 1
        ELSE LEAST("LoginThrottleBucket"."failedCount" + 1, 1000000)
      END,
      "windowStartedAt" = CASE
        WHEN "LoginThrottleBucket"."windowStartedAt" <= CURRENT_TIMESTAMP - (${configuration.windowSeconds} * INTERVAL '1 second')
          OR ("LoginThrottleBucket"."blockedUntil" IS NOT NULL AND "LoginThrottleBucket"."blockedUntil" <= CURRENT_TIMESTAMP)
          THEN CURRENT_TIMESTAMP
        ELSE "LoginThrottleBucket"."windowStartedAt"
      END,
      "blockedUntil" = CASE
        WHEN (
          CASE
            WHEN "LoginThrottleBucket"."windowStartedAt" <= CURRENT_TIMESTAMP - (${configuration.windowSeconds} * INTERVAL '1 second')
              OR ("LoginThrottleBucket"."blockedUntil" IS NOT NULL AND "LoginThrottleBucket"."blockedUntil" <= CURRENT_TIMESTAMP)
              THEN 1
            ELSE "LoginThrottleBucket"."failedCount" + 1
          END
        ) >= ${configuration.maxFailures}
          THEN CURRENT_TIMESTAMP + (${configuration.blockSeconds} * INTERVAL '1 second')
        ELSE NULL
      END,
      "updatedAt" = CURRENT_TIMESTAMP
    RETURNING "failedCount", ("blockedUntil" IS NOT NULL AND "blockedUntil" > CURRENT_TIMESTAMP) AS blocked
  `);
  return rows[0] ?? { failedCount: 0, blocked: false };
}

export async function clearLoginThrottle(db: LoginThrottleDb, keyDigest: string) {
  await db.$executeRaw(Prisma.sql`DELETE FROM "LoginThrottleBucket" WHERE "keyDigest" = ${keyDigest}`);
}
