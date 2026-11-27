import { requireAuth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { Card, PageHeader, Badge } from '@/components/ui';
import { SecondaryLink } from '@/components/actions';
import { withTechnicalPage } from '@/lib/technical-surface-guards';
import { readWorkflowIntegrations } from '@/lib/workflow-integrations';
import { formatRecordNoticeTime } from '@/lib/record-notice-time';

export const dynamic = 'force-dynamic';
async function IntegrationsPage() {
  const session = await requireAuth(['admin']), data = await readWorkflowIntegrations(prisma, session);
  return <div className="crm-space-y-6"><PageHeader title="Integrazioni" description="Funzioni disponibili, responsabili e risultati attestati dei collegamenti." />
    <Card title="Acquisizione dal sito · WordPress"><p>Il connettore esistente conserva una ricevuta per richiesta. La revisione dell’identità precede la coda operativa.</p>
      <p className="my-2">Gestione: Admin e responsabile sito. Ultima ricevuta: {formatRecordNoticeTime(data.latestReceipt?.createdAt)}{data.latestReceipt ? ` · ${data.latestReceipt.inboxEvent.state}` : ''}.</p>
      <p className="mb-3">Ultimo collaudo: consulta le evidenze di acquisizione. Una ricezione non attesta da sola destinazione dell’annuncio, clic o attribuzione Meta.</p><SecondaryLink href="/leads/acquisition">Ricevute ed eccezioni</SecondaryLink>
    </Card>
    <Card title="Mittente aziendale"><p>La configurazione della casella, la sua prova e l’autorità di invio sono controlli distinti.</p>
      {data.mailboxes.map(box => <article key={box.address} className="my-3 rounded-xl border p-3"><h2 className="font-bold">{box.address}</h2><p>{box.purpose} · responsabile: {box.responsible}</p>
        <p>Invio: {box.canSend ? 'configurato' : 'non configurato'} · ricezione: {box.canReceive ? 'configurata' : 'non configurata'} · stato: {box.enabled ? 'abilitata nel percorso autorizzato' : box.configured ? 'da qualificare' : 'da configurare'}</p>
        <p>Ultima prova della revisione corrente: {box.tested ? formatRecordNoticeTime(box.testedAt) : 'non attestata'}.</p></article>)}
      <SecondaryLink href="/settings/communications">Gestisci caselle e risposte</SecondaryLink>
    </Card>
    <Card title="Google Calendar · per persona" action={<Badge tone={data.calendarConnectionAvailable ? 'green' : 'gray'}>{data.calendarConnectionAvailable ? 'Connessione disponibile' : 'Connessione da autorizzare'}</Badge>}>
      <p>Ogni proprietario gestisce il proprio collegamento. Disponibilità, prenotazione, spostamento e annullamento conservano l’evento collegato.</p>
      {data.calendars.length ? data.calendars.map(calendar => <article key={calendar.userId} className="my-3 rounded-xl border p-3"><h2 className="font-bold">{calendar.user.name}</h2><p>Modalità: {calendar.mode === 'GOOGLE' ? 'Google Calendar' : 'Calendario CRM'} · gestore: {calendar.user.name}</p><p>Ultima prova: {formatRecordNoticeTime(calendar.lastTestAt)} · {calendar.lastTestStatus ?? 'non eseguita'}</p></article>) : <p className="my-3">Nessun calendario personale configurato.</p>}
      <SecondaryLink href="/calendars">Calendari e disponibilità</SecondaryLink>
    </Card>
    <Card title="Google Drive · cartelle dei fascicoli"><p>Il CRM conserva collegamenti e accessi autorizzati. Il caricamento dei documenti avviene in Drive.</p><p className="my-2">Gestione: Admin per i riferimenti, proprietario Drive per i permessi. {data.activeDriveReferences} cartelle attive su {data.driveReferences} registrate.</p><p className="mb-3">Ultima prova dei permessi Google: non attestata da questo registro. L’apertura con il rispettivo profilo resta la verifica del ruolo.</p><SecondaryLink href="/drive-folders">Apri la libreria cartelle</SecondaryLink></Card>
    <Card title="Automazioni e newsletter"><p>Editor, modelli e registro di prova disponibili. Invii automatici reali non attivi.</p><p className="my-2">Gestione: Admin. Ultima prova sintetica: {formatRecordNoticeTime(data.latestAutomationTest?.createdAt)}.</p><SecondaryLink href="/automations">Automazioni</SecondaryLink></Card>
    <Card title="Servizi documentali e WhatsApp"><p>Tek01: creazione, invio e PDF via API esterna da confermare per il piano FAI, insieme ad ambiente di prova e costi.</p><p className="mt-2">GoHighLevel e LeadConnector mantengono il numero WhatsApp che termina in 7408. Un numero aggiuntivo per il CRM sarà valutato dopo il consolidamento del flusso.</p></Card>
  </div>;
}
export default withTechnicalPage('/settings/integrations', IntegrationsPage);
