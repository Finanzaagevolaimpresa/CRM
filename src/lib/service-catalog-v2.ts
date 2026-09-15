import { canonicalSha256 } from './canonical-json';
import {
  FAI_SERVICE_CATALOG, FAI_SERVICE_CATALOG_TERMS_VERSION,
  FAI_SERVICE_CATALOG_VALID_FROM, FAI_SERVICE_CATALOG_VERSION,
  serviceCatalogRevisionContent, serviceCatalogRevisionHash,
} from './service-catalog';

export const FAI_SERVICE_CATALOG_V2_VERSION = '2026-09-13-v2' as const;
export const FAI_SERVICE_CATALOG_V2_VALID_FROM = '2026-09-13T00:00:00.000Z' as const;
export const FAI_SERVICE_CATALOG_V2_TERMS_VERSION = 'TERMS-v2' as const;

export type DigitalProjectDetail = {
  code: string; label: string; inclusions: readonly string[]; exclusions: readonly string[];
  materials: readonly string[]; deliverables: readonly string[]; subsequentEngagements: readonly string[];
};

export const DIGITAL_PROJECT_TYPES = Object.freeze([
  { code: 'siti_landing', label: 'Siti e landing page', inclusions: ['Pagine e funzioni definite nel preventivo'], exclusions: ['Nessuna promessa di lead o posizionamento'], materials: ['Brand, testi e immagini disponibili'], deliverables: ['Sito o landing con perimetro concordato'], subsequentEngagements: ['Contenuti, SEO, dominio, hosting, licenze e manutenzione solo se inclusi nell’incarico'] },
  { code: 'ecommerce', label: 'E-commerce', inclusions: ['Catalogo e funzioni di vendita delimitati nel preventivo'], exclusions: ['Nessuna promessa di vendite o attivazione automatica dei pagamenti'], materials: ['Prodotti, varianti, listini, foto, consegna o ritiro, stock e piattaforme'], deliverables: ['E-commerce nel perimetro tecnico concordato'], subsequentEngagements: ['Commissioni, abbonamenti, servizi provider, gestione ordini e adempimenti restano distinti'] },
  { code: 'software_crm_workflow', label: 'Software, CRM e workflow', inclusions: ['Ruoli, processo, dati e integrazioni delimitati'], exclusions: ['Migrazione non garantita senza verifica di formati, qualità e quantità'], materials: ['Processo, ruoli, campioni dati e integrazioni'], deliverables: ['Software, CRM o workflow concordato e prove previste'], subsequentEngagements: ['Licenze, manutenzione, migrazione e ulteriori integrazioni da delimitare'] },
  { code: 'app_piattaforme', label: 'App e piattaforme', inclusions: ['Utenti, ruoli, dispositivi, integrazioni e priorità della prima versione'], exclusions: ['Costi esterni non inclusi salvo previsione espressa'], materials: ['Profili utente, dispositivi, integrazioni e priorità'], deliverables: ['Prima versione dell’app o piattaforma concordata'], subsequentEngagements: ['Portali, configuratori, aree riservate, pubblicazione store e supporto solo se concordati'] },
  { code: 'automazioni_dashboard', label: 'Automazioni e dashboard', inclusions: ['Attività, frequenza, fonti, campioni dati, errori e decisioni delimitati', 'Controlli umani espliciti'], exclusions: ['Una dashboard non implica AI', 'Nessuna autonomia o accuratezza garantita'], materials: ['Fonti e campioni dati, frequenze, errori e decisioni'], deliverables: ['Automazione o dashboard nel perimetro concordato'], subsequentEngagements: ['API, licenze e manutenzione da definire separatamente'] },
  { code: 'progettazione_integrazione_hw_sw', label: 'Progettazione tecnica e integrazione hardware/software', inclusions: ['Funzioni, hardware, software, specifiche fornitori e compatibilità delimitati'], exclusions: ['Acquisto dispositivi, implementazione, certificazioni e ammissione a incentivi sono distinti'], materials: ['Specifiche dei fornitori e requisiti di compatibilità'], deliverables: ['Documento funzionale o tecnico-economico, anche come consegna autonoma'], subsequentEngagements: ['Fornitura e implementazione richiedono incarico separato'] },
  { code: 'marketing_sviluppo_commerciale', label: 'Marketing e sviluppo commerciale', inclusions: ['Offerta, pubblico, territorio, canali, materiali, processo contatti e obiettivi delimitati'], exclusions: ['Nessuna garanzia di lead, vendite o ROI'], materials: ['Offerta, pubblico, territorio, canali e materiali disponibili'], deliverables: ['Piano o attività commerciali concordate'], subsequentEngagements: ['Media budget e strumenti separati; SEO, SEM, email, CRM e misurazione solo se concordati'] },
] as const satisfies readonly DigitalProjectDetail[]);
export type DigitalProjectType = (typeof DIGITAL_PROJECT_TYPES)[number]['code'];

