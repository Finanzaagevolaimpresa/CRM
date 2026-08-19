import { canonicalSha256 } from './canonical-json';

export const FAI_SERVICE_CATALOG_VERSION = '2026-07-12-v1' as const;
export const FAI_SERVICE_CATALOG_VALID_FROM = '2026-07-12T00:00:00.000Z' as const;
export const FAI_SERVICE_CATALOG_TERMS_VERSION = 'TERMS-v1' as const;
export const FAI_SERVICE_CATALOG_CURRENCY = 'EUR' as const;
export const FAI_SERVICE_CATALOG_VAT_RATE_BPS = 2_200 as const;

export const SERVICE_CATALOG_PRICE_MODES = ['FIXED', 'QUOTE_ONLY'] as const;
export type ServiceCatalogPriceMode = (typeof SERVICE_CATALOG_PRICE_MODES)[number];

export interface ServiceCatalogDefinition {
  readonly code: string;
  readonly name: string;
  readonly description: string;
  readonly category: string;
  readonly displayOrder: number;
  readonly priceMode: ServiceCatalogPriceMode;
  readonly netPriceCents: number | null;
  readonly currency: typeof FAI_SERVICE_CATALOG_CURRENCY;
  readonly vatRateBps: typeof FAI_SERVICE_CATALOG_VAT_RATE_BPS;
  readonly validFrom: typeof FAI_SERVICE_CATALOG_VALID_FROM;
  readonly termsVersion: typeof FAI_SERVICE_CATALOG_TERMS_VERSION;
  readonly checkoutEnabled: false;
  readonly autoClientDeliveryAllowed: false;
  readonly autoExternalActionAllowed: false;
  readonly operationalConditionCodes: readonly string[];
  readonly checklistCodes: readonly string[];
}

const OPERATIONAL_CONDITION_CODES = Object.freeze([
  'HUMAN_REVIEW_REQUIRED',
  'NO_SUCCESS_FEE',
  'NO_AUTOMATIC_EXTERNAL_ACTION',
  'NO_AUTOMATIC_CLIENT_DELIVERY',
] as const);

const CHECKLIST_CODES = Object.freeze([
  'REQUEST_COMPLETE',
  'DOCUMENTS_AVAILABLE',
  'HUMAN_REVIEW_COMPLETE',
] as const);

type ServiceSeed = Omit<ServiceCatalogDefinition,
  | 'currency'
  | 'vatRateBps'
  | 'validFrom'
  | 'termsVersion'
  | 'checkoutEnabled'
  | 'autoClientDeliveryAllowed'
  | 'autoExternalActionAllowed'
  | 'operationalConditionCodes'
  | 'checklistCodes'
>;

const SERVICE_SEEDS: readonly ServiceSeed[] = [
  {
    code: 'verifica_ai_essenziale',
    name: 'Verifica AI Essenziale',
    description: 'Screening preliminare con esito tecnico soggetto a revisione umana.',
    category: 'ai',
    displayOrder: 1,
    priceMode: 'FIXED',
    netPriceCents: 19_000,
  },
  {
    code: 'audit_ai_bancabilita',
    name: 'Audit AI Bancabilità',
    description: 'Analisi tecnica della bancabilità e delle criticità documentali.',
    category: 'bancabilita',
    displayOrder: 2,
    priceMode: 'FIXED',
    netPriceCents: 39_000,
  },
  {
    code: 'pre_analisi_ai_ammissibilita',
    name: 'Pre-Analisi AI Ammissibilità',
    description: 'Pre-analisi di coerenza rispetto a misure e requisiti da verificare.',
    category: 'finanza_agevolata',
    displayOrder: 3,
    priceMode: 'FIXED',
    netPriceCents: 49_000,
  },
  {
    code: 'consulenza_strategica_60',
    name: 'Consulenza Strategica 60 minuti',
    description: 'Sessione strategica di sessanta minuti con revisione umana.',
    category: 'consulenza',
    displayOrder: 4,
    priceMode: 'FIXED',
    netPriceCents: 50_000,
  },
  {
    code: 'dossier_preanalisi',
    name: 'Dossier Preanalisi',
    description: 'Dossier strutturato di preanalisi con validazione professionale.',
    category: 'dossier',
    displayOrder: 5,
    priceMode: 'FIXED',
    netPriceCents: 89_000,
  },
  {
    code: 'ottimizzazione_ai_progetto',
    name: 'Ottimizzazione AI Progetto',
    description: 'Ottimizzazione assistita del progetto con controllo umano.',
    category: 'progetto',
    displayOrder: 6,
    priceMode: 'FIXED',
    netPriceCents: 125_000,
  },
  {
    code: 'business_plan_presentazione_bancaria',
    name: 'Business Plan & Presentazione Bancaria',
    description: 'Business plan e presentazione bancaria soggetti a revisione professionale.',
    category: 'bancabilita',
    displayOrder: 7,
    priceMode: 'FIXED',
    netPriceCents: 169_000,
  },
  {
    code: 'ottimizzazione_aziendale_ai',
    name: 'Ottimizzazione Aziendale AI',
    description: 'Analisi e ottimizzazione aziendale assistite con revisione umana.',
    category: 'strategia_aziendale',
    displayOrder: 8,
    priceMode: 'FIXED',
    netPriceCents: 149_000,
  },
  {
    code: 'progetti_digitali',
    name: 'Progetti Digitali',
    description: 'Progettazione digitale personalizzata definita mediante preventivo.',
    category: 'digitale',
    displayOrder: 9,
    priceMode: 'QUOTE_ONLY',
    netPriceCents: null,
  },
  {
    code: 'gestione_misure',
    name: 'Gestione misure',
    description: 'Gestione operativa di misure definita mediante preventivo.',
    category: 'finanza_agevolata',
    displayOrder: 10,
    priceMode: 'QUOTE_ONLY',
    netPriceCents: null,
  },
  {
    code: 'rendicontazione',
    name: 'Rendicontazione',
    description: 'Attività di rendicontazione definita mediante preventivo.',
    category: 'rendicontazione',
    displayOrder: 11,
    priceMode: 'QUOTE_ONLY',
    netPriceCents: null,
  },
] as const;

