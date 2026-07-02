import { scanForbiddenPhrases } from './compliance';
import { buildClientServiceLabel, findServiceCatalogLabel } from './client-service-label';
import { UserFacingActionError } from './action-errors';

export type AiDraft = { title: string; content: string; metadata?: Record<string, unknown> };
export type AiAgentRuntime = { code: string; role?: string | null; systemPrompt?: string | null };
export interface AiProviderAdapter { run(agent: AiAgentRuntime | string, input: unknown): Promise<AiDraft>; }

const DEFAULT_AI_MODEL = 'gpt-4.1-mini';
const OPENAI_TIMEOUT_MS = 45_000;

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

function normalizeAgent(agent: AiAgentRuntime | string): AiAgentRuntime {
  return typeof agent === 'string' ? { code: agent } : agent;
}
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

function sanitizeForOpenAi(input: unknown) {
  const ctx = contextFrom(input);
  const userPrompt = typeof input === 'object' && input ? (input as { prompt?: unknown }).prompt : undefined;
  const max = <T>(items: T[] | undefined, limit: number) => (items ?? []).slice(0, limit);
  const safe = {
    source: 'CRM interno FAI',
    humanReviewRequired: true,
    prompt: typeof userPrompt === 'string' && userPrompt.trim() ? userPrompt.trim() : undefined,
    operationalInstructions: typeof input === 'object' && input ? (input as { operationalInstructions?: unknown }).operationalInstructions : undefined,
    context: {
      client: ctx.client ? { displayName: ctx.client.displayName, type: ctx.client.type, status: ctx.client.status, notes: ctx.client.notes } : undefined,
      companies: max(ctx.companies, 3).map((c) => ({ name: c.name, revenue: c.revenue ?? c.annualRevenue ?? c.turnover ?? c.fatturato })),
      clientService: ctx.clientService ? {
        serviceCatalogId: ctx.clientService.serviceCatalogId,
        practiceType: ctx.clientService.practiceType,
        operationalStatus: ctx.clientService.operationalStatus,
        requestedAmount: ctx.clientService.requestedAmount,
        plannedInvestment: ctx.clientService.plannedInvestment,
        operationalNotes: ctx.clientService.operationalNotes,
      } : undefined,
      project: ctx.project,
      checklist: max(ctx.checklist, 30).map((i) => ({ title: i.title, status: i.status, notes: i.notes, hasLinkedDocument: Boolean(i.documentId) })),
      documents: max(ctx.documents, 30).map((d) => ({ title: d.title, documentCategory: d.documentCategory, status: d.status, serviceArea: d.serviceArea })),
      tasks: max(ctx.tasks, 15).map((t) => ({ title: t.title, status: t.status, priority: t.priority, description: t.description })),
    },
  };
  return JSON.parse(JSON.stringify(safe));
}

function buildOpenAiPrompt(agent: AiAgentRuntime, input: unknown) {
  const safeInput = sanitizeForOpenAi(input);
  return [
    `Ruolo agente: ${agent.role || agent.code}.`,
    'Regole FAI obbligatorie:',
    '- FAI non eroga finanziamenti, non garantisce esiti e non promette contributi, finanziamenti o approvazioni.',
    '- Ogni risposta è una bozza interna soggetta a revisione umana obbligatoria.',
    '- Quando citi requisiti, bandi, agevolazioni, scadenze, ammissibilità o norme, scrivi "Da verificare su fonte ufficiale".',
    '- Produci testo semplice/Markdown in sezioni chiare: Sintesi, Dati usati, Criticità, Scenari, Documenti da verificare, Prossime azioni.',
    '- Non inventare dati mancanti; segnala cosa richiedere o validare.',
    safeInput.prompt ? `Prompt quick-run utente (istruzione operativa separata dal systemPrompt agente):\n${safeInput.prompt}` : undefined,
    'Contesto CRM sanificato, senza percorsi storage/checksum:',
    JSON.stringify(safeInput, null, 2),
  ].filter(Boolean).join('\n');
}

export class MockAiAdapter implements AiProviderAdapter {
  async run(agent: AiAgentRuntime | string, input: unknown): Promise<AiDraft> {
    const runtime = normalizeAgent(agent);
    const ctx = contextFrom(input);
    return { title: `Bozza interna ${runtime.code} - ${buildClientServiceLabel(ctx.clientService, findServiceCatalogLabel(ctx.clientService, ctx.serviceCatalog), 'Pratica cliente')}`, content: buildMockContent(runtime.code, ctx) };
  }
}