export type CatalogV2Detail = {
  inclusions: readonly string[]; exclusions: readonly string[]; phaseDocuments: readonly string[];
  timing: string; deliverables: readonly string[]; subsequentEngagements: readonly string[];
  professionalAttribution?: string; digitalProjectTypes?: readonly DigitalProjectDetail[];
};
export type CatalogV2Revision = {
  code: string; name: string; description: string; category: string; displayOrder: number;
  revisionVersion: number; sourceCatalogVersion: string; validFrom: string; termsVersion: string;
  priceMode: 'FIXED' | 'QUOTE_ONLY'; netPriceCents: number | null; detail: CatalogV2Detail;
};

const STANDARD_DETAIL: CatalogV2Detail = Object.freeze({
  inclusions: ['Inquadramento iniziale e coordinamento FAI', 'Attività definite nell’incarico'],
  exclusions: ['Attività professionali o operative non indicate nell’incarico'],
  phaseDocuments: ['Richiesta: informazioni essenziali', 'Preventivo: documenti proporzionati alla fase', 'Avvio: incarico formalizzato, accredito effettivo e materiali completi'],
  timing: 'Tempi e deliverable da concordare nell’incarico; richiesta e preventivo non costituiscono incarico o avvio.',
  deliverables: ['Deliverable definiti nel preventivo e nell’incarico'], subsequentEngagements: ['Eventuali attività successive richiedono incarico separato'],
});

const inherited: CatalogV2Revision[] = FAI_SERVICE_CATALOG.map((service) => ({
  code: service.code, name: service.name, description: service.description, category: service.category,
  displayOrder: service.displayOrder, revisionVersion: 1, sourceCatalogVersion: FAI_SERVICE_CATALOG_VERSION,
  validFrom: FAI_SERVICE_CATALOG_VALID_FROM, termsVersion: FAI_SERVICE_CATALOG_TERMS_VERSION,
  priceMode: service.priceMode, netPriceCents: service.netPriceCents, detail: STANDARD_DETAIL,
}));
const changed: Record<string, Partial<CatalogV2Revision>> = {
  ottimizzazione_aziendale_ai: { revisionVersion: 2, sourceCatalogVersion: FAI_SERVICE_CATALOG_V2_VERSION, validFrom: FAI_SERVICE_CATALOG_V2_VALID_FROM, termsVersion: FAI_SERVICE_CATALOG_V2_TERMS_VERSION, priceMode: 'QUOTE_ONLY', netPriceCents: null, description: 'Roadmap organizzativa definita dopo la delimitazione del perimetro e mediante preventivo.', detail: { ...STANDARD_DETAIL, inclusions: ['Inquadramento e coordinamento FAI', 'Analisi organizzativa e roadmap concordata'], exclusions: ['Software e automazioni', 'Gestione continuativa', 'Consulenza fiscale, salvo distinto incarico pertinente'], deliverables: ['Roadmap organizzativa concordata'] } },
  progetti_digitali: { revisionVersion: 2, sourceCatalogVersion: FAI_SERVICE_CATALOG_V2_VERSION, validFrom: FAI_SERVICE_CATALOG_V2_VALID_FROM, termsVersion: FAI_SERVICE_CATALOG_V2_TERMS_VERSION, detail: { ...STANDARD_DETAIL, inclusions: ['Inquadramento e coordinamento FAI', 'Progettazione della tipologia digitale selezionata'], exclusions: ['Realizzazioni o gestioni continuative non incluse nel preventivo'], digitalProjectTypes: DIGITAL_PROJECT_TYPES } },
};
const fiscal: CatalogV2Revision[] = [
  { code: 'consulenza_fiscale', name: 'Consulenza fiscale', description: 'Consulenza su preventivo svolta dal professionista abilitato individuato nell’incarico; FAI cura inquadramento e coordinamento.', category: 'fiscale', displayOrder: 12, revisionVersion: 1, sourceCatalogVersion: FAI_SERVICE_CATALOG_V2_VERSION, validFrom: FAI_SERVICE_CATALOG_V2_VALID_FROM, termsVersion: FAI_SERVICE_CATALOG_V2_TERMS_VERSION, priceMode: 'QUOTE_ONLY', netPriceCents: null, detail: { ...STANDARD_DETAIL, inclusions: ['Inquadramento e coordinamento FAI', 'Prestazione fiscale definita nell’incarico'], exclusions: ['Adempimenti o attività ulteriori non indicati nell’incarico'], timing: 'Tempi e deliverable da concordare nell’incarico; la richiesta non accetta una scadenza e non costituisce avvio.', professionalAttribution: 'La prestazione fiscale è attribuita al professionista abilitato individuato nell’incarico; FAI cura inquadramento e coordinamento.' } },
  { code: 'pianificazione_ottimizzazione_fiscale', name: 'Pianificazione e ottimizzazione fiscale', description: 'Pianificazione fiscale distinta, su preventivo e senza garanzia di risparmio fiscale.', category: 'fiscale', displayOrder: 13, revisionVersion: 1, sourceCatalogVersion: FAI_SERVICE_CATALOG_V2_VERSION, validFrom: FAI_SERVICE_CATALOG_V2_VALID_FROM, termsVersion: FAI_SERVICE_CATALOG_V2_TERMS_VERSION, priceMode: 'QUOTE_ONLY', netPriceCents: null, detail: { ...STANDARD_DETAIL, inclusions: ['Inquadramento e coordinamento FAI', 'Pianificazione definita con il professionista individuato nell’incarico'], exclusions: ['Garanzie di risparmio fiscale', 'Attività non comprese nell’incarico'], timing: 'Tempi e deliverable da concordare nell’incarico; la richiesta non accetta una scadenza e non costituisce avvio.', professionalAttribution: 'La prestazione fiscale è attribuita al professionista abilitato individuato nell’incarico; FAI cura inquadramento e coordinamento.' } },
];
export const FAI_SERVICE_CATALOG_V2: readonly CatalogV2Revision[] = Object.freeze([...inherited.map((service) => ({ ...service, ...changed[service.code] } as CatalogV2Revision)), ...fiscal]);

