import { scanForbiddenPhrases } from './compliance';
import { buildClientServiceLabel, findServiceCatalogLabel } from './client-service-label';
import { UserFacingActionError } from './action-errors';
import {
  consumeExternalAiPermit,
  type ExternalAiDataCategory,
  type ExternalAiPermit,
} from './ai-control-plane';

export type AiDraft = { title: string; content: string; metadata?: Record<string, unknown> };
export type AiAgentRuntime = { code: string; role?: string | null; systemPrompt?: string | null };
export interface AiProviderAdapter { run(agent: AiAgentRuntime | string, input: unknown, permit?: ExternalAiPermit): Promise<AiDraft>; }

export type AiProviderUsageMetadata = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  providerRequestId?: string;
};

export class AiProviderCallError extends UserFacingActionError {
  constructor(
    message: string,
    public readonly telemetry: AiProviderUsageMetadata = {},
    public readonly errorCode = 'AI_PROVIDER_FAILURE',
  ) {
    super(message);
    this.name = 'AiProviderCallError';
  }
}

export function aiProviderErrorMetadata(error: unknown) {
  return error instanceof AiProviderCallError ? error.telemetry : {};
}

type ExternalNullableText = string | null;
type ExternalNullableNumber = number | string | null;

/** The only client payload shape that may cross the OpenAI egress boundary. */
export type ExternalAiPayload = {
  source: 'CRM interno FAI';
  humanReviewRequired: true;
  operationalInstructions?: string;
  context: {
    client: { type: string; status: string };
    companies: Array<{
      annualRevenue: ExternalNullableNumber;
      legalForm: ExternalNullableText;
      atecoCode: ExternalNullableText;
      region: ExternalNullableText;
      employees: number | null;
      durcStatus: ExternalNullableText;
    }>;
    service: {
      label: string;
      practiceType: ExternalNullableText;
      status: string;
      operationalStatus: string;
      requestedAmount: ExternalNullableNumber;
      plannedInvestment: ExternalNullableNumber;
    } | null;
    project: {
      requestedAmount: ExternalNullableNumber;
      totalInvestment: ExternalNullableNumber;
      status: string;
      priority: string;
      startTiming: ExternalNullableText;
      region: ExternalNullableText;
      sector: ExternalNullableText;
    } | null;
    checklist: Array<{ title: string; status: string; hasLinkedDocument: boolean }>;
    documents: Array<{ documentCategory: string; status: string; serviceArea: string }>;
    tasks: Array<{ status: string; priority: string }>;
  };
};

const OPENAI_TIMEOUT_MS = 45_000;
const MAX_PROVIDER_REQUEST_ID_LENGTH = 255;

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

function safeTokenCount(value: unknown) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export function minimizeProviderRequestId(value: string | null | undefined) {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.length > MAX_PROVIDER_REQUEST_ID_LENGTH) return undefined;
  return /^[A-Za-z0-9._:-]+$/.test(trimmed) ? trimmed : undefined;
}

export function extractOpenAiUsage(
  data: { usage?: { input_tokens?: unknown; output_tokens?: unknown; total_tokens?: unknown } },
  requestId?: string | null,
): AiProviderUsageMetadata {
  const inputTokens = safeTokenCount(data.usage?.input_tokens);
  const outputTokens = safeTokenCount(data.usage?.output_tokens);
  const reportedTotal = safeTokenCount(data.usage?.total_tokens);
  const computedTotal = inputTokens !== undefined && outputTokens !== undefined && Number.isSafeInteger(inputTokens + outputTokens)
    ? inputTokens + outputTokens
    : undefined;
  return {
    inputTokens,
    outputTokens,
    totalTokens: reportedTotal ?? computedTotal,
    providerRequestId: minimizeProviderRequestId(requestId),
  };
}

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

