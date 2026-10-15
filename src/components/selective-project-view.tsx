import type { SelectiveProjection } from '@/lib/selective-project-access';

/** The same projection and renderer serve preview and effective access. */
export function SelectiveProjectView({ projection, preview = false, previewToken }: { projection: SelectiveProjection; preview?: boolean; previewToken?: string }) {
  return <section className="space-y-5 rounded-xl border bg-white p-5" aria-label={preview ? 'Anteprima come utente' : 'Progetto condiviso'}>
    <h2 className="text-xl font-bold">{preview ? 'Anteprima come utente' : 'Informazioni condivise'}</h2>
    <dl className="space-y-3">{projection.fields.map(field => <div key={field.key}><dt className="font-semibold">{field.label}</dt><dd className="whitespace-pre-wrap">{field.value}</dd></div>)}</dl>
    <h3 className="font-semibold">Documenti selezionati</h3>
    {projection.documents.length === 0 && <p>Nessun documento condiviso.</p>}
    <ul className="space-y-3">{projection.documents.map(doc => {
      const base = `/shared-projects/${encodeURIComponent(projection.projectId)}/documents/${encodeURIComponent(doc.versionId)}`;
      return <li key={doc.versionId} className="rounded border p-3">
        <p>{doc.title} — versione {doc.version}</p><p className="text-sm">{doc.fileName} · {doc.download ? 'Consultazione e scaricamento' : 'Consultazione'}</p>
        {!preview && <div className="flex gap-4"><a className="underline" href={base} target="_blank" rel="noreferrer">Consulta</a>
          {doc.download && <a className="underline" href={`${base}?download=1`}>Scarica questa versione</a>}</div>}
        {preview && previewToken && <form method="post" action={`/projects/${encodeURIComponent(projection.projectId)}/share/preview-document`} target="_blank">
          <input type="hidden" name="token" value={previewToken} /><input type="hidden" name="versionId" value={doc.versionId} />
          <button className="underline">Consulta in anteprima</button>
        </form>}
      </li>;
    })}</ul>
    <p className="text-sm">{projection.expiresAt ? `Scadenza: ${new Date(projection.expiresAt).toLocaleString('it-IT', { timeZone: 'Europe/Rome' })}` : 'Nessuna scadenza impostata.'}</p>
    <p className="text-sm">Accesso in sola lettura. La revoca blocca le nuove richieste; non recupera copie già acquisite.</p>
  </section>;
}
