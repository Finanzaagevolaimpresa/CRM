import { randomUUID } from 'node:crypto';
import { Card, formatDateTime } from './ui';
import { PrimaryButton, SecondaryLink } from './actions';
import { DeliveryTimeInput } from './delivery-time-input';
import { importEngagementWorkResultAction } from '@/lib/engagement-dossier-actions';
import type { getEngagementDossierReadAccess } from '@/lib/engagement-dossier';
import { workProducerRoles } from '@/lib/engagement-work-package';
import { EngagementWorkDownload } from './engagement-work-download';

type Context = NonNullable<Awaited<ReturnType<typeof getEngagementDossierReadAccess>>>;

export function EngagementWorkExchange({ context, canWrite, canExport }: { context: Context; canWrite: boolean; canExport: boolean }) {
  const { dossier, engagementHistory: { versions, work } } = context;
  const version = versions.find(item => item.id === dossier.currentVersionId)!;
  const packages = work.packages.filter(item => item.sourceVersionId === version.id);
  return <Card title="Lavorazione manuale con Work">
    <p>Scarica il dossier e i materiali verificati, lavorali nella chat Work autorizzata e riporta qui il risultato. Ogni rientro crea una nuova bozza da revisionare.</p>
    <p className="mt-2 text-sm text-slate-600">Nessuna sincronizzazione tra chat o consegna al cliente. Limite del pacchetto: 50 MB, massimo 25 MB per documento. Conserva il file ZIP originale.</p>
    <div className="my-3 flex flex-wrap gap-3"><SecondaryLink href={`/practice-readiness#practice-${dossier.practiceReadinessId}`}>Incarico, pagamento e materiali</SecondaryLink><SecondaryLink href={`/clients/${dossier.clientId}#servizi`}>Attività e servizio nel fascicolo</SecondaryLink></div>
    {canExport ? <EngagementWorkDownload dossierId={dossier.id} versionId={version.id} packageId={randomUUID()}/> : <p>Per esportare servono i permessi di modifica dossier, lettura servizio e download dei documenti.</p>}
    {canWrite && packages.length ? <form action={importEngagementWorkResultAction} className="my-4 grid gap-3" aria-label="Rientro manuale da Work">
      <input type="hidden" name="dossierId" value={dossier.id}/><input type="hidden" name="expectedVersionId" value={version.id}/>
      <label>Pacchetto di origine<select name="packageBinding" className="w-full rounded-xl border p-3" required>{packages.map(item => <option key={item.id} value={`${item.id}:${item.artifactHash}`}>{item.id} · v{item.sourceVersion}</option>)}</select></label>
      <label>Riferimento della lavorazione Work<input name="workReference" maxLength={120} pattern="[A-Za-z][A-Za-z0-9_\-]{0,119}" required className="w-full rounded-xl border p-3" placeholder="Codice senza dati personali, es. WORK-001"/></label>
      <label>Ruolo del produttore dichiarato<select name="producer" className="w-full rounded-xl border p-3">{workProducerRoles.map(role => <option key={role} value={role}>{role}</option>)}</select></label>
      <DeliveryTimeInput label="Data e ora del risultato" name="returnedAt"/>
      <label>Titolo del risultato<input name="title" maxLength={200} required defaultValue={version.title} className="w-full rounded-xl border p-3"/></label>
      <label>Risultato da reinserire<textarea name="content" maxLength={200000} required className="min-h-64 w-full rounded-xl border p-3"/></label>
      <PrimaryButton type="submit">Registra risultato Work come nuova bozza</PrimaryButton>
    </form> : canWrite ? <p className="my-3">Scarica il pacchetto della versione corrente; poi riapri il dossier per registrarne il risultato.</p> : null}
    <details className="mt-4"><summary className="cursor-pointer font-semibold">Pacchetti e provenienza dei risultati ({work.packages.length} / {work.imports.length})</summary>
      {work.packages.map(item => <p key={item.id} className="my-2 break-all text-sm">Pacchetto {item.id} · v{item.sourceVersion} · {formatDateTime(new Date(item.exportedAt))} · SHA-256 {item.artifactHash}</p>)}
      {work.imports.map(item => <p key={item.id} className="my-2 text-sm">v{versions.find(row => row.id === item.versionId)?.version} · origine {item.packageId} · {item.workReference} · produttore dichiarato: {item.producer} · {formatDateTime(new Date(item.returnedAt))} · registrato {formatDateTime(item.importedAt)}</p>)}
    </details>
  </Card>;
}
