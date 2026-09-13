export const dynamic = 'force-dynamic';

import { Card, EmptyState, PageHeader } from '@/components/ui';
import { requirePermission } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { DIGITAL_PROJECT_TYPES, FAI_SERVICE_CATALOG_V2, FAI_SERVICE_CATALOG_V2_TERMS_VERSION, FAI_SERVICE_CATALOG_V2_VERSION, validateCatalogSelection } from '@/lib/service-catalog-v2';

function priceLabel(mode: string, cents: number | null) { return mode === 'QUOTE_ONLY' ? 'Su preventivo' : `€ ${((cents ?? 0) / 100).toLocaleString('it-IT', { minimumFractionDigits: 2 })} + IVA`; }

export default async function Page({ searchParams }: { searchParams: Promise<{ serviceCode?: string; digitalProjectType?: string }> }) {
  await requirePermission('service.read');
  const params = await searchParams;
  let selected: ReturnType<typeof validateCatalogSelection> | null = null;
  let selectionError = '';
  if (params.serviceCode) {
    try { selected = validateCatalogSelection(params.serviceCode, params.digitalProjectType || undefined); }
    catch { selectionError = 'La selezione non è valida o la tipologia digitale non è compatibile con il servizio.'; }
  }
  const histories = await prisma.serviceCatalogRevision.findMany({ include: { serviceCatalog: { select: { code: true } } }, orderBy: [{ serviceCatalogId: 'asc' }, { version: 'desc' }] });
  const historyByCode = new Map<string, typeof histories>();
  for (const revision of histories) historyByCode.set(revision.serviceCatalog.code, [...historyByCode.get(revision.serviceCatalog.code) ?? [], revision]);
  return <div className="space-y-6">
    <PageHeader title="Catalogo servizi" description={`Revisione corrente ${FAI_SERVICE_CATALOG_V2_VERSION}. Consultazione interna: richiesta, preventivo e incarico restano fasi separate.`} />
    <Card title="Seleziona un servizio"><form method="get" className="grid gap-3 md:grid-cols-3"><select name="serviceCode" required className="rounded-xl border p-3"><option value="">Scegli il servizio</option>{FAI_SERVICE_CATALOG_V2.map((service) => <option key={service.code} value={service.code}>{service.name} — {priceLabel(service.priceMode, service.netPriceCents)}</option>)}</select><select name="digitalProjectType" className="rounded-xl border p-3"><option value="">Nessuna tipologia digitale</option>{DIGITAL_PROJECT_TYPES.map((type) => <option key={type.code} value={type.code}>{type.label}</option>)}</select><button className="rounded-xl bg-fai-blue px-4 py-3 font-bold text-white" type="submit">Consulta selezione</button></form>{selectionError ? <p role="alert" className="mt-4 rounded-xl bg-red-50 p-3 text-sm font-semibold text-red-700">{selectionError}</p> : null}</Card>
    {selected ? <Card title="Selezione valida"><p className="font-bold text-fai-navy">{selected.service.name}</p><p>{priceLabel(selected.service.priceMode, selected.service.netPriceCents)}</p><p className="mt-2 text-sm text-slate-600">{selected.service.description}</p>{selected.digitalProjectType ? <p className="mt-2 text-sm"><strong>Tipologia:</strong> {DIGITAL_PROJECT_TYPES.find(({ code }) => code === selected.digitalProjectType)?.label}</p> : null}</Card> : null}
    <div className="grid gap-5 lg:grid-cols-2">{FAI_SERVICE_CATALOG_V2.map((service) => <Card key={service.code} title={service.name}><p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Revisione {service.revisionVersion} · {FAI_SERVICE_CATALOG_V2_TERMS_VERSION}</p><p className="mt-1 font-black text-fai-blue">{priceLabel(service.priceMode, service.netPriceCents)}</p><p className="mt-2 text-sm text-slate-600">{service.description}</p><h3 className="mt-4 font-bold">Inclusioni</h3><ul className="list-disc pl-5 text-sm">{service.detail.inclusions.map((item) => <li key={item}>{item}</li>)}</ul><h3 className="mt-4 font-bold">Esclusioni</h3><ul className="list-disc pl-5 text-sm">{service.detail.exclusions.map((item) => <li key={item}>{item}</li>)}</ul><h3 className="mt-4 font-bold">Documenti e fasi</h3><ul className="list-disc pl-5 text-sm">{service.detail.phaseDocuments.map((item) => <li key={item}>{item}</li>)}</ul><p className="mt-4 text-sm"><strong>Tempi:</strong> {service.detail.timing}</p><h3 className="mt-4 font-bold">Deliverable</h3><ul className="list-disc pl-5 text-sm">{service.detail.deliverables.map((item) => <li key={item}>{item}</li>)}</ul><h3 className="mt-4 font-bold">Incarichi successivi</h3><ul className="list-disc pl-5 text-sm">{service.detail.subsequentEngagements.map((item) => <li key={item}>{item}</li>)}</ul>{service.detail.professionalAttribution ? <p className="mt-3 rounded-xl bg-fai-blue/5 p-3 text-sm">{service.detail.professionalAttribution}</p> : null}{service.detail.digitalProjectTypes ? <><h3 className="mt-4 font-bold">Tipologie disponibili</h3><ul className="list-disc pl-5 text-sm">{DIGITAL_PROJECT_TYPES.map((item) => <li key={item.code}>{item.label}</li>)}</ul></> : null}<h3 className="mt-4 font-bold">Storico revisioni</h3>{(historyByCode.get(service.code) ?? []).length ? <ul className="text-sm">{historyByCode.get(service.code)!.map((revision) => <li key={revision.id}>Versione {revision.version} · {revision.priceMode === 'QUOTE_ONLY' ? 'Su preventivo' : `€ ${Number(revision.netPrice).toLocaleString('it-IT')} + IVA`} · {revision.status === 'PUBLISHED' ? 'corrente' : 'storica'}</li>)}</ul> : <EmptyState title="Revisione da preparare nel CRM sintetico" />}</Card>)}</div>
  </div>;
}
