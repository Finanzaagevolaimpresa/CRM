export const dynamic = 'force-dynamic';
import { notFound } from 'next/navigation';
import { requirePermission } from '@/lib/auth';
import { getLegacyDossierReadAccess } from '@/lib/read-access';
import { PrintDossierButton } from '@/components/print-dossier-button';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requirePermission('dossier.read'), { id } = await params;
  const context = await getLegacyDossierReadAccess(actor, id);
  if (!context) notFound();
  const { dossier } = context;
  return <article id="dossier-print" className="space-y-4 rounded-xl bg-white p-6 text-slate-950">
    <PrintDossierButton />
    <h1 className="text-2xl font-bold">{dossier.title}</h1>
    <p>Documento interno di lavoro · versione {dossier.version} · stato {dossier.status}</p>
    <p>La stampa conserva il contenuto visualizzato. Non costituisce una firma, un’approvazione o una ricevuta di consegna.</p>
    <div className="whitespace-pre-wrap">{dossier.markdownContent ?? 'Nessun testo presente.'}</div>
    {dossier.jsonContent != null && <section><h2 className="font-bold">Dati strutturati</h2><pre className="whitespace-pre-wrap break-words text-sm">{JSON.stringify(dossier.jsonContent, null, 2)}</pre></section>}
    <style>{`@media print { body * { visibility: hidden; } #dossier-print, #dossier-print * { visibility: visible; } #dossier-print { position: absolute; inset: 0; width: 100%; padding: 0; } [data-print-control] { display: none !important; } }`}</style>
  </article>;
}
