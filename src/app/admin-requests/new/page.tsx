import { randomUUID } from 'node:crypto';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireSession } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { readAdminRequestEntry, isRequestUnavailable } from '@/lib/admin-request-service';
import { AdminRequestForm } from '@/components/admin-request-form';
import { PageHeader } from '@/components/ui';
export const dynamic = 'force-dynamic';
export default async function Page({ searchParams }: { searchParams: Promise<{ kind?: string; id?: string }> }) {
  const query = await searchParams, user = await requireSession(); let entry;
  try { entry = await readAdminRequestEntry(prisma, user, { kind: query.kind, targetId: query.id }); }
  catch (error) { if (isRequestUnavailable(error)) notFound(); throw error; }
  return <div className="min-w-0 space-y-5"><PageHeader title="Richiedi documento o integrazione all’Admin" description="La richiesta resta interna e non autorizza comunicazioni al cliente." />
    <Link className="underline" href="/admin-requests">Le mie richieste</Link>
    <AdminRequestForm className="grid min-w-0 max-w-3xl gap-4">
      <input type="hidden" name="action" value="SUBMIT" /><input type="hidden" name="commandId" value={randomUUID()} />
      <input type="hidden" name="subjectKind" value={entry.subject.kind} /><input type="hidden" name="targetId" value={entry.subject.targetId} />
      <input type="hidden" name="expectedContextSha256" value={entry.expectedContextSha256} /><input type="hidden" name="expectedRecipientEpoch" value={entry.expectedRecipientEpoch} /><input type="hidden" name="expectedAccessRevision" value={entry.expectedAccessRevision} />
      <label>Tipo<select name="kind" className="block w-full rounded-xl border p-3"><option value="DOCUMENT">Documento</option><option value="INTEGRATION">Integrazione</option></select></label>
      <label>Oggetto della richiesta<input required minLength={3} maxLength={160} name="title" className="block w-full rounded-xl border p-3" /></label>
      <label>Indicazioni interne<textarea required minLength={3} maxLength={3000} rows={6} name="details" className="block w-full rounded-xl border p-3" /></label>
      <p>Descrivi ciò che serve per questo record. L’Admin rivedrà la richiesta e deciderà personalmente testo, destinatari e allegati dell’eventuale email.</p>
      <button type="submit" className="rounded-xl bg-fai-navy p-3 font-bold text-white">Invia richiesta interna all’Admin</button>
    </AdminRequestForm>
  </div>;
}
