export type ClientServiceLabelInput = {
  practiceType?: string | null;
  serviceCatalogId?: string | null;
  operationalStatus?: string | null;
  requestedAmount?: unknown;
  plannedInvestment?: unknown;
};

export type ServiceCatalogLabelInput = { id: string; name?: string | null };

function hasValue(value: unknown) {
  return value !== null && value !== undefined && String(value).trim() !== '';
}

function moneyLabel(value: unknown) {
  if (!hasValue(value)) return null;
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return String(value);
  return `€ ${numberValue.toLocaleString('it-IT')}`;
}

function humanStatus(value?: string | null) {
  return hasValue(value) ? String(value).replaceAll('_', ' ') : null;
}

export function buildClientServiceLabel(
  service?: ClientServiceLabelInput | null,
  serviceCatalog?: ServiceCatalogLabelInput | null,
  fallback = 'Pratica cliente',
) {
  if (!service) return fallback;
  const primary = [service.practiceType, serviceCatalog?.name].filter(hasValue).map(String).join(' · ');
  const details = [
    humanStatus(service.operationalStatus),
    moneyLabel(service.requestedAmount) ? `richiesto ${moneyLabel(service.requestedAmount)}` : null,
    moneyLabel(service.plannedInvestment) ? `investimento ${moneyLabel(service.plannedInvestment)}` : null,
  ].filter(hasValue).map(String);
  const label = [primary, details.length ? details.join(' · ') : null].filter(hasValue).join(' — ');
  return label || fallback;
}

export function findServiceCatalogLabel(
  service: ClientServiceLabelInput | null | undefined,
  catalog: ServiceCatalogLabelInput[] = [],
) {
  return service?.serviceCatalogId ? catalog.find((item) => item.id === service.serviceCatalogId) ?? null : null;
}
