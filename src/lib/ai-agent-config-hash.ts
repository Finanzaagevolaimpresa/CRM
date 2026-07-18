import { canonicalSha256 } from './canonical-json';

export interface AiAgentConfigHashInput {
  readonly version: number;
  readonly code: string;
  readonly name: string;
  readonly description: string;
  readonly operationalScope: string;
  readonly systemPrompt: string;
  readonly requiredDataChecklist: unknown;
  readonly expectedOutput: string;
  readonly toneStyle: string;
  readonly active: boolean;
  readonly provider: string;
  readonly model: string | null;
  readonly promptVersion: string;
  readonly inputSchema: unknown;
  readonly outputSchema: unknown;
}

/**
 * Stable, database-id-independent identity for an immutable agent config
 * snapshot. Jobs persist this value and future consumers must re-compute it
 * from the referenced AiAgentConfigVersion before interpreting the config.
 */
export function createAiAgentConfigHash(config: AiAgentConfigHashInput) {
  return canonicalSha256({
    schemaVersion: 1,
    version: config.version,
    code: config.code,
    name: config.name,
    description: config.description,
    operationalScope: config.operationalScope,
    systemPrompt: config.systemPrompt,
    requiredDataChecklist: config.requiredDataChecklist,
    expectedOutput: config.expectedOutput,
    toneStyle: config.toneStyle,
    active: config.active,
    provider: config.provider,
    model: config.model,
    promptVersion: config.promptVersion,
    inputSchema: config.inputSchema,
    outputSchema: config.outputSchema,
  });
}
