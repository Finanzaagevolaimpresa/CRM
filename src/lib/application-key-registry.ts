import { timingSafeEqual } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { privilegedStepUpKeyDigest, type PrivilegedStepUpKey } from './privileged-step-up-token';

export const PRIVILEGED_STEP_UP_KEY_PURPOSE = 'PRIVILEGED_STEP_UP';

type KeyRegistryDb = Pick<PrismaClient, 'applicationKeyVersion'>;
type RegisteredKey = { keyDigest: Uint8Array; status: string; activatedAt: Date | null; retiredAt: Date | null };

function registeredKeyMatches(configured: PrivilegedStepUpKey, registered: RegisteredKey | null | undefined) {
  if (!Number.isSafeInteger(configured.version) || configured.version <= 0 || configured.secret.length < 32
    || !registered || registered.status !== 'ACTIVE' || !registered.activatedAt || registered.retiredAt) return false;
  const configuredDigest = privilegedStepUpKeyDigest(configured.secret);
  const registeredDigest = Buffer.from(registered.keyDigest);
  return configuredDigest.length === registeredDigest.length && timingSafeEqual(configuredDigest, registeredDigest);
}

export function privilegedStepUpEnvironmentKey(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): PrivilegedStepUpKey | null {
  const rawVersion = environment.PRIVILEGED_STEP_UP_KEY_VERSION;
  const secret = environment.PRIVILEGED_STEP_UP_SECRET;
  if (!rawVersion || !/^[1-9][0-9]{0,8}$/.test(rawVersion) || !secret || secret.length < 32) return null;
  return { version: Number(rawVersion), secret };
}

export async function loadActivePrivilegedStepUpKey(
  db: KeyRegistryDb,
  environment: Readonly<Record<string, string | undefined>> = process.env,
) {
  const configured = privilegedStepUpEnvironmentKey(environment);
  if (!configured) return null;
  const registered = await db.applicationKeyVersion.findUnique({
    where: {
      purpose_version: {
        purpose: PRIVILEGED_STEP_UP_KEY_PURPOSE,
        version: configured.version,
      },
    },
    select: { keyDigest: true, status: true, activatedAt: true, retiredAt: true },
  });
  return registeredKeyMatches(configured, registered) ? configured : null;
}

/** Revalidate the server key inside a mutation transaction and hold its row
 * until commit. Take this lock before actor/context locks: native rotation
 * updates the key before writing its actor-linked audit. */
export async function lockRegisteredPrivilegedStepUpKey(tx: Prisma.TransactionClient, configured: PrivilegedStepUpKey) {
  const rows = await tx.$queryRaw<RegisteredKey[]>(Prisma.sql`
    SELECT "keyDigest", "status", "activatedAt", "retiredAt" FROM "ApplicationKeyVersion"
    WHERE "purpose"=${PRIVILEGED_STEP_UP_KEY_PURPOSE} AND "version"=${configured.version} FOR SHARE
  `);
  return registeredKeyMatches(configured, rows[0]) ? configured : null;
}

export async function rotatePrivilegedStepUpKeyVersion(
  tx: Prisma.TransactionClient,
  input: { version: number; keyDigest: Uint8Array; actorUserId: string },
) {
  if (!Number.isSafeInteger(input.version) || input.version <= 0 || input.keyDigest.length !== 32) {
    throw new TypeError('PRIVILEGED_STEP_UP_KEY_ROTATION_INPUT_INVALID');
  }
  await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext('FAI_PRIVILEGED_STEP_UP_KEY_ROTATION_V1'))`);
  const actor = await tx.user.findFirst({
    where: { id: input.actorUserId, role: 'admin', active: true, deletedAt: null },
    select: { id: true },
  });
  if (!actor) throw new TypeError('PRIVILEGED_STEP_UP_KEY_ROTATION_ACTOR_DENIED');
  const current = await tx.applicationKeyVersion.findFirst({
    where: { purpose: PRIVILEGED_STEP_UP_KEY_PURPOSE, status: 'ACTIVE' },
    select: { id: true, version: true },
  });
  if (current && input.version <= current.version) {
    throw new TypeError('PRIVILEGED_STEP_UP_KEY_VERSION_NOT_MONOTONIC');
  }
  const databaseClock = await tx.$queryRaw<Array<{ now: Date }>>(Prisma.sql`SELECT CURRENT_TIMESTAMP AS now`);
  const now = databaseClock[0]?.now;
  if (!now) throw new TypeError('PRIVILEGED_STEP_UP_KEY_DATABASE_CLOCK_UNAVAILABLE');
  if (current) {
    await tx.applicationKeyVersion.update({
      where: { id: current.id },
      data: { status: 'RETIRED', retiredAt: now },
    });
  }
  const created = await tx.applicationKeyVersion.create({
    data: {
      purpose: PRIVILEGED_STEP_UP_KEY_PURPOSE,
      version: input.version,
      keyDigest: Buffer.from(input.keyDigest),
      status: 'ACTIVE',
      activatedAt: now,
      createdById: input.actorUserId,
    },
  });
  await tx.auditLog.create({
    data: {
      actorId: input.actorUserId,
      event: 'application_key_version_rotated',
      entityType: 'ApplicationKeyVersion',
      entityId: created.id,
      after: { purpose: PRIVILEGED_STEP_UP_KEY_PURPOSE, version: input.version },
    },
  });
  return created;
}
