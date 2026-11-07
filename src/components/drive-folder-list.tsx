import Link from 'next/link';
import type { listDriveFolders } from '@/lib/drive-folder-library';
import { EmptyState } from './ui';

export function DriveFolderList({ rows, manage = false }: { rows: Awaited<ReturnType<typeof listDriveFolders>>; manage?: boolean }) {
  if (!rows.length) return <EmptyState title={manage ? 'Nessun fascicolo collegato' : 'Nessuna cartella disponibile'}>
    {manage ? 'Aggiungi il riferimento a una cartella esistente. Nessun collegamento viene creato automaticamente.' : 'Vengono mostrate soltanto le cartelle attive selezionate per te e non scadute.'}
  </EmptyState>;
  return <ul className="grid gap-4 sm:grid-cols-2" data-testid="drive-folder-list">{rows.map(row => <li key={row.id} className="min-w-0 space-y-3 rounded-xl border bg-white p-5" data-folder-id={row.id}>
    <h2 className="break-words font-bold">{row.title}</h2><p className="break-words">{row.clientName}</p>
    {manage && <p>{row.state === 'ACTIVE' ? 'Attivo' : row.state === 'DRAFT' ? 'Bozza privata' : 'Disabilitato'} · revisione {row.version}
      {!row.clientCurrent && ' · associazione cliente da riconfermare o cliente non disponibile'}{row.expired && ' · scaduto'}</p>}
    {row.expiresAt && <p className="text-sm">Scadenza CRM: {new Date(row.expiresAt).toLocaleString('it-IT')}</p>}
    {manage ? <Link className="font-bold underline" href={'/drive-folders/manage/' + row.id}>Gestisci collegamento e destinatari</Link>
      : <div className="flex flex-wrap gap-3"><Link className="underline" href={'/drive-folders/' + row.id}>Dettaglio del riferimento</Link>
        <a className="font-bold underline" href={'/drive-folders/' + row.id + '/open'} target="_blank" rel="noopener noreferrer">Apri cartella Drive</a></div>}
  </li>)}</ul>;
}
