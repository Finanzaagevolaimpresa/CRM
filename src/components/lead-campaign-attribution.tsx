import { Card, formatDateTime } from './ui';
import type { readAdminLeadAttribution } from '@/lib/lead-acquisition';

export function LeadCampaignAttribution({ items }: {
  items: Awaited<ReturnType<typeof readAdminLeadAttribution>>;
}) {
  return <Card title="Attribuzione campagne">
    <p className="text-sm text-slate-600">Provenienza delle ultime richieste acquisite. I codici sono dichiarati dal link di ingresso: l’attribuzione pubblicitaria resta da verificare sulla piattaforma.</p>
    {!items.length && <p>Nessuna attribuzione acquisita disponibile.</p>}
    <div className="crm-space-y-3">{items.map((item) => <div key={item.id} className="rounded-xl border border-slate-200 p-3">
      <p>Richiesta acquisita il {formatDateTime(item.createdAt)}</p>
      {!item.verified || !item.event ? <p>Ricevuta da riconciliare: attribuzione non mostrata.</p> : <>
        <p>Origine: {item.event.source.systemCode === 'WORDPRESS' ? 'WordPress' : item.event.source.systemCode} · modulo {item.event.source.formCode}</p>
        {item.event.sourcePagePath && <p>Pagina di ingresso: {item.event.sourcePagePath}</p>}
        <p>Ricevuta verificata e associata a questa scheda. Prossimo passo: segui la prossima azione e l’appuntamento riportati sotto.</p>
        <dl className="grid gap-1">
          <div><dt className="inline font-semibold">Piattaforma: </dt><dd className="inline">{item.event.campaignPlatform === 'META' ? 'Meta' : item.event.campaignPlatform === 'CHATGPT' ? 'ChatGPT' : 'Non disponibile'}</dd></div>
          <div><dt className="inline font-semibold">Codice campagna: </dt><dd className="inline">{item.event.campaignCode ?? 'Non disponibile'}</dd></div>
          <div><dt className="inline font-semibold">Codice annuncio: </dt><dd className="inline">{item.event.adCode ?? 'Non disponibile'}</dd></div>
        </dl>
      </>}
    </div>)}</div>
  </Card>;
}
