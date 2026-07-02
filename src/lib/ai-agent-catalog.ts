export const OFFICIAL_FAI_AGENT_CODES = [
  'verifica_ai_preliminare_fai',
  'audit_ai_bancabilita_fai',
  'consulenza_strategica_fai',
  'pre_analisi_ai_ammissibilita_fai',
  'dossier_strategico_fai',
  'ottimizzazione_ai_progetto_fai',
  'progetti_digitali_software_piattaforme_fai',
] as const;

export const SPECIALIST_FAI_AGENT_CODES = [
  'business_plan_fai',
  'verifica_spese_ammissibili_fai',
  'cumulabilita_agevolazioni_fai',
  'revisore_ai_fai',
  'governance_prompt_ai_fai',
] as const;

export const CANONICAL_INTERNAL_AGENT_CODES = [
  'bancabilita',
  'pre_analisi_agevolata',
  'finanza_ordinaria',
  'ottimizzazione_pratica',
  'dossier_cliente',
] as const;

export type AiAgentCategory = 'Ufficiale FAI' | 'Specialistico interno' | 'Canonico tecnico' | 'Legacy / storico';

function includesCode(codes: readonly string[], code?: string | null) {
  return Boolean(code && codes.includes(code));
}

export function isOfficialFaiAgent(code?: string | null) {
  return includesCode(OFFICIAL_FAI_AGENT_CODES, code);
}

export function isSpecialistFaiAgent(code?: string | null) {
  return includesCode(SPECIALIST_FAI_AGENT_CODES, code);
}

export function isCanonicalInternalAgent(code?: string | null) {
  return includesCode(CANONICAL_INTERNAL_AGENT_CODES, code);
}

export function isLegacyAiAgent(code?: string | null) {
  return !isOfficialFaiAgent(code) && !isSpecialistFaiAgent(code) && !isCanonicalInternalAgent(code);
}

export function getAiAgentCategory(code?: string | null): AiAgentCategory {
  if (isOfficialFaiAgent(code)) return 'Ufficiale FAI';
  if (isSpecialistFaiAgent(code)) return 'Specialistico interno';
  if (isCanonicalInternalAgent(code)) return 'Canonico tecnico';
  return 'Legacy / storico';
}

export function getAiAgentSortOrder(code?: string | null) {
  if (isOfficialFaiAgent(code)) return 10 + OFFICIAL_FAI_AGENT_CODES.indexOf(code as never);
  if (isSpecialistFaiAgent(code)) return 100 + SPECIALIST_FAI_AGENT_CODES.indexOf(code as never);
  if (isCanonicalInternalAgent(code)) return 200 + CANONICAL_INTERNAL_AGENT_CODES.indexOf(code as never);
  return 300;
}

export function sortAiAgentsByCategory<T extends { code: string; name: string }>(agents: T[]) {
  return [...agents].sort((a, b) => getAiAgentSortOrder(a.code) - getAiAgentSortOrder(b.code) || a.name.localeCompare(b.name, 'it'));
}

export function isPrimaryOperationalAiAgent(code?: string | null) {
  return isOfficialFaiAgent(code) || isSpecialistFaiAgent(code);
}