export function validateCatalogSelection(serviceCode: string, digitalProjectType?: string) {
  const service = FAI_SERVICE_CATALOG_V2.find(({ code }) => code === serviceCode);
  if (!service) throw new TypeError('SERVICE_CATALOG_SELECTION_UNKNOWN');
  const type = digitalProjectType ? DIGITAL_PROJECT_TYPES.find(({ code }) => code === digitalProjectType) : undefined;
  if (digitalProjectType && (service.code !== 'progetti_digitali' || !type)) throw new TypeError('SERVICE_CATALOG_DIGITAL_TYPE_INCOMPATIBLE');
  if (service.code === 'progetti_digitali' && !type) throw new TypeError('SERVICE_CATALOG_DIGITAL_TYPE_REQUIRED');
  return { service, digitalProjectType: type };
}

const OPERATIONAL_CODES = ['HUMAN_REVIEW_REQUIRED', 'NO_SUCCESS_FEE', 'NO_AUTOMATIC_EXTERNAL_ACTION', 'NO_AUTOMATIC_CLIENT_DELIVERY'] as const;
const CHECKLIST_CODES = ['REQUEST_COMPLETE', 'DOCUMENTS_AVAILABLE', 'HUMAN_REVIEW_COMPLETE'] as const;
export function catalogV2RevisionContent(service: CatalogV2Revision) {
  const legacy = FAI_SERVICE_CATALOG.find(({ code }) => code === service.code);
  if (service.sourceCatalogVersion === FAI_SERVICE_CATALOG_VERSION && legacy) return serviceCatalogRevisionContent(legacy);
  const storage = catalogV2Storage(service);
  return { autoClientDeliveryAllowed: false, autoExternalActionAllowed: false, checklist: storage.checklist, checkoutEnabled: false, currency: 'EUR', netPriceCents: service.netPriceCents, operationalConditions: storage.operationalConditions, priceMode: service.priceMode, publicName: service.name, serviceCode: service.code, shortDescription: service.description, termsVersion: service.termsVersion, validFrom: service.validFrom, vatRateBps: 2200, version: service.revisionVersion } as const;
}
export function catalogV2RevisionHash(service: CatalogV2Revision) { const legacy = FAI_SERVICE_CATALOG.find(({ code }) => code === service.code); return service.sourceCatalogVersion === FAI_SERVICE_CATALOG_VERSION && legacy ? serviceCatalogRevisionHash(legacy) : canonicalSha256(catalogV2RevisionContent(service)); }
export function buildCatalogV2Snapshot() { return Object.freeze({ catalogVersion: FAI_SERVICE_CATALOG_V2_VERSION, validFrom: FAI_SERVICE_CATALOG_V2_VALID_FROM, services: FAI_SERVICE_CATALOG_V2.map((service) => Object.freeze(catalogV2RevisionContent(service))) }); }
export function catalogV2Storage(service: CatalogV2Revision) {
  if (service.sourceCatalogVersion === FAI_SERVICE_CATALOG_VERSION) return { operationalConditions: [...OPERATIONAL_CODES], checklist: [...CHECKLIST_CODES] };
  return {
    operationalConditions: [...OPERATIONAL_CODES, { catalogVersion: service.sourceCatalogVersion, detail: service.detail }],
    checklist: [...CHECKLIST_CODES, { phaseDocuments: service.detail.phaseDocuments }],
  };
}

if (FAI_SERVICE_CATALOG_V2.length !== 13 || new Set(FAI_SERVICE_CATALOG_V2.map(({ code }) => code)).size !== 13) throw new TypeError('SERVICE_CATALOG_V2_COUNT_INVALID');
for (const service of FAI_SERVICE_CATALOG_V2) if ((service.priceMode === 'QUOTE_ONLY') !== (service.netPriceCents === null)) throw new TypeError('SERVICE_CATALOG_V2_PRICE_INVALID');
