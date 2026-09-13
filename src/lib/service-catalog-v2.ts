import { canonicalSha256 } from './canonical-json';
import { FAI_SERVICE_CATALOG } from './service-catalog';

export const FAI_SERVICE_CATALOG_V2_VERSION = '2026-09-13-v2' as const;
export const FAI_SERVICE_CATALOG_V2_VALID_FROM = '2026-09-13T00:00:00.000Z' as const;
export const FAI_SERVICE_CATALOG_V2_TERMS_VERSION = 'TERMS-v2' as const;

export const DIGITAL_PROJECT_TYPES = Object.freeze([
  { code: 'siti_landing', label: 'Siti e landing page' },
  { code: 'ecommerce', label: 'E-commerce' },
  { code: 'software_crm_workflow', label: 'Software, CRM e workflow' },
  { code: 'app_piattaforme', label: 'App e piattaforme' },
  { code: 'automazioni_dashboard', label: 'Automazioni e dashboard' },
  { code: 'progettazione_integrazione_hw_sw', label: 'Progettazione tecnica e integrazione hardware/software' },
  { code: 'marketing_sviluppo_commerciale', label: 'Marketing e sviluppo commerciale' },
] as const);
export type DigitalProjectType = (typeof DIGITAL_PROJECT_TYPES)[number]['code'];

export type CatalogV2Detail = {
  inclusions: readonly string[];
  exclusions: readonly string[];
  phaseDocuments: readonly string[];
  timing: string;
  deliverables: readonly string[];
  subsequentEngagements: readonly string[];
  professionalAttribution?: string;
  digitalProjectTypes?: readonly DigitalProjectType[];
};

export type CatalogV2Revision = {
  code: string; name: string; description: string; category: string; displayOrder: number;
  revisionVersion: number; priceMode: 'FIXED' | 'QUOTE_ONLY'; netPriceCents: number | null;
  detail: CatalogV2Detail;
};

const STANDARD_DETAIL: CatalogV2Detail = Object.freeze({
  inclusions: ['Inquadramento iniziale e coordinamento FAI', 'Attività definite nell’incarico'],
  exclusions: ['Attività professionali o operative non indicate nell’incarico'],
  phaseDocuments: ['Richiesta: informazioni essenziali', 'Preventivo e incarico: documenti proporzionati alla fase', 'Avvio: materiali completi concordati'],
  timing: 'Tempi e deliverable da concordare nell’incarico; la richiesta non costituisce avvio.',
  deliverables: ['Deliverable definiti nel preventivo e nell’incarico'],
  subsequentEngagements: ['Eventuali attività successive richiedono incarico separato'],
});

const replacements: Record<string, Partial<CatalogV2Revision>> = {
  ottimizzazione_aziendale_ai: {
    revisionVersion: 2, priceMode: 'QUOTE_ONLY', netPriceCents: null,
    description: 'Roadmap organizzativa definita dopo la delimitazione del perimetro e mediante preventivo.',
    detail: { ...STANDARD_DETAIL, inclusions: ['Inquadramento e coordinamento FAI', 'Analisi organizzativa e roadmap concordata'], exclusions: ['Software e automazioni', 'Gestione continuativa', 'Consulenza fiscale, salvo distinto incarico pertinente'], deliverables: ['Roadmap organizzativa concordata'] },
  },
  progetti_digitali: {
    revisionVersion: 2,
    detail: { ...STANDARD_DETAIL, inclusions: ['Inquadramento e coordinamento FAI', 'Progettazione della tipologia digitale selezionata'], exclusions: ['Realizzazioni o gestioni continuative non incluse nel preventivo'], digitalProjectTypes: DIGITAL_PROJECT_TYPES.map(({ code }) => code) },
  },
};

const inherited = FAI_SERVICE_CATALOG.map((service) => ({
  code: service.code, name: service.name, description: service.description, category: service.category,
  displayOrder: service.displayOrder, revisionVersion: 1, priceMode: service.priceMode,
  netPriceCents: service.netPriceCents, detail: STANDARD_DETAIL,
} satisfies CatalogV2Revision));

