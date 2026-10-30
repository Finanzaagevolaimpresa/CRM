import { randomUUID } from 'node:crypto';
import Link from 'next/link';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { adminUserVersion, type AdminUserOperation, type AdminUserVersionInput } from '@/lib/admin-user-command-contract';
import { AdminUserForm } from './admin-user-form';

const field = 'block w-full rounded-xl border p-3';
const button = 'rounded-xl bg-fai-green px-4 py-3 font-bold text-white disabled:opacity-50';
const identity = (user: AdminUserVersionInput, operation: AdminUserOperation) => ({ operation, commandId: randomUUID(), userId: user.id, expectedVersion: adminUserVersion(user) });
const date = (value: Date) => new Intl.DateTimeFormat('it-IT', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Rome' }).format(value);

export async function AdminAccountManagement({ user, available, sessionAfter }: { user: AdminUserVersionInput; available: boolean; sessionAfter?: string }) {
  if (!available) return <p>La gestione account non è disponibile.</p>;
  const parsedCursor = z.string().uuid().safeParse(sessionAfter), cursor = parsedCursor.success ? parsedCursor.data : undefined;
  const sessions = await prisma.internalSession.findMany({ where: { userId: user.id, revokedAt: null, expiresAt: { gt: new Date() }, ...(cursor ? { id: { gt: cursor } } : {}) },
    orderBy: { id: 'asc' }, take: 51, select: { id: true, createdAt: true, expiresAt: true } });
  const shown = sessions.slice(0, 50);
  return <div className="crm-space-y-6">
    <AdminUserForm identity={identity(user, 'PROFILE')} label="Modifica profilo" className="crm-space-y-3">
      <h3 className="text-lg font-bold">Dati professionali</h3>
      <label>Nome<input className={field} name="name" defaultValue={user.name} required maxLength={120} /></label>
      <label>Email di accesso<input className={field} name="email" type="email" defaultValue={user.email} required maxLength={254} /></label>
      <p>Il cambio dell’email revoca tutte le sessioni dell’account.</p><button className={button}>Salva profilo</button>
    </AdminUserForm>
    <AdminUserForm identity={identity(user, 'PASSWORD_RESET')} label="Reimposta password" className="crm-space-y-3">
      <h3 className="text-lg font-bold">Reimposta password</h3>
      <label>Nuova password<input className={field} name="password" type="password" autoComplete="new-password" required minLength={12} maxLength={72} /></label>
      <label>Conferma password<input className={field} name="confirmation" type="password" autoComplete="new-password" required minLength={12} maxLength={72} /></label>
      <p>Usa almeno 12 caratteri e al massimo 72 byte. Il salvataggio chiude tutte le sessioni dell’account.</p>
      <button className={button}>Reimposta password</button>
    </AdminUserForm>
    <section aria-label="Sessioni aperte dell’account" className="crm-space-y-3">
      <h3 className="text-lg font-bold">Accessi aperti</h3><p>Orari in Europe/Rome. La revoca impedisce nuove operazioni da quell’accesso.</p>
      {shown.length === 0 && <p>Nessun accesso aperto in questa pagina.</p>}
      {shown.map((session, index) => <AdminUserForm key={session.id} identity={identity(user, 'REVOKE_SESSION')} label={'Revoca singolo accesso ' + (index + 1)} className="flex flex-wrap items-center gap-3 rounded-xl border p-3">
        <input type="hidden" name="targetSessionId" value={session.id} /><span>Aperto il {date(session.createdAt)} · scade il {date(session.expiresAt)}</span>
        <button className={button}>Revoca questo accesso</button>
      </AdminUserForm>)}
      <div className="flex gap-4">{cursor && <Link href={'/settings/users/' + user.id}>Prima pagina accessi</Link>}
        {sessions.length > 50 && <Link href={'/settings/users/' + user.id + '?sessionAfter=' + shown[49].id}>Altri accessi aperti</Link>}</div>
      <AdminUserForm identity={identity(user, 'REVOKE_SESSIONS')} label="Revoca sessioni"><button className={button}>Revoca tutte le sessioni</button></AdminUserForm>
    </section>
  </div>;
}

export function AdminAccountLifecycle({ user, available }: { user: AdminUserVersionInput; available: boolean }) {
  const removed = Boolean(user.deletedAt);
  return <AdminUserForm identity={identity(user, removed ? 'RESTORE' : 'REMOVE')} label={removed ? 'Ripristino account' : 'Rimozione account'} disabled={!available} className="crm-space-y-3">
    <p>{removed ? 'Ripristina la stessa identità e lo storico. L’account resta disattivato; le sessioni revocate restano chiuse.'
      : 'L’accesso viene revocato. Identità, storico e attività assegnate restano nella coda amministrativa fino alla riassegnazione.'}</p>
    <label className="flex gap-2"><input type="checkbox" name={removed ? 'restoreInactive' : 'retainHistory'} required />{removed
      ? 'Ripristino l’identità conservando l’accesso disattivato.' : 'Conservo storico e attività nella coda amministrativa.'}</label>
    <button className={button}>{removed ? 'Ripristina account disattivato' : 'Rimuovi account'}</button>
  </AdminUserForm>;
}
