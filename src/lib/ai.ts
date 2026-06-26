import { scanForbiddenPhrases } from './compliance';
export type AiDraft = { title: string; content: string; metadata?: Record<string, unknown> };
export interface AiProviderAdapter { run(agentCode: string, input: unknown): Promise<AiDraft>; }
export class MockAiAdapter implements AiProviderAdapter { async run(agentCode: string): Promise<AiDraft> { return { title: `Bozza interna ${agentCode}`, content: 'Bozza AI interna: verificare fonti ufficiali, condizioni bloccanti e dati caricati prima di qualsiasi uso.' }; } }
export function getAiAdapter(): AiProviderAdapter { if (!process.env.AI_API_KEY || process.env.AI_PROVIDER === 'mock') return new MockAiAdapter(); return new MockAiAdapter(); }
export function prepareAiOutput(draft: AiDraft) { return { ...draft, status: 'needs_review' as const, requiresHumanReview: true, forbiddenPhrases: scanForbiddenPhrases(draft.content) }; }
