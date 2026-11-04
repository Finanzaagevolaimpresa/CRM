import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { AuthSession } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { readSelectedInternalCommunications } from '@/lib/selected-internal-communications';
import { ApprovedCommunicationError } from '@/lib/approved-communication-contract';
import { PageHeader, Card } from './ui';

export async function SelectedInternalCommunications({ session, threadId }: { session: AuthSession; threadId?: string }) {
  const threads = await readSelectedInternalCommunications(prisma, session, threadId).catch(error => {
    if (error instanceof ApprovedCommunicationError) notFound(); throw error;
  });
  return <div className="space-y-5 min-w-0"><PageHeader title="Comunicazioni interne"
    description="Testi approvati dall’Admin e selezionati per te. La partecipazione CRM è distinta dai destinatari delle email."/>
    <p>Le bozze restano private. La lettura richiede l’approvazione della versione esatta; non certifica invio, ricezione o lettura di un’email.</p>
    <p>Questa vista non apre clienti, pratiche, allegati, note riservate o altre informazioni collegate. Il testo non modifica lo stato operativo delle pratiche.</p>
    {threadId && <Link className="underline" href="/communications">Tutte le conversazioni disponibili</Link>}
    {threads.map(thread => <Card key={thread.id} title={thread.title}>
      {!threadId ? <Link className="underline" href={'/communications?kind=INTERNAL&practice=' + thread.id}>Apri conversazione</Link>
        : thread.messages.map(message => <article key={message.id} className="my-4 space-y-2">
          <h2 className="font-bold">{message.subject} · v{message.revision}</h2>
          <p>Testo approvato per la lettura{message.expiresAt ? ' · disponibile fino a ' + new Date(message.expiresAt).toLocaleString('it-IT') : ''}.</p>
          <div aria-label="Testo condiviso con i partecipanti" className="whitespace-pre-wrap break-words">{message.body}</div>
        </article>)}
      {threadId && !thread.messages.length && <p>Nessun testo approvato disponibile per te. Una bozza privata, revocata o scaduta non compare qui.</p>}
    </Card>)}
    {!threads.length && <p>Nessuna conversazione disponibile per il tuo account.</p>}
  </div>;
}