function requiredExternalPayload(input: unknown): ExternalAiPayload {
  if (!input || typeof input !== 'object') {
    throw new UserFacingActionError('Payload esterno AI non valido.');
  }
  const candidate = input as Partial<ExternalAiPayload>;
  if (candidate.source !== 'CRM interno FAI' || candidate.humanReviewRequired !== true || !candidate.context) {
    throw new UserFacingActionError('Payload esterno AI non valido.');
  }
  return createExternalAiPayload(candidate as ExternalAiPayload);
}

function sanitizeExternalFreeText(value: string, maxLength: number) {
  return value
    .trim()
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email rimossa]')
    .replace(/\b[A-Z]{6}\d{2}[A-Z]\d{2}[A-Z]\d{3}[A-Z]\b/gi, '[codice fiscale rimosso]')
    .replace(/\bIT\d{2}[A-Z]\d{10}[0-9A-Z]{12}\b/gi, '[IBAN rimosso]')
    .slice(0, maxLength);
}

/** Rebuilds the DTO field-by-field so extra properties never cross egress. */
export function createExternalAiPayload(payload: ExternalAiPayload): ExternalAiPayload {
  const context = payload.context;
  return {
    source: 'CRM interno FAI',
    humanReviewRequired: true,
    ...(payload.operationalInstructions ? { operationalInstructions: sanitizeExternalFreeText(payload.operationalInstructions, 2000) } : {}),
    context: {
      client: { type: context.client.type, status: context.client.status },
      companies: context.companies.slice(0, 3).map((company) => ({
        annualRevenue: company.annualRevenue,
        legalForm: company.legalForm,
        atecoCode: company.atecoCode,
        region: company.region,
        employees: company.employees,
        durcStatus: company.durcStatus,
      })),
      service: context.service ? {
        label: sanitizeExternalFreeText(context.service.label, 200) || 'Pratica cliente',
        practiceType: context.service.practiceType,
        status: context.service.status,
        operationalStatus: context.service.operationalStatus,
        requestedAmount: context.service.requestedAmount,
        plannedInvestment: context.service.plannedInvestment,
      } : null,
      project: context.project ? {
        requestedAmount: context.project.requestedAmount,
        totalInvestment: context.project.totalInvestment,
        status: context.project.status,
        priority: context.project.priority,
        startTiming: context.project.startTiming,
        region: context.project.region,
        sector: context.project.sector,
      } : null,
      checklist: context.checklist.slice(0, 30).map((item) => ({
        title: sanitizeExternalFreeText(item.title, 200),
        status: item.status,
        hasLinkedDocument: item.hasLinkedDocument === true,
      })),
      documents: context.documents.slice(0, 30).map((document) => ({
        documentCategory: sanitizeExternalFreeText(document.documentCategory, 120),
        status: document.status,
        serviceArea: document.serviceArea,
      })),
      tasks: context.tasks.slice(0, 15).map((task) => ({ status: task.status, priority: task.priority })),
    },
  };
}

function hasFinancialValue(value: ExternalNullableNumber) {
  return value !== null && value !== '';
}

export function externalAiDataCategories(payload: ExternalAiPayload): ExternalAiDataCategory[] {
  const context = payload.context;
  return [
    'agent_configuration',
    'client_profile',
    ...(context.companies.length ? ['company_profile' as const] : []),
    ...(context.companies.some((company) => hasFinancialValue(company.annualRevenue))
      || Boolean(context.service && (hasFinancialValue(context.service.requestedAmount) || hasFinancialValue(context.service.plannedInvestment)))
      || Boolean(context.project && (hasFinancialValue(context.project.requestedAmount) || hasFinancialValue(context.project.totalInvestment)))
      ? ['financial_data' as const]
      : []),
    ...(context.project ? ['project_data' as const] : []),
    ...(context.service ? ['service_context' as const] : []),
    ...(context.documents.length ? ['document_metadata' as const] : []),
    ...(context.checklist.length ? ['checklist_status' as const] : []),
    ...(context.tasks.length ? ['task_metadata' as const] : []),
    ...(payload.operationalInstructions ? ['operator_instructions' as const] : []),
  ];
}

