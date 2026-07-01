import { scanForbiddenPhrases } from './compliance';
import { buildClientServiceLabel, findServiceCatalogLabel } from './client-service-label';
export type AiDraft = { title: string; content: string; metadata?: Record<string, unknown> };
export interface AiProviderAdapter { run(agentCode: string, input: unknown): Promise<AiDraft>; }

type AiContext = {
  client?: { displayName?: string; type?: string; status?: string; notes?: string | null };
  companies?: Array<{ name?: string; revenue?: unknown; annualRevenue?: unknown; turnover?: unknown; fatturato?: unknown }>;
  clientService?: Parameters<typeof buildClientServiceLabel>[0] & { internalNotes?: string | null; operationalNotes?: string | null };
  serviceCatalog?: Array<{ id: string; name?: string | null }>;
  project?: { title?: string; requestedAmount?: unknown; totalInvestment?: unknown; scenarioA?: string | null; scenarioB?: string | null };
  checklist?: Array<{ title?: string; status?: string; notes?: string | null; documentId?: string | null }>;
  documents?: Array<{ title?: string; documentCategory?: string; status?: string; serviceArea?: string }>;
  tasks?: Array<{ title?: string; status?: string; priority?: string; description?: string | null }>;
};

function contextFrom(input: unknown): AiContext {
  if (!input || typeof input !== 'object') return {};
  const context = (input as { context?: AiContext }).context;
  return context && typeof context === 'object' ? context : {};
}
function valueLabel(value: unknown) { return value === null || value === undefined || value === '' ? '—' : String(value); }
function money(value: unknown) { const n = Number(value); return value === null || value === undefined || value === '' || !Number.isFinite(n) ? '—' : `€ ${n.toLocaleString('it-IT')}`; }
function list(items: string[], empty: string) { return items.length ? items.map((item) => `- ${item}`).join('\n') : `- ${empty}`; }
function findRevenue(ctx: AiContext) { const company = ctx.companies?.[0]; return company?.revenue ?? company?.annualRevenue ?? company?.turnover ?? company?.fatturato; }
function docSignals(ctx: AiContext, words: string[]) { const source = [...(ctx.checklist ?? []), ...(ctx.documents ?? [])].map((x) => `${'title' in x ? x.title : ''} ${'documentCategory' in x ? x.documentCategory : ''} ${'notes' in x ? x.notes : ''}`.toLowerCase()); return words.filter((word) => source.some((line) => line.includes(word.toLowerCase()))); }