export const FAI_SERVICE_CATALOG: readonly ServiceCatalogDefinition[] = Object.freeze(
  SERVICE_SEEDS.map((service) => Object.freeze({
    ...service,
    currency: FAI_SERVICE_CATALOG_CURRENCY,
    vatRateBps: FAI_SERVICE_CATALOG_VAT_RATE_BPS,
    validFrom: FAI_SERVICE_CATALOG_VALID_FROM,
    termsVersion: FAI_SERVICE_CATALOG_TERMS_VERSION,
    checkoutEnabled: false as const,
    autoClientDeliveryAllowed: false as const,
    autoExternalActionAllowed: false as const,
    operationalConditionCodes: OPERATIONAL_CONDITION_CODES,
    checklistCodes: CHECKLIST_CODES,
  })),
);

export function serviceCatalogRevisionContent(service: ServiceCatalogDefinition) {
  return {
    autoClientDeliveryAllowed: service.autoClientDeliveryAllowed,
    autoExternalActionAllowed: service.autoExternalActionAllowed,
    checklistCodes: [...service.checklistCodes],
    checkoutEnabled: service.checkoutEnabled,
    currency: service.currency,
    netPriceCents: service.netPriceCents,
    operationalConditionCodes: [...service.operationalConditionCodes],
    priceMode: service.priceMode,
    publicName: service.name,
    serviceCode: service.code,
    shortDescription: service.description,
    termsVersion: service.termsVersion,
    validFrom: service.validFrom,
    vatRateBps: service.vatRateBps,
    version: 1,
  } as const;
}

export function serviceCatalogRevisionHash(service: ServiceCatalogDefinition) {
  return canonicalSha256(serviceCatalogRevisionContent(service));
}

export function validateServiceCatalogDefinitions(
  services: readonly ServiceCatalogDefinition[] = FAI_SERVICE_CATALOG,
) {
  if (services.length !== 11) throw new TypeError('SERVICE_CATALOG_COUNT_INVALID');
  const codes = new Set<string>();
  const displayOrders = new Set<number>();
  for (const service of services) {
    if (!/^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(service.code) || codes.has(service.code)) {
      throw new TypeError('SERVICE_CATALOG_CODE_INVALID');
    }
    codes.add(service.code);
    if (!Number.isInteger(service.displayOrder) || service.displayOrder < 1
      || displayOrders.has(service.displayOrder)) {
      throw new TypeError('SERVICE_CATALOG_DISPLAY_ORDER_INVALID');
    }
    displayOrders.add(service.displayOrder);
    if (service.currency !== 'EUR' || service.vatRateBps !== 2_200
      || service.termsVersion !== 'TERMS-v1') {
      throw new TypeError('SERVICE_CATALOG_COMMERCIAL_IDENTITY_INVALID');
    }
    if (service.priceMode === 'FIXED') {
      if (!Number.isSafeInteger(service.netPriceCents) || (service.netPriceCents ?? 0) <= 0) {
        throw new TypeError('SERVICE_CATALOG_FIXED_PRICE_INVALID');
      }
    } else if (service.netPriceCents !== null) {
      throw new TypeError('SERVICE_CATALOG_QUOTE_PRICE_INVALID');
    }
    if (service.checkoutEnabled || service.autoClientDeliveryAllowed
      || service.autoExternalActionAllowed) {
      throw new TypeError('SERVICE_CATALOG_DORMANT_SAFETY_INVALID');
    }
    if (service.operationalConditionCodes.length === 0 || service.checklistCodes.length === 0) {
      throw new TypeError('SERVICE_CATALOG_TERMS_INVALID');
    }
  }
  if ([...displayOrders].sort((a, b) => a - b).some((value, index) => value !== index + 1)) {
    throw new TypeError('SERVICE_CATALOG_DISPLAY_ORDER_GAP');
  }
  return true;
}

validateServiceCatalogDefinitions();