export class OpenAiAdapter implements AiProviderAdapter {
  async run(agent: AiAgentRuntime | string, input: unknown): Promise<AiDraft> {
    const runtime = normalizeAgent(agent);
    const apiKey = process.env.AI_API_KEY?.trim();
    if (!apiKey) throw new UserFacingActionError('Provider OpenAI configurato ma AI_API_KEY non è valorizzata. Imposta la chiave lato server o usa AI_PROVIDER=mock.');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);
    try {
      const response = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: process.env.AI_MODEL?.trim() || DEFAULT_AI_MODEL,
          instructions: runtime.systemPrompt || 'Sei un assistente AI interno FAI. Rispondi in italiano professionale.',
          input: buildOpenAiPrompt(runtime, input),
          max_output_tokens: 2500,
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`OpenAI HTTP ${response.status}`);
      const data = await response.json() as { output_text?: string; output?: Array<{ content?: Array<{ text?: string }> }> };
      const content = data.output_text || data.output?.flatMap((o) => o.content ?? []).map((c) => c.text).filter(Boolean).join('\n') || '';
      if (!content.trim()) throw new Error('OpenAI empty response');
      const ctx = contextFrom(input);
      return {
        title: `Bozza OpenAI ${runtime.code} - ${buildClientServiceLabel(ctx.clientService, findServiceCatalogLabel(ctx.clientService, ctx.serviceCatalog), 'Pratica cliente')}`,
        content: content.trim(),
        metadata: { provider: 'openai', model: process.env.AI_MODEL?.trim() || DEFAULT_AI_MODEL },
      };
    } catch (error) {
      if (error instanceof UserFacingActionError) throw error;
      const message = error instanceof Error && error.name === 'AbortError'
        ? 'Timeout durante la chiamata OpenAI. Riprova più tardi o usa AI_PROVIDER=mock.'
        : 'Errore operativo durante la chiamata OpenAI. Nessun output AI è stato salvato.';
      throw new UserFacingActionError(message);
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function getAiAdapter(): AiProviderAdapter {
  return process.env.AI_PROVIDER === 'openai' ? new OpenAiAdapter() : new MockAiAdapter();
}

export type AiProviderDiagnostics = {
  provider: 'mock' | 'openai';
  configuredProvider: string;
  model: string;
  hasApiKey: boolean;
  mode: 'mock' | 'openai';
  configurationStatus: 'ok' | 'incompleta';
};

export type AiProviderDiagnosticTestResult = { success: boolean; message: string; provider: 'mock' | 'openai'; model: string };

export function getAiProviderDiagnostics(): AiProviderDiagnostics {
  const configuredProvider = process.env.AI_PROVIDER?.trim() || 'mock';
  const provider = configuredProvider === 'openai' ? 'openai' : 'mock';
  const hasApiKey = Boolean(process.env.AI_API_KEY?.trim());
  const model = process.env.AI_MODEL?.trim() || DEFAULT_AI_MODEL;
  return {
    provider,
    configuredProvider,
    model,
    hasApiKey,
    mode: provider,
    configurationStatus: provider === 'openai' && !hasApiKey ? 'incompleta' : 'ok',
  };
}

export async function testAiProviderDiagnostic(): Promise<AiProviderDiagnosticTestResult> {
  const diagnostics = getAiProviderDiagnostics();
  if (diagnostics.provider === 'mock') {
    await new MockAiAdapter().run({ code: 'diagnostic_test', role: 'Diagnostica provider AI' }, {
      source: 'CRM interno FAI',
      humanReviewRequired: true,
      prompt: 'Test diagnostico interno minimale.',
      context: {},
    });
    return { success: true, message: 'Provider mock raggiungibile: risposta sintetica generata correttamente.', provider: diagnostics.provider, model: diagnostics.model };
  }

  const apiKey = process.env.AI_API_KEY?.trim();
  if (!apiKey) {
    return { success: false, message: 'Provider OpenAI selezionato ma AI_API_KEY non è configurata lato server.', provider: diagnostics.provider, model: diagnostics.model };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);
  try {
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: diagnostics.model,
        instructions: 'Rispondi solo con OK. Test tecnico interno senza dati cliente.',
        input: 'Test diagnostico provider AI CRM FAI. Non usare dati cliente.',
        max_output_tokens: 16,
      }),
      signal: controller.signal,
    });
    if (!response.ok) return { success: false, message: `Chiamata OpenAI non riuscita (HTTP ${response.status}). Nessun output AI salvato.`, provider: diagnostics.provider, model: diagnostics.model };
    return { success: true, message: 'Provider OpenAI raggiungibile: chiamata minima completata. Nessun output AI salvato.', provider: diagnostics.provider, model: diagnostics.model };
  } catch (error) {
    const message = error instanceof Error && error.name === 'AbortError'
      ? 'Timeout durante il test OpenAI. Nessun output AI salvato.'
      : 'Errore controllato durante il test OpenAI. Nessun output AI salvato.';
    return { success: false, message, provider: diagnostics.provider, model: diagnostics.model };
  } finally {
    clearTimeout(timeout);
  }
}

export function prepareAiOutput(draft: AiDraft) { return { ...draft, status: 'needs_review' as const, requiresHumanReview: true, forbiddenPhrases: scanForbiddenPhrases(draft.content) }; }