function buildMockContent(agentCode: string, ctx: AiContext) {
  const serviceLabel = buildClientServiceLabel(ctx.clientService, findServiceCatalogLabel(ctx.clientService, ctx.serviceCatalog), 'Pratica cliente');
  const checklist = ctx.checklist ?? [];
  const documents = ctx.documents ?? [];
  const missing = checklist.filter((i) => ['mancante','da_richiedere','richiesto'].includes(i.status ?? '') || !i.documentId).map((i) => `${valueLabel(i.title)} (${(i.status ?? 'da verificare').replaceAll('_', ' ')})`);
  const received = documents.map((d) => `${valueLabel(d.title)} · ${valueLabel(d.status)}${d.documentCategory ? ` · ${d.documentCategory}` : ''}`);
  const validate = checklist.filter((i) => ['ricevuto','da_validare','in_verifica'].includes(i.status ?? '')).map((i) => `${valueLabel(i.title)} (${(i.status ?? '').replaceAll('_', ' ') || 'da validare'})`);
  const requestedAmount = ctx.clientService?.requestedAmount ?? ctx.project?.requestedAmount;
  const investment = ctx.clientService?.plannedInvestment ?? ctx.project?.totalInvestment;
  const crSignals = docSignals(ctx, ['centrale rischi', 'crif', 'cr']);
  const isDocs = /checklist|document/i.test(agentCode);
  const isBank = ['bancabilita','finanza_ordinaria'].includes(agentCode);
  const isSubsidy = agentCode === 'pre_analisi_agevolata';

  const sections = [
    '# Output mock/template AI interno', '',
    '## 1. Sintesi operativa',
    `- Cliente: ${valueLabel(ctx.client?.displayName)}`,
    `- Pratica/servizio: ${serviceLabel}`,
    isDocs ? '- Priorità mock: completare, ricevere e validare il fascicolo documentale prima di avanzare istruttorie o dossier.' : isBank ? '- Priorità mock: valutare coerenza tra importo richiesto, investimento previsto, fatturato e capacità di rimborso.' : isSubsidy ? '- Priorità mock: impostare una pre-analisi di ammissibilità senza citare bandi come certi e senza promettere contributi.' : '- Priorità mock: trasformare i dati CRM in una traccia operativa revisionabile dal consulente.', '',
    '## 2. Dati disponibili',
    `- Importo richiesto: ${money(requestedAmount)}`,
    `- Investimento previsto: ${money(investment)}`,
    `- Fatturato disponibile: ${money(findRevenue(ctx))}`,
    `- Stato operativo: ${valueLabel(ctx.clientService?.operationalStatus).replaceAll('_', ' ')}`,
    `- Progetto: ${valueLabel(ctx.project?.title)}`,
    `- Documenti ricevuti: ${documents.length}`,
    `- Checklist attive: ${checklist.length}`, '',
    '## 3. Criticità / condizioni bloccanti',
    list([
      ...(missing.length ? [`Documenti mancanti o non collegati: ${missing.length}.`] : []),
      ...(isBank && !crSignals.length ? ['Centrale Rischi/CRIF non rilevata nei documenti/checklist: dato da richiedere o verificare.'] : []),
      ...(isBank ? ['DSCR e cashflow non calcolati dal mock: dati da verificare con bilanci, situazione contabile e piano finanziario.'] : []),
      ...(isSubsidy ? ['Ammissibilità, spese previste, cumulabilità e condizioni bloccanti sono da verificare su fonte ufficiale.'] : []),
      'Nessun esito è automatico: revisione umana obbligatoria.',
    ], 'Nessuna criticità automatica rilevata dal template, ma verifica consulente obbligatoria.'), '',
    '## 4. Scenario A - obiettivo massimo realistico',
    isSubsidy ? '- Costruire ipotesi agevolativa massima solo dopo verifica di requisiti, spese e fonte ufficiale; non promettere contributi.' : `- Ipotizzare percorso principale sul valore richiesto (${money(requestedAmount)}) se documentazione, cashflow e condizioni operative risultano coerenti.`, '',
    '## 5. Scenario B - alternativa/ponte',
    '- Prevedere soluzione ponte o alternativa con importo ridotto, integrazione documentale progressiva o canale ordinario in attesa delle verifiche.', '',
    '## 6. Documenti mancanti o da verificare',
    isDocs ? ['### Documenti mancanti', list(missing, 'Nessun documento mancante censito.'), '### Documenti ricevuti', list(received, 'Nessun documento ricevuto censito.'), '### Documenti da validare', list(validate, 'Nessun documento in validazione censito.')].join('\n') : list([...missing, ...validate, ...(crSignals.length ? [`Segnali Centrale Rischi/CRIF presenti: ${crSignals.join(', ')}.`] : [])], 'Checklist/documenti da aggiornare prima della decisione.'), '',
    '## 7. Prossime azioni operative',
    list([
      'Aggiornare importi, stato operativo e note pratica nel fascicolo cliente.',
      'Richiedere al cliente i documenti mancanti e validare quelli ricevuti.',
      ...(isBank ? ['Acquisire o aggiornare Centrale Rischi/CRIF, bilanci, situazione contabile, DSCR e cashflow.'] : []),
      ...(isSubsidy ? ['Verificare ammissibilità, cumulabilità e spese su fonte ufficiale prima di qualsiasi proposta.'] : []),
      'Revisionare manualmente questo output mock prima di approvarlo o trasformarlo in dossier.',
    ], 'Definire prossima azione interna.'), '',
    '_Nota: contenuto mock/template generato server-side. Nessuna AI reale, nessuna chiamata esterna. Da verificare su fonte ufficiale dove opportuno._',
  ];
  return sections.join('\n');
}

export class MockAiAdapter implements AiProviderAdapter { async run(agentCode: string, input: unknown): Promise<AiDraft> { const ctx = contextFrom(input); return { title: `Bozza interna ${agentCode} - ${buildClientServiceLabel(ctx.clientService, findServiceCatalogLabel(ctx.clientService, ctx.serviceCatalog), 'Pratica cliente')}`, content: buildMockContent(agentCode, ctx) }; } }
export function getAiAdapter(): AiProviderAdapter { if (!process.env.AI_API_KEY || process.env.AI_PROVIDER === 'mock') return new MockAiAdapter(); return new MockAiAdapter(); }
export function prepareAiOutput(draft: AiDraft) { return { ...draft, status: 'needs_review' as const, requiresHumanReview: true, forbiddenPhrases: scanForbiddenPhrases(draft.content) }; }