function buildOpenAiPrompt(agent: AiAgentRuntime, payload: ExternalAiPayload) {
  return [
    `Ruolo agente: ${agent.role || agent.code}.`,
    'Regole FAI obbligatorie:',
    '- FAI non eroga finanziamenti, non garantisce esiti e non promette contributi, finanziamenti o approvazioni.',
    '- Ogni risposta è una bozza interna soggetta a revisione umana obbligatoria.',
    '- Quando citi requisiti, bandi, agevolazioni, scadenze, ammissibilità o norme, scrivi "Da verificare su fonte ufficiale".',
    '- Produci testo semplice/Markdown in sezioni chiare: Sintesi, Dati usati, Criticità, Scenari, Documenti da verificare, Prossime azioni.',
    '- Non inventare dati mancanti; segnala cosa richiedere o validare.',
    'DTO CRM approvato per egress, senza identificativi catalogo, percorsi storage, checksum o file:',
    JSON.stringify(payload, null, 2),
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
  private readonly model: string;

  constructor(model: string) {
    const normalized = model.trim();
    if (!normalized) throw new UserFacingActionError('Un modello OpenAI esplicito è obbligatorio.');
    this.model = normalized;
  }

  async run(agent: AiAgentRuntime | string, input: unknown, permit?: ExternalAiPermit): Promise<AiDraft> {
    const runtime = normalizeAgent(agent);
    const externalPayload = requiredExternalPayload(input);
    consumeExternalAiPermit(permit, this.model);
    const apiKey = process.env.AI_API_KEY?.trim();
    if (!apiKey) throw new UserFacingActionError('Provider OpenAI configurato ma AI_API_KEY non è valorizzata. Imposta la chiave lato server oppure configura questo agente con provider mock.');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);
    let telemetry: AiProviderUsageMetadata = {};
    try {
      const response = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          instructions: runtime.systemPrompt || 'Sei un assistente AI interno FAI. Rispondi in italiano professionale.',
          input: buildOpenAiPrompt(runtime, externalPayload),
          max_output_tokens: 2500,
          store: false,
        }),
        signal: controller.signal,
      });
      telemetry = { providerRequestId: minimizeProviderRequestId(response.headers.get('x-request-id')) };
      if (!response.ok) {
        throw new AiProviderCallError(
          'Chiamata OpenAI non riuscita. Nessun output AI è stato salvato.',
          telemetry,
          `AI_PROVIDER_HTTP_${Math.floor(response.status / 100)}XX`,
        );
      }
      const data = await response.json() as {
        output_text?: string;
        output?: Array<{ content?: Array<{ text?: string }> }>;
        usage?: { input_tokens?: unknown; output_tokens?: unknown; total_tokens?: unknown };
      };
      telemetry = extractOpenAiUsage(data, response.headers.get('x-request-id'));
      const content = data.output_text || data.output?.flatMap((o) => o.content ?? []).map((c) => c.text).filter(Boolean).join('\n') || '';
      if (!content.trim()) throw new AiProviderCallError('OpenAI ha restituito una risposta vuota.', telemetry, 'AI_PROVIDER_EMPTY_RESPONSE');
      return {
        title: `Bozza OpenAI ${runtime.code} - ${externalPayload.context.service?.label || 'Pratica cliente'}`,
        content: content.trim(),
        metadata: { provider: 'openai', model: this.model, ...telemetry },
      };
    } catch (error) {
      if (error instanceof AiProviderCallError) throw error;
      if (error instanceof UserFacingActionError) throw error;
      const message = error instanceof Error && error.name === 'AbortError'
        ? 'Timeout durante la chiamata OpenAI. Riprova più tardi oppure configura questo agente con provider mock.'
        : 'Errore operativo durante la chiamata OpenAI. Nessun output AI è stato salvato.';
      throw new AiProviderCallError(message, telemetry);
    } finally {
      clearTimeout(timeout);
    }
  }
}

