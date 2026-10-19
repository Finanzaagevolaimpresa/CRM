import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireSession } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { serviceRegistrationSetup } from '@/lib/client-service-registration';
import { ClientServiceRegistrationForm } from '@/components/client-service-registration-form';
import { Card, PageHeader } from '@/components/ui';
import { ServiceRegistrationError } from '@/lib/client-service-registration-contract';
import { RecordUpdateError } from '@/lib/record-update-contract';
import { ProjectUnavailableError } from '@/lib/project-lifecycle-lock';
import { SerializableConflictError } from '@/lib/serializable';

export default async function RegisterServicePage({ params, searchParams }: {
  params: Promise<{ id: string }>; searchParams: Promise<{ catalogQ?: string; contractQ?: string; serviceId?: string }>;
}) {
  const session = await requireSession(), { id } = await params, query = await searchParams;
  let setup: Awaited<ReturnType<typeof serviceRegistrationSetup>>;
  try {
    // A reload may race a committed registration. Retry only this read-only
    // setup once with a fresh snapshot; never replay a mutation implicitly.
    try { setup = await serviceRegistrationSetup(prisma, session, id, { catalogQuery: query.catalogQ, contractQuery: query.contractQ, serviceId: query.serviceId }); }
    catch (error) {
      if (!(error instanceof SerializableConflictError)) throw error;
      setup = await serviceRegistrationSetup(prisma, session, id, { catalogQuery: query.catalogQ, contractQuery: query.contractQ, serviceId: query.serviceId });
    }
  }
  catch (error) {
    if (error instanceof SerializableConflictError) return <Card title="Verifica del fascicolo in corso">
      <p>Un’altra operazione sta aggiornando il fascicolo. Riapri il modulo per verificare l’esito del salvataggio precedente.</p>
      <Link className="underline" href={`/clients/${id}/services/new${query.serviceId ? `?serviceId=${encodeURIComponent(query.serviceId)}` : ''}`}>Riapri il modulo</Link>
    </Card>;
    if (error instanceof ServiceRegistrationError || error instanceof RecordUpdateError || error instanceof ProjectUnavailableError) notFound();
    throw error;
  }
  return <div className="crm-space-y-6 min-w-0">
    <PageHeader title={setup.serviceId ? 'Collega pagamento al servizio' : 'Registra servizio acquistato'} description={setup.client.name} />
    <Link className="font-semibold text-fai-blue underline" href={`/clients/${id}#servizi-acquistati`}>Torna ai servizi acquistati</Link>
    <Card title="Servizio e incarico del cliente">
      {!setup.reconciliationOnly && <p className="mb-4 text-slate-600">Registra un servizio previsto da un incarico firmato già presente nel CRM. Il servizio apparirà nel fascicolo; potrai poi affidarlo all’ufficio tecnico.</p>}
      {!setup.serviceId && <form method="get" className="mb-5 grid min-w-0 gap-3 sm:grid-cols-3" aria-label="Cerca servizio e incarico">
        <label className="min-w-0">Cerca nel catalogo<input name="catalogQ" maxLength={80} defaultValue={query.catalogQ ?? ''} className="block w-full min-w-0 rounded-xl border p-3" /></label>
        <label className="min-w-0">Cerca incarico<input name="contractQ" maxLength={80} defaultValue={query.contractQ ?? ''} className="block w-full min-w-0 rounded-xl border p-3" /></label>
        <button className="self-end rounded-xl border border-fai-blue p-3 font-semibold text-fai-blue">Cerca</button>
      </form>}
      {(setup.moreCatalogs || setup.moreContracts) && <p className="mb-3">Sono presenti altri risultati: restringi la ricerca con nome o numero.</p>}
      {!setup.reconciliationOnly && !setup.catalogs.length && <p className="mb-4 rounded-xl bg-amber-50 p-4">Nessun servizio attivo trovato. Verifica il <Link className="underline" href="/service-catalog">Catalogo servizi</Link> o modifica la ricerca.</p>}
      {!setup.reconciliationOnly && !setup.contracts.length && <p className="mb-4 rounded-xl bg-amber-50 p-4">Non risulta un incarico firmato disponibile per questa scelta. Apri <Link className="underline" href="/contracts">Contratti</Link>, registra l’incarico effettivo del cliente e completa la firma con il documento corrispondente. Poi torna qui.</p>}
      <ClientServiceRegistrationForm key={`${query.catalogQ ?? ''}:${query.contractQ ?? ''}:${setup.serviceId ?? ''}`} setup={setup} />
    </Card>
  </div>;
}