const fiscal: CatalogV2Revision[] = [
  { code: 'consulenza_fiscale', name: 'Consulenza fiscale', description: 'Consulenza su preventivo svolta dal professionista abilitato individuato nell’incarico; FAI cura inquadramento e coordinamento.', category: 'fiscale', displayOrder: 12, revisionVersion: 1, priceMode: 'QUOTE_ONLY', netPriceCents: null, detail: { ...STANDARD_DETAIL, inclusions: ['Inquadramento e coordinamento FAI', 'Prestazione fiscale definita nell’incarico'], exclusions: ['Adempimenti o attività ulteriori non indicati nell’incarico'], timing: 'Tempi e deliverable da concordare nell’incarico; la richiesta non accetta una scadenza e non costituisce avvio.', professionalAttribution: 'La prestazione fiscale è attribuita al professionista abilitato individuato nell’incarico; FAI cura inquadramento e coordinamento.' } },
  { code: 'pianificazione_ottimizzazione_fiscale', name: 'Pianificazione e ottimizzazione fiscale', description: 'Pianificazione fiscale distinta, su preventivo e senza garanzia di risparmio fiscale.', category: 'fiscale', displayOrder: 13, revisionVersion: 1, priceMode: 'QUOTE_ONLY', netPriceCents: null, detail: { ...STANDARD_DETAIL, inclusions: ['Inquadramento e coordinamento FAI', 'Pianificazione definita con il professionista individuato nell’incarico'], exclusions: ['Garanzie di risparmio fiscale', 'Attività non comprese nell’incarico'], timing: 'Tempi e deliverable da concordare nell’incarico; la richiesta non accetta una scadenza e non costituisce avvio.', professionalAttribution: 'La prestazione fiscale è attribuita al professionista abilitato individuato nell’incarico; FAI cura inquadramento e coordinamento.' } },
];

const currentServices: CatalogV2Revision[] = inherited.map((service) => ({ ...service, ...replacements[service.code] } as CatalogV2Revision));
export const FAI_SERVICE_CATALOG_V2: readonly CatalogV2Revision[] = Object.freeze([...currentServices, ...fiscal]);

export function validateCatalogSelection(serviceCode: string, digitalProjectType?: string) {
  const service = FAI_SERVICE_CATALOG_V2.find(({ code }) => code === serviceCode);
  if (!service) throw new TypeError('SERVICE_CATALOG_SELECTION_UNKNOWN');
  if (digitalProjectType) {
    if (service.code !== 'progetti_digitali' || !service.detail.digitalProjectTypes?.includes(digitalProjectType as DigitalProjectType)) throw new TypeError('SERVICE_CATALOG_DIGITAL_TYPE_INCOMPATIBLE');
  }
  return { service, digitalProjectType: digitalProjectType as DigitalProjectType | undefined };
}

export function catalogV2RevisionContent(service: CatalogV2Revision) {
  return { catalogVersion: FAI_SERVICE_CATALOG_V2_VERSION, validFrom: FAI_SERVICE_CATALOG_V2_VALID_FROM, termsVersion: FAI_SERVICE_CATALOG_V2_TERMS_VERSION, ...service, checkoutEnabled: false, autoClientDeliveryAllowed: false, autoExternalActionAllowed: false } as const;
}
export function catalogV2RevisionHash(service: CatalogV2Revision) { return canonicalSha256(catalogV2RevisionContent(service)); }
export function buildCatalogV2Snapshot() {
  return Object.freeze({ catalogVersion: FAI_SERVICE_CATALOG_V2_VERSION, validFrom: FAI_SERVICE_CATALOG_V2_VALID_FROM, services: FAI_SERVICE_CATALOG_V2.map((service) => Object.freeze(catalogV2RevisionContent(service))) });
}

if (FAI_SERVICE_CATALOG_V2.length !== 13 || new Set(FAI_SERVICE_CATALOG_V2.map(({ code }) => code)).size !== 13) throw new TypeError('SERVICE_CATALOG_V2_COUNT_INVALID');
for (const service of FAI_SERVICE_CATALOG_V2) if ((service.priceMode === 'QUOTE_ONLY') !== (service.netPriceCents === null)) throw new TypeError('SERVICE_CATALOG_V2_PRICE_INVALID');
