import { notFound } from 'next/navigation';
import Link from 'next/link';
import { Card, PageHeader } from '@/components/ui';
import { DirectEmailTestForm } from '@/components/direct-email-test-form';
import { requirePermission } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { DirectTestError, readDirectTestConfig } from '@/lib/direct-email-test';
import { previewDirectEmailTest } from '@/lib/direct-email-test-service';
import { sendDirectEmailTestAction } from '@/lib/direct-email-test-actions';

export const dynamic = 'force-dynamic';
const outcomes: Record<string, string> = {
  ACCEPTED: 'Il server email ha accettato il messaggio. Verifica il recapito nella casella destinataria: l’accettazione non dimostra ricezione o lettura.',
  NOT_SENT: 'Il trasporto non ha accettato il messaggio. Questo tentativo è concluso e non sarà ripetuto automaticamente.',
  UNCERTAIN: 'Il tentativo è in corso o il suo esito non è verificabile. Controlla il provider e la casella destinataria prima di autorizzare un nuovo test. Il CRM non ripete questo tentativo.',
};
export default async function Page({ searchParams }: { searchParams: Promise<{ result?: string }> }) {
  const session = await requirePermission('settings.manage');
  if (session.role !== 'admin') notFound();
  const query = await searchParams;
  let preview: Awaited<ReturnType<typeof previewDirectEmailTest>> | null = null;
  let unavailable = 'Il test diretto non è abilitato. La qualifica delle caselle per l’invio manuale non configura questo collegamento.';
  if (readDirectTestConfig()) {
    try { preview = await previewDirectEmailTest(prisma, session); }
    catch (error) {
      if (!(error instanceof DirectTestError)) throw error;
      unavailable = 'Test non disponibile: verifica autorizzazione, responsabile e qualifica della casella comunicazioni.';
    }
  }
  return <div className="crm-space-y-6"><PageHeader title="Test di invio diretto" description="Una prova tecnica dalla casella comunicazioni a un solo destinatario controllato." />
    <Link href="/settings/communications">Torna alle caselle</Link>
    {query.result && !outcomes[query.result] ? <p role="status">Operazione non eseguita. Riapri il riepilogo e verifica accesso e configurazione.</p> : null}
    <Card title="Test email">
      {preview?.outcome ? <p role="status">{outcomes[preview.outcome]}</p>
        : preview?.token ? <DirectEmailTestForm token={preview.token} message={preview.message} action={sendDirectEmailTestAction} />
          : <p>{unavailable}</p>}
    </Card>
  </div>;
}
