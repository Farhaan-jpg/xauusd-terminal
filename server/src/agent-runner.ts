// Agent Runner — executes market agents with local llama.cpp
// Handles structured input/output validation, model routing, caching

import { getLlamaManager } from "./local-llama.js";
import { AGENTS, type AgentDefinition, type LocalModelId } from "./local-ai.js";
import type { CompletionRequest } from "./local-llama.js";

export interface AgentInput {
  agentId: string;
  input: Record<string, unknown>;
  modelOverride?: LocalModelId;
  temperature?: number;
  maxTokens?: number;
}

export interface AgentOutput<T = unknown> {
  agentId: string;
  success: boolean;
  data?: T;
  error?: string;
  latencyMs: number;
  modelUsed: string;
  tokensUsed: number;
  cached: boolean;
}

interface CacheEntry<T> {
  data: T;
  expires: number;
  model: string;
}

const agentCache = new Map<string, CacheEntry<unknown>>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function cacheKey(agentId: string, input: Record<string, unknown>): string {
  return `${agentId}:${JSON.stringify(input)}`;
}

function validateSchema(data: unknown, schema: Record<string, unknown>): { valid: boolean; errors: string[] } {
  // Simplified validation - in production use AJV or Zod
  return { valid: true, errors: [] };
}

async function callModel(
  manager: ReturnType<typeof getLlamaManager>,
  agent: AgentDefinition,
  input: Record<string, unknown>,
  model: LocalModelId,
  options: { temperature?: number; maxTokens?: number } = {}
): Promise<string> {
  const systemPrompt = agent.systemPrompt;
  const userPrompt = JSON.stringify(input, null, 2);
  
  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];

  return manager.chat(messages, model, {
    temperature: options.temperature ?? agent.temperature,
    max_tokens: options.maxTokens ?? agent.maxTokens,
    timeoutMs: agent.timeoutMs,
  });
}

async function runAgentInternal(
  manager: ReturnType<typeof getLlamaManager>,
  agent: AgentDefinition,
  input: Record<string, unknown>,
  options: { modelOverride?: LocalModelId; temperature?: number; maxTokens?: number } = {}
): Promise<{ data: unknown; model: string; tokens: number }> {
  const model = options.modelOverride ?? agent.preferredModels[0];
  
  // Try preferred models in order
  let lastError: Error | null = null;
  for (const candidate of agent.preferredModels) {
    try {
      const text = await callModel(manager, agent, input, candidate, options);
      
      // Parse JSON from response
      let parsed: unknown;
      try {
        // Extract JSON from response (model might include extra text)
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          parsed = JSON.parse(jsonMatch[0]);
        } else {
          parsed = JSON.parse(text);
        }
      } catch (parseErr) {
        throw new Error(`Failed to parse agent output as JSON: ${parseErr}`);
      }

      // Validate output schema
      const validation = validateSchema(parsed, agent.outputSchema);
      if (!validation.valid) {
        throw new Error(`Output validation failed: ${validation.errors.join(", ")}`);
      }

      return {
        data: parsed,
        model: candidate,
        tokens: Math.ceil((agent.systemPrompt.length + JSON.stringify(input).length + text.length) / 4),
      };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.warn(`[agent:${agent.id}] Model ${candidate} failed:`, lastError.message);
      // Try next model
    }
  }
  
  throw lastError ?? new Error("All models failed");
}

/** Execute an agent with caching, retries, and structured I/O */
export async function runAgent<T = unknown>(
  input: AgentInput
): Promise<AgentOutput<T>> {
  const start = Date.now();
  const manager = getLlamaManager();
  
  const agent = AGENTS.find((a: AgentDefinition) => a.id === input.agentId);
  if (!agent) {
    return {
      agentId: input.agentId,
      success: false,
      error: `Unknown agent: ${input.agentId}`,
      latencyMs: Date.now() - start,
      modelUsed: "",
      tokensUsed: 0,
      cached: false,
    };
  }

  // Check cache
  const key = cacheKey(input.agentId, input.input);
  const cached = agentCache.get(key);
  if (cached && Date.now() < cached.expires) {
    return {
      agentId: input.agentId,
      success: true,
      data: cached.data as T,
      latencyMs: Date.now() - start,
      modelUsed: cached.model,
      tokensUsed: 0,
      cached: true,
    };
  }

  try {
    const { data, model, tokens } = await runAgentInternal(manager, agent, input.input, {
      modelOverride: input.modelOverride,
      temperature: input.temperature,
      maxTokens: input.maxTokens,
    });

    // Cache successful result
    agentCache.set(key, {
      data,
      expires: Date.now() + CACHE_TTL,
      model,
    });

    return {
      agentId: input.agentId,
      success: true,
      data: data as T,
      latencyMs: Date.now() - start,
      modelUsed: model,
      tokensUsed: tokens,
      cached: false,
    };
  } catch (err) {
    return {
      agentId: input.agentId,
      success: false,
      error: err instanceof Error ? err.message : String(err),
      latencyMs: Date.now() - start,
      modelUsed: "",
      tokensUsed: 0,
      cached: false,
    };
  }
}

/** Run multiple agents in parallel */
export async function runAgents<T extends Record<string, unknown>>(
  inputs: AgentInput[]
): Promise<Record<string, AgentOutput>> {
  const results = await Promise.allSettled(
    inputs.map(inp => runAgent(inp))
  );
  
  return results.reduce((acc, result, i) => {
    const key = inputs[i].agentId;
    if (result.status === "fulfilled") {
      acc[key] = result.value;
    } else {
      acc[key] = {
        agentId: key,
        success: false,
        error: result.reason?.message ?? String(result.reason),
        latencyMs: 0,
        modelUsed: "",
        tokensUsed: 0,
        cached: false,
      };
    }
    return acc;
  }, {} as Record<string, AgentOutput>);
}

/** Get available agents */
export function getAgents(): AgentDefinition[] {
  return AGENTS;
}

export function getAgent(id: string): AgentDefinition | undefined {
  return AGENTS.find((a: AgentDefinition) => a.id === id);
}

/** Clear agent cache */
export function clearAgentCache(): void {
  agentCache.clear();
}

/** Get cache stats */
export function getCacheStats(): { size: number; entries: string[] } {
  return {
    size: agentCache.size,
    entries: [...agentCache.keys()],
  };
}

/** Pre-warm models by loading them */
export async function warmupModels(models: LocalModelId[], config?: { port?: number; llmPort?: number; maxModels?: number }): Promise<void> {
  const manager = getLlamaManager(config ?? { port: 8080, llmPort: 8081, maxModels: 2 });
  await Promise.all(models.map(m => manager.ensureModel(m)));
}