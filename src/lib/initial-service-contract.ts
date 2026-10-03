import { z } from 'zod';
import { canonicalSha256 } from './canonical-json';

// Manual workflow identifiers from the existing Governance registry. This list
// neither invokes plugins nor attests that a plugin specification is qualified.
export const INITIAL_SERVICE_AGENT_IDS = ['A00', 'A01', 'A02', 'A03', 'A04', 'A05', 'A06', 'A07', 'A08', 'A09', 'A10', 'A11', 'Q01', 'Q02', 'Q03', 'D01'] as const;
export const INITIAL_SERVICE_DISCLAIMER = 'Non eroghiamo finanziamenti. Non promettiamo contributi. Non garantiamo esiti o erogazioni. Non operiamo come intermediari finanziari. Offriamo esclusivamente consulenza tecnica, strategica e di orientamento.';
export const INITIAL_SERVICE_LOGO_SHA256 = '008df460afebcf2829a0e4e0ab00a8f02df9795be07f81feccbb4c1c078536df';
export const INITIAL_SERVICE_PROTOCOL = 'FAI_INITIAL_SERVICE_MANUAL_V1';
export const initialServiceCodes = ['verifica_ai_essenziale', 'audit_ai_bancabilita', 'pre_analisi_ai_ammissibilita', 'dossier_preanalisi', 'consulenza_strategica_60'] as const;
export type InitialServiceCode = typeof initialServiceCodes[number];
type Definition = { producer: 'A01' | 'A02' | 'A03' | 'A04' | 'A08'; title: string; outcome: string; included: readonly string[];
  excluded: readonly string[]; materials: readonly string[]; sections: readonly string[]; numericReview: boolean };
export const INITIAL_SERVICES: Readonly<Record<InitialServiceCode, Definition>> = Object.freeze({
  verifica_ai_essenziale: { producer: 'A01', title: 'Verifica AI Essenziale', outcome: 'Quadro preliminare dei fatti disponibili, delle criticità e del prossimo passo.',
    included: ['Screening nel perimetro acquistato', 'Integrazioni necessarie a completare questo risultato'],
    excluded: ['Business plan', 'Domanda o presentazione', 'Promessa di contributi'],
    materials: ['Profilo del beneficiario', 'Esigenza e progetto', 'Evidenze disponibili'],
    sections: ['Inquadramento', 'Elementi verificati', 'Criticità e informazioni mancanti', 'Risultato autonomo'], numericReview: false },
  audit_ai_bancabilita: { producer: 'A02', title: 'Audit AI Bancabilità', outcome: 'Valutazione documentale e numerica con criticità, ipotesi e azioni verificabili.',
    included: ['Analisi dei documenti finanziari concordati', 'Coerenza dei numeri e limiti delle ipotesi'],
    excluded: ['Mediazione creditizia', 'Delibera o garanzia di finanziamento', 'Presentazione alla banca non incaricata'],
    materials: ['Bilanci e situazioni disponibili', 'Debiti e impegni dichiarati', 'Fabbisogno e impieghi'],
    sections: ['Perimetro e dati utilizzati', 'Analisi e riconciliazione numerica', 'Criticità documentali', 'Risultato autonomo'], numericReview: true },
  pre_analisi_ai_ammissibilita: { producer: 'A03', title: 'Pre-Analisi AI Ammissibilità', outcome: 'Confronto motivato tra requisiti ufficiali e fatti documentati, senza esito garantito.',
    included: ['Verifica dei requisiti nel perimetro concordato', 'Spese, tempi e vincoli pertinenti'],
    excluded: ['Domanda completa o presentazione', 'Parere legale sostitutivo', 'Certezza di ammissione'],
    materials: ['Profilo del beneficiario', 'Progetto e preventivi', 'Fonti ufficiali della misura e annualità'],
    sections: ['Misura e annualità', 'Requisiti ed evidenze', 'Spese, tempi e vincoli', 'Risultato autonomo'], numericReview: false },
  dossier_preanalisi: { producer: 'A04', title: 'Dossier Preanalisi', outcome: 'Dossier strategico con alternative motivate, priorità e prossimo passo.',
    included: ['Sintesi delle verifiche concordate', 'Strategia e priorità', 'Integrazioni interne al perimetro'],
    excluded: ['Business plan o domanda se non compresi nell’incarico', 'Acquisto obbligatorio di altri servizi', 'Garanzie di risultato'],
    materials: ['Obiettivi del cliente', 'Elaborati ed evidenze disponibili', 'Ipotesi e vincoli del progetto'],
    sections: ['Obiettivi e perimetro', 'Alternative e criteri', 'Strategia motivata', 'Risultato autonomo'], numericReview: false },
  consulenza_strategica_60: { producer: 'A08', title: 'Preparazione consulenza strategica di 60 minuti', outcome: 'Agenda, domande e materiali per una consulenza umana; lo svolgimento va registrato separatamente.',
    included: ['Preparazione della sessione', 'Agenda e domande', 'Riepilogo dei materiali e degli esiti umani quando acquisiti'],
    excluded: ['Simulazione di una consulenza umana mai svolta', 'Presentazioni o firme', 'Acquisto obbligatorio di ulteriori servizi'],
    materials: ['Obiettivo della sessione', 'Materiali disponibili', 'Quesiti e vincoli dichiarati'],
    sections: ['Obiettivo della consulenza', 'Agenda dei 60 minuti', 'Quesiti per il consulente umano', 'Materiali e risultato della preparazione'], numericReview: false },
});

const identifier = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const reference = z.string().min(1).max(120).regex(/^[A-Za-z][A-Za-z0-9_-]+$/);
export const initialServicePlanSchema = z.object({
  protocol: z.literal(INITIAL_SERVICE_PROTOCOL), workflowId: z.string().uuid(), caseId: identifier, serviceId: identifier,
  serviceCode: z.enum(initialServiceCodes), definitionVersion: z.literal(1),
  outputKind: z.enum(['REPORT', 'BUSINESS_PLAN', 'APPLICATION']), numericAnalysis: z.boolean(),
  supportingAgents: z.array(z.enum(['A05', 'A06', 'A07', 'A09', 'A10', 'A11'])).max(6),
  planVersion: z.number().int().positive().default(1), responsibleUserId: identifier.nullable().default(null),
  humanReviewerIds: z.array(identifier).max(2).default([]),
}).strict().refine(value => new Set(value.supportingAgents).size === value.supportingAgents.length, 'DUPLICATE_AGENT');
export type InitialServicePlan = z.infer<typeof initialServicePlanSchema>;
export const serviceReviewStages = ['A00', 'PRODUCER', 'Q01', 'Q02', 'Q03', 'HUMAN_1', 'HUMAN_2', 'D01'] as const;
export type ServiceReviewStage = typeof serviceReviewStages[number];
export const initialServiceReviewSchema = z.object({
  stage: z.enum(serviceReviewStages), decision: z.enum(['PASS', 'NOT_APPLICABLE', 'REQUEST_CHANGES']),
  versionId: z.string().uuid(), versionHash: hash, planHash: hash,
  actorId: identifier, recordedAt: z.string().datetime(),
  source: z.enum(['MANUAL_WORK_ATTESTATION', 'AUTHENTICATED_HUMAN']),
  reference, artifactHash: hash, note: z.string().trim().min(10).max(4000),
  agentId: z.enum(INITIAL_SERVICE_AGENT_IDS).nullable(), agentVersionReference: reference.nullable(),
}).strict();
export type InitialServiceReview = z.infer<typeof initialServiceReviewSchema>;

export function initialServicePlanHash(raw: unknown) { return canonicalSha256(initialServicePlanSchema.parse(raw)); }
export function initialServiceStages(raw: unknown) {
  const plan = initialServicePlanSchema.parse(raw), definition = INITIAL_SERVICES[plan.serviceCode];
  const dual = plan.supportingAgents.some(agent => ['A07', 'A09', 'A10', 'A11'].includes(agent))
    || plan.outputKind === 'BUSINESS_PLAN' || plan.outputKind === 'APPLICATION';
  return { stages: (dual ? serviceReviewStages : serviceReviewStages.filter(stage => stage !== 'HUMAN_2')) as readonly ServiceReviewStage[],
    q02Required: definition.numericReview || plan.numericAnalysis || plan.outputKind !== 'REPORT',
    humanReviewersRequired: dual ? 2 : 1, producer: definition.producer };
}

export class InitialServiceError extends Error {
  constructor(readonly code: 'INVALID' | 'CONFLICT' | 'REVIEW_REQUIRED' | 'CHANGES_REQUIRED' | 'DENIED') { super(code); }
}