export type AiProviderName = 'mock' | 'openai';

export function normalizeAiProvider(value = process.env.AI_PROVIDER): AiProviderName {
  const normalized = value?.trim().toLowerCase();
  return normalized === 'openai' ? 'openai' : 'mock';
}

export type AiProviderDiagnostics = {
  provider: AiProviderName;
  configuredProvider: string;
  model: string;
  hasApiKey: boolean;
  mode: AiProviderName;
  externalEnvEnabled: boolean;
  allowedModels: string[];
  configurationStatus: 'ok' | 'incompleta';
};

export type AiProviderDiagnosticTestResult = {
  success: boolean;
  message: string;
  provider: AiProviderName;
  model: string;
  usage?: AiProviderUsageMetadata;
};

function configuredAllowedModels() {
  return [...new Set((process.env.AI_ALLOWED_MODELS ?? '').split(',').map((value) => value.trim()).filter(Boolean))];
}

export function getAiProviderDiagnostics(): AiProviderDiagnostics {
  const configuredProvider = process.env.AI_PROVIDER?.trim() || 'mock';
  const provider = normalizeAiProvider(configuredProvider);
  const hasApiKey = Boolean(process.env.AI_API_KEY?.trim());
  const model = process.env.AI_MODEL?.trim() || '';
  return {
    provider,
    configuredProvider,
    model,
    hasApiKey,
    mode: provider,
    externalEnvEnabled: process.env.AI_EXTERNAL_PROVIDERS_ENABLED === 'true',
    allowedModels: configuredAllowedModels(),
    configurationStatus: provider === 'openai' && (!hasApiKey || !configuredAllowedModels().includes(model)) ? 'incompleta' : 'ok',
  };
}

export async function testAiProviderDiagnostic(permit?: ExternalAiPermit): Promise<AiProviderDiagnosticTestResult> {
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

  consumeExternalAiPermit(permit, diagnostics.model);
  const apiKey = process.env.AI_API_KEY?.trim();
  if (!apiKey) {
    return { success: false, message: 'Provider OpenAI selezionato ma AI_API_KEY non è configurata lato server.', provider: diagnostics.provider, model: diagnostics.model };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);
  let usage: AiProviderUsageMetadata = {};
  try {
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: diagnostics.model,
        instructions: 'Rispondi solo con OK. Test tecnico interno senza dati cliente.',
        input: 'Test diagnostico provider AI CRM FAI. Non usare dati cliente.',
        max_output_tokens: 16,
        store: false,
      }),
      signal: controller.signal,
    });
    usage = { providerRequestId: minimizeProviderRequestId(response.headers.get('x-request-id')) };
    if (!response.ok) return { success: false, message: `Chiamata OpenAI non riuscita (HTTP ${response.status}). Nessun output AI salvato.`, provider: diagnostics.provider, model: diagnostics.model, usage };
    const data = await response.json() as { usage?: { input_tokens?: unknown; output_tokens?: unknown; total_tokens?: unknown } };
    usage = extractOpenAiUsage(data, response.headers.get('x-request-id'));
    return { success: true, message: 'Provider OpenAI raggiungibile: chiamata minima completata. Nessun output AI salvato.', provider: diagnostics.provider, model: diagnostics.model, usage };
  } catch (error) {
    const message = error instanceof Error && error.name === 'AbortError'
      ? 'Timeout durante il test OpenAI. Nessun output AI salvato.'
      : 'Errore controllato durante il test OpenAI. Nessun output AI salvato.';
    return { success: false, message, provider: diagnostics.provider, model: diagnostics.model, usage };
  } finally {
    clearTimeout(timeout);
  }
}

export function prepareAiOutput(draft: AiDraft) { return { ...draft, status: 'needs_review' as const, requiresHumanReview: true, forbiddenPhrases: scanForbiddenPhrases(draft.content) }; }
