import type { PrismaClient } from '@prisma/client';
import type { AuthSession } from './auth';
import { updateActor } from './record-updates';
import { readCommunicationAdministration } from './approved-communications';
import { listDriveFolders } from './drive-folder-library';
import { calendarOAuthConfig } from './google-calendar-oauth';

/** Read-only capability inventory. Stored configuration, an observed receipt,
 * and a successful test remain distinct; credentials never enter this DTO. */
export async function readWorkflowIntegrations(db: PrismaClient, session: AuthSession) {
  const base = await db.$transaction(async tx => {
    const auth = await updateActor(tx, session);
    if (auth.actor.role !== 'admin') throw new Error('INTEGRATIONS_DENIED');
    const [latestReceipt, calendars, latestAutomationTest] = await Promise.all([
      tx.secureLeadGatewayReceipt.findFirst({ orderBy: { createdAt: 'desc' }, select: { id: true, createdAt: true,
        inboxEvent: { select: { state: true } } } }),
      tx.personalCalendar.findMany({ orderBy: { userId: 'asc' }, select: { userId: true, mode: true, lastTestAt: true,
        lastTestStatus: true, user: { select: { name: true } } } }),
      tx.workflowAutomationTest.findFirst({ orderBy: { createdAt: 'desc' }, select: { createdAt: true, result: true } }),
    ]);
    await auth.finish(); return { latestReceipt, calendars, latestAutomationTest };
  }, { timeout: 30_000 });
  const [communication, folders] = await Promise.all([
    readCommunicationAdministration(db, session), listDriveFolders(db, session, { manage: true }),
  ]);
  return { ...base, calendarConnectionAvailable: calendarOAuthConfig() !== null,
    mailboxes: communication.mailboxes.map(row => ({ address: row.address, purpose: row.purpose,
      responsible: communication.users.find(user => user.id === row.responsibleUserId)?.name ?? 'Da nominare',
      configured: row.qualification.configured, tested: row.qualification.tested, enabled: row.qualification.enabled,
      testedAt: row.testedAt, canSend: row.canSend, canReceive: row.canReceive })),
    driveReferences: folders.length, activeDriveReferences: folders.filter(row => row.state === 'ACTIVE' && !row.expired && row.clientCurrent).length };
}