/** Pure integrity check; callers must independently recheck live identities and scope. */
export function assessInitialServiceReviews(rawPlan: unknown, rawReviews: unknown[], version: { id: string; contentHash: string; createdById: string }) {
  const plan = initialServicePlanSchema.parse(rawPlan), policy = initialServiceStages(plan), planHash = initialServicePlanHash(plan);
  const reviews = rawReviews.map(value => initialServiceReviewSchema.parse(value));
  if (reviews.length > policy.stages.length) throw new InitialServiceError('CONFLICT');
  for (const [index, review] of reviews.entries()) {
    if (review.stage !== policy.stages[index] || review.planHash !== planHash
      || review.versionId !== version.id || review.versionHash !== version.contentHash) throw new InitialServiceError('CONFLICT');
    if (index && review.recordedAt < reviews[index - 1].recordedAt) throw new InitialServiceError('CONFLICT');
    const human = review.stage === 'HUMAN_1' || review.stage === 'HUMAN_2';
    const notApplicable = review.stage === 'Q02' && review.decision === 'NOT_APPLICABLE';
    const humanAttestation = human || notApplicable;
    const agent = humanAttestation ? null : review.stage === 'PRODUCER' ? policy.producer : review.stage;
    if (review.agentId !== agent || review.source !== (humanAttestation ? 'AUTHENTICATED_HUMAN' : 'MANUAL_WORK_ATTESTATION')
      || (humanAttestation ? review.agentVersionReference !== null : !review.agentVersionReference)) throw new InitialServiceError('DENIED');
    if (human && (review.actorId === version.createdById
      || reviews.slice(0, index).some(prior => prior.stage.startsWith('HUMAN_') && prior.actorId === review.actorId))) throw new InitialServiceError('DENIED');
    if (review.decision === 'NOT_APPLICABLE' && (review.stage !== 'Q02' || policy.q02Required || review.note.length < 30)) throw new InitialServiceError('DENIED');
    if (review.decision === 'REQUEST_CHANGES') {
      if (index !== reviews.length - 1) throw new InitialServiceError('CONFLICT');
      return { ready: false, blocked: 'CHANGES_REQUIRED' as const, nextStage: null, policy, reviews };
    }
  }
  return { ready: reviews.length === policy.stages.length, blocked: reviews.length === policy.stages.length ? null : 'REVIEW_REQUIRED' as const,
    nextStage: policy.stages[reviews.length] ?? null, policy, reviews };
}

const text = z.string().trim().min(1).max(6000);
export const initialServiceTemplateSchema = z.object({
  clientName: z.string().trim().min(1).max(300), date: z.string().date(), revision: z.number().int().positive(),
  sections: z.record(text), sources: z.array(z.object({ title: z.string().trim().min(1).max(300), reference: text,
    verifiedAt: z.string().date(), limitation: text }).strict()).min(1).max(50),
  limits: text, nextStep: text,
}).strict();

export function buildInitialServiceTemplate(serviceCode: InitialServiceCode, raw: unknown) {
  const definition = INITIAL_SERVICES[serviceCode], value = initialServiceTemplateSchema.parse(raw);
  if (!definition || JSON.stringify(Object.keys(value.sections).sort()) !== JSON.stringify([...definition.sections].sort())) throw new InitialServiceError('INVALID');
  return [
    '# ' + definition.title, '', '![Logo originale FAI](logo-fai.png)', '',
    'Cliente: ' + value.clientName, 'Servizio: ' + definition.title, 'Data: ' + value.date + ' · Revisione: ' + value.revision,
    '', '## Risultato compreso', definition.outcome, '',
    ...definition.sections.flatMap(section => ['## ' + section, value.sections[section], '']),
    '## Fonti ed evidenze', ...value.sources.flatMap(source => ['- ' + source.title + ' · ' + source.reference,
      '  Verifica: ' + source.verifiedAt + ' · Limite: ' + source.limitation]),
    '', '## Limiti', value.limits, '', '## Prossimo passo', value.nextStep,
    '', 'Gli eventuali acquisti successivi sono opzionali. Le integrazioni incluse nel perimetro acquistato non costituiscono un nuovo servizio a pagamento.',
    '', '## Avvertenza', INITIAL_SERVICE_DISCLAIMER, '',
  ].join('\n');
}
