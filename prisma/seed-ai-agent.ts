import { Prisma, type AiAgent, type PrismaClient } from '@prisma/client';
import type { SeedAiAgentConfig } from './ai-agent-configs';

function jsonEqual(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function snapshotMatchesAgent(snapshot: {
  code: string;
  name: string;
  description: string;
  operationalScope: string;
  systemPrompt: string;
  requiredDataChecklist: unknown;
  expectedOutput: string;
  toneStyle: string;
  active: boolean;
  provider: string;
  model: string | null;
  promptVersion: string;
  inputSchema: unknown;
  outputSchema: unknown;
}, agent: AiAgent) {
  return snapshot.code === agent.code
    && snapshot.name === agent.name
    && snapshot.description === agent.description
    && snapshot.operationalScope === agent.operationalScope
    && snapshot.systemPrompt === agent.systemPrompt
    && jsonEqual(snapshot.requiredDataChecklist, agent.requiredDataChecklist)
    && snapshot.expectedOutput === agent.expectedOutput
    && snapshot.toneStyle === agent.toneStyle
    && snapshot.active === agent.active
    && snapshot.provider === agent.provider
    && snapshot.model === agent.futureModel
    && snapshot.promptVersion === agent.promptVersion
    && jsonEqual(snapshot.inputSchema, agent.inputSchema)
    && jsonEqual(snapshot.outputSchema, agent.outputSchema);
}

function versionData(agent: AiAgent, createdById?: string | null) {
  return {
    agentId: agent.id,
    version: agent.configVersion,
    code: agent.code,
    name: agent.name,
    description: agent.description,
    operationalScope: agent.operationalScope,
    systemPrompt: agent.systemPrompt,
    requiredDataChecklist: agent.requiredDataChecklist as Prisma.InputJsonValue,
    expectedOutput: agent.expectedOutput,
    toneStyle: agent.toneStyle,
    active: agent.active,
    provider: agent.provider,
    model: agent.futureModel,
    promptVersion: agent.promptVersion,
    inputSchema: agent.inputSchema as Prisma.InputJsonValue,
    outputSchema: agent.outputSchema as Prisma.InputJsonValue,
    createdById: createdById ?? null,
  };
}

/**
 * Creates missing seed agents and repairs missing/inconsistent snapshots.
 * Existing agent configuration is never overwritten: provider, model, prompt
 * and activation changes remain explicit Control Plane actions.
 */
export async function seedAiAgentConfig(
  prisma: PrismaClient,
  config: SeedAiAgentConfig,
  createdById?: string | null,
  source = createdById ? 'development_seed' : 'production_seed',
) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.aiAgent.findUnique({ where: { code: config.code } });
    let configurationChanged = !existing;
    let agent = existing
      ? existing
      : await tx.aiAgent.create({
          data: {
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
            futureModel: null,
            promptVersion: 'v1',
            configVersion: 1,
            inputSchema: {},
            outputSchema: { requiresHumanReview: true },
          },
        });

    const currentSnapshot = await tx.aiAgentConfigVersion.findUnique({
      where: {
        agentId_version: {
          agentId: agent.id,
          version: agent.configVersion,
        },
      },
    });

    // Repair a pre-existing inconsistent current version without mutating its
    // immutable historical row: advance and append a correct snapshot.
    if (currentSnapshot && !snapshotMatchesAgent(currentSnapshot, agent)) {
      configurationChanged = true;
      const nextVersion = agent.configVersion + 1;
      agent = await tx.aiAgent.update({
        where: { id: agent.id, configVersion: agent.configVersion },
        data: {
          promptVersion: `v${nextVersion}`,
          configVersion: nextVersion,
        },
      });
    }

    if (!currentSnapshot || !snapshotMatchesAgent(currentSnapshot, agent)) {
      configurationChanged = true;
      await tx.aiAgentConfigVersion.create({ data: versionData(agent, createdById) });
    }

    if (configurationChanged) {
      await tx.auditLog.create({
        data: {
          actorId: createdById ?? null,
          event: 'ai_agent_config_seed',
          entityType: 'AiAgent',
          entityId: agent.id,
          after: {
            source,
            code: agent.code,
            active: agent.active,
            provider: agent.provider,
            configVersion: agent.configVersion,
            promptVersion: agent.promptVersion,
          },
        },
      });
    }

    return { agent, configurationChanged };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}
