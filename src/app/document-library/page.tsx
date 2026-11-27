import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireSession } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { canUseOperationalDocuments, documentKindLabels } from '@/lib/operational-document-contract';
import { listOperationalTemplates, searchOperationalDocumentClient } from '@/lib/operational-documents';
import { Card, EmptyState, PageHeader } from '@/components/ui';
import { withTechnicalPage } from '@/lib/technical-surface-guards';
export const dynamic = 'force-dynamic';

async function Page({ searchParams }: { searchParams: Promise<{ fiscal?: string }> }) {
  const session = await requireSession(); if (!canUseOperationalDocuments(session)) notFound();
  const { fiscal } = await searchParams, templates = await listOperationalTemplates(prisma, session);
  const validQuery = fiscal && /^(?:[0-9]{11}|[A-Za-z0-9]{16})$/.test(fiscal.trim());
  const matches = validQuery ? await searchOperationalDocumentClient(prisma, session, fiscal) : null;
  return <div className="crm-space-y-6"><PageHeader title="Documenti e Contratti" description="Modelli approvati, bozze indipendenti, anteprima e cronologia del caso."/>
    {session.role === 'admin' && <Link href="/document-library/templates" className="font-bold text-fai-blue underline">Gestisci libreria Modelli</Link>}
    <Card title="Parti dalla scheda assegnata"><p>Apri il lead dalla tua coda e scegli «Crea contratto da modello». Ritrovi nella stessa vista i documenti già preparati.</p><Link href="/leads/work" className="font-bold text-fai-blue underline">Apri la mia coda</Link></Card>
    <Card title="Cerca anagrafica per partita IVA o codice fiscale"><form className="flex flex-wrap gap-3"><input name="fiscal" defaultValue={fiscal ?? ''} className="rounded-xl border p-3" placeholder="P.IVA o codice fiscale" required maxLength={16}/><button className="rounded-xl bg-fai-green px-4 py-2 font-bold text-white">Cerca</button></form>
      {fiscal && !validQuery && <p role="alert">Inserisci una partita IVA di 11 cifre o un codice fiscale di 16 caratteri.</p>}
      {matches && <div className="mt-3 space-y-2"><p>{matches.length === 1 ? 'Corrispondenza univoca nel tuo perimetro.' : matches.length ? 'Più anagrafiche corrispondono: scegli quella corretta.' : 'Nessuna corrispondenza nel tuo perimetro.'}</p>
        {matches.map(row => <Link className="block font-bold underline" key={row.id} href={'/document-library/new?client=' + encodeURIComponent(row.id)}>{row.name} · prepara documento</Link>)}</div>}
    </Card>
    <Card title="Modelli disponibili">{templates.length ? <ul className="space-y-3">{templates.map(row => <li key={row.id}><strong>{row.title}</strong> · {documentKindLabels[row.kind]} · versione {row.revision}</li>)}</ul>
      : <EmptyState title="Nessun modello pubblicato">L’Admin deve pubblicare il testo aziendale autorizzato prima della prima generazione.</EmptyState>}</Card>
  </div>;
}
export default withTechnicalPage('/document-library', Page);
