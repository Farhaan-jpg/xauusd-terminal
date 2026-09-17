// llama.cpp Server Manager — runs local inference server as child process
// Handles model loading, swapping, health checks, and request routing

import { spawn, ChildProcess, SpawnOptions } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { cpus } from "node:os";
import { MODEL_SPECS, type LocalModelId, type ModelSpec, type ModelCapability } from "./local-ai.js";
// Use global fetch (Node 18+) instead of undici to avoid Response type conflicts

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface LlamaServerConfig {
  port: number;
  host: string;
  llmPort?: number;      // separate port for LLM server (default: port + 1)
  modelsDir: string;
  llamaCppPath?: string; // auto-detected if not provided
  nThreads?: number;     // auto = logical cores - 1
  nGpuLayers?: number;   // 0 = CPU only (for i3 integrated graphics)
  ctxSize?: number;      // context window
  batchSize?: number;
  maxModels?: number;    // max concurrent models (1 for 8GB)
}

export interface LoadedModel {
  id: string;
  model: string;
  slot: number;
  loadedAt: number;
  lastUsed: number;
  requestCount: number;
}

export interface CompletionRequest {
  model: string;
  prompt: string;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  repeat_penalty?: number;
  stop?: string[];
  stream?: boolean;
  grammar?: string;      // GBNF grammar for structured output
  json_schema?: object;  // JSON schema for structured output
  timeoutMs?: number;    // request timeout in ms
}

export interface CompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    text: string;
    logprobs: null;
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface EmbeddingRequest {
  model: string;
  input: string | string[];
}

export interface EmbeddingResponse {
  object: string;
  data: Array<{
    object: string;
    index: number;
    embedding: number[];
  }>;
  model: string;
  usage: {
    prompt_tokens: number;
    total_tokens: number;
  };
}

export interface ModelSlot {
  model: string | null;
  loadedAt: number;
  lastUsed: number;
  requestCount: number;
}

class LlamaCppManager {
  private process: ChildProcess | null = null;
  private config: LlamaServerConfig;
  private baseUrl: string;
  private llmBaseUrl: string;
  private slots: ModelSlot[] = [];
  private maxSlots: number;
  private modelMap: Map<string, string> = new Map(); // modelId -> filename
  private isStarting = false;
  private startPromise: Promise<void> | null = null;
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private requestQueue: Array<() => void> = [];
  private isProcessing = false;

  constructor(config: Partial<LlamaServerConfig> = {}) {
    // Compiled JS is in server/dist, so __dirname = server/dist
    // Go up one level to server/, then into models/
    const root = join(__dirname, "..");
    const modelsDir = join(root, "models");
    mkdirSync(modelsDir, { recursive: true });

    this.config = {
      port: config.port ?? 8080,
      host: config.host ?? "127.0.0.1",
      llmPort: config.llmPort ?? (config.port ?? 8080) + 1,
      modelsDir,
      llamaCppPath: config.llamaCppPath,
      nThreads: config.nThreads ?? Math.max(1, (cpus().length ?? 4) - 1),
      nGpuLayers: config.nGpuLayers ?? 0, // CPU only for i3
      ctxSize: config.ctxSize ?? 4096,
      batchSize: config.batchSize ?? 512,
      maxModels: config.maxModels ?? 1,
    };
    this.maxSlots = this.config.maxModels ?? 1;
    this.slots = Array(this.maxSlots).fill(null).map(() => ({ model: null, loadedAt: 0, lastUsed: 0, requestCount: 0 }));
    this.baseUrl = `http://${this.config.host}:${this.config.port}`;
    this.llmBaseUrl = `http://${this.config.host}:${this.config.llmPort}`;
    
    // Map our model IDs to llama.cpp server aliases (models are pre-loaded manually)
    this.modelMap.set("nomic-embed-v1.5", "embeddings");
    this.modelMap.set("qwen2.5-3b", "qwen");
    // Also map by filename for download/load
    for (const [id, spec] of Object.entries(MODEL_SPECS)) {
      if (!this.modelMap.has(id)) {
        this.modelMap.set(id, spec.filename);
      }
    }
    
    // Pre-populate slots with models that are already loaded on external servers
    // Embeddings model on baseUrl
    this.slots[0] = { model: "nomic-embed-v1.5", loadedAt: Date.now(), lastUsed: Date.now(), requestCount: 0 };
    // LLM model on llmBaseUrl
    if (this.maxSlots > 1) {
      this.slots[1] = { model: "qwen2.5-3b", loadedAt: Date.now(), lastUsed: Date.now(), requestCount: 0 };
    }
  }

  /** Auto-detect llama-server binary */
  private async findLlamaCpp(): Promise<string> {
    const candidates = [
      this.config.llamaCppPath,
      join(this.config.modelsDir, "llama-server.exe"),
      join(this.config.modelsDir, "llama-server"),
      join(__dirname, "..", "..", "llama-server.exe"),
      join(__dirname, "..", "..", "llama-server"),
      "llama-server", // PATH
    ].filter(Boolean) as string[];

    for (const path of candidates) {
      try {
        const proc = spawn(path, ["--version"], { stdio: "ignore" });
        await new Promise<void>((resolve, reject) => {
          proc.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`exit ${code}`)));
          proc.on("error", reject);
          setTimeout(() => reject(new Error("timeout")), 3000);
        });
        return path;
      } catch {
        continue;
      }
    }
    throw new Error("llama-server not found. Download from https://github.com/ggml-org/llama.cpp/releases");
  }

  /** Start the llama.cpp server manager (connects to existing servers) */
  async start(): Promise<void> {
    if (this.process && !this.process.killed) return;
    if (this.startPromise) return this.startPromise;

    this.startPromise = (async () => {
      this.isStarting = true;

      // Wait for existing servers to be ready (we run them manually)
      await this.waitForHealthy(30000);
      this.startHealthChecks();
      this.isStarting = false;
    })();

    return this.startPromise;
  }

  private async waitForHealthy(timeoutMs: number): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const [embeddingsOk, llmOk] = await Promise.all([
          fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(2000) }).then(r => r.ok).catch(() => false),
          fetch(`${this.llmBaseUrl}/health`, { signal: AbortSignal.timeout(2000) }).then(r => r.ok).catch(() => false),
        ]);
        if (embeddingsOk && llmOk) return;
      } catch { /* wait */ }
      await new Promise(r => setTimeout(r, 500));
    }
    throw new Error("llama.cpp servers failed to start within timeout");
  }

  private startHealthChecks(): void {
    this.healthCheckInterval = setInterval(async () => {
      try {
        const [embeddingsOk, llmOk] = await Promise.all([
          fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(2000) }).then(r => r.ok).catch(() => false),
          fetch(`${this.llmBaseUrl}/health`, { signal: AbortSignal.timeout(2000) }).then(r => r.ok).catch(() => false),
        ]);
        if (!embeddingsOk || !llmOk) {
          console.warn("[llama.cpp] health check failed, restarting...");
          this.stop();
          await this.start();
        }
      } catch {
        console.warn("[llama.cpp] health check failed, restarting...");
        this.stop();
        await this.start();
      }
    }, 30000);
  }

  /** Load a model into a slot (uses correct server based on model type) */
  async loadModel(modelId: string, slot?: number): Promise<number> {
    await this.start();
    
    const filename = this.modelMap.get(modelId) ?? `${modelId}.gguf`;
    const modelPath = join(this.config.modelsDir, filename);
    
    if (!existsSync(modelPath)) {
      throw new Error(`Model not found: ${modelPath}. Download first.`);
    }

    // Determine which server to use
    const isEmbedding = modelId === "nomic-embed-v1.5";
    const serverUrl = isEmbedding ? this.baseUrl : this.llmBaseUrl;

    // Find slot
    let targetSlot = slot ?? this.findBestSlot();
    const currentModel = this.slots[targetSlot]?.model;
    
    if (currentModel === modelId) {
      this.slots[targetSlot]!.loadedAt = Date.now();
      return targetSlot;
    }

    // Load model into slot on the correct server
    const modelAlias = this.modelMap.get(modelId) ?? modelId;
    const res = await fetch(`${serverUrl}/v1/models/load`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: modelAlias,
        slot: targetSlot,
        n_ctx: this.config.ctxSize,
        n_gpu_layers: this.config.nGpuLayers,
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Failed to load model: ${err}`);
    }

    this.slots[targetSlot] = { model: modelId, loadedAt: Date.now(), lastUsed: Date.now(), requestCount: 0 };
    return targetSlot;
  }

  private findBestSlot(): number {
    // Prefer empty slot
    const empty = this.slots.findIndex(s => s.model === null);
    if (empty >= 0) return empty;
    // Otherwise LRU
    let oldest = 0;
    let oldestTime = Infinity;
    this.slots.forEach((s, i) => {
      if (s.loadedAt < oldestTime) {
        oldestTime = s.loadedAt;
        oldest = i;
      }
    });
    return oldest;
  }

  /** Ensure model is loaded, return slot */
  async ensureModel(modelId: string): Promise<number> {
    const existing = this.slots.findIndex(s => s.model === modelId);
    if (existing >= 0) {
      this.slots[existing]!.lastUsed = Date.now();
      this.slots[existing]!.requestCount++;
      return existing;
    }
    
    // Check if model is already loaded on the server
    const isEmbedding = modelId === "nomic-embed-v1.5";
    const serverUrl = isEmbedding ? this.baseUrl : this.llmBaseUrl;
    try {
      const res = await fetch(`${serverUrl}/v1/models`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const data = await res.json();
        const modelAlias = this.modelMap.get(modelId) ?? modelId;
        const found = data.data?.some((m: any) => m.id === modelAlias);
        if (found) {
          // Model is already loaded on server, just add to local slots
          const targetSlot = this.findBestSlot();
          this.slots[targetSlot] = { model: modelId, loadedAt: Date.now(), lastUsed: Date.now(), requestCount: 0 };
          return targetSlot;
        }
      }
    } catch { /* ignore */ }
    
    return this.loadModel(modelId);
  }

  /** Completion with automatic model loading */
  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    await this.ensureModel(req.model);
    return this.requestWithRetry(() => 
      fetch(`${this.llmBaseUrl}/v1/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req),
        signal: AbortSignal.timeout(req.timeoutMs ?? 30000),
      })
    );
  }

  /** Embeddings (uses embeddings server) */
  async embed(req: EmbeddingRequest): Promise<EmbeddingResponse> {
    await this.ensureModel("nomic-embed-v1.5");
    return this.requestWithRetry(() =>
      fetch(`${this.baseUrl}/v1/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req),
        signal: AbortSignal.timeout(15000),
      })
    );
  }

  /** Chat completion (uses LLM server) */
  async chat(messages: Array<{role: string; content: string}>, model: string, options: Partial<CompletionRequest> = {}): Promise<string> {
    await this.ensureModel(model);
    const res = await fetch(`${this.llmBaseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: options.max_tokens ?? 512,
        temperature: options.temperature ?? 0.1,
        top_p: options.top_p ?? 0.9,
        stream: false,
        ...options,
      }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 30000),
    });
    if (!res.ok) throw new Error(`Chat failed: ${await res.text()}`);
    const data = await res.json();
    return data.choices[0]?.message?.content ?? "";
  }

  private async requestWithRetry<T>(fn: () => Promise<Response>, retries = 2): Promise<T> {
    for (let i = 0; i <= retries; i++) {
      try {
        const res = await fn();
        if (res.ok) return res.json() as Promise<T>;
        if (res.status === 404 && i < retries) {
          // Model might have been unloaded, try reload
          await new Promise(r => setTimeout(r, 1000));
          continue;
        }
        throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      } catch (err) {
        if (i === retries) throw err;
        await new Promise(r => setTimeout(r, 1000 * (i + 1)));
      }
    }
    throw new Error("Max retries exceeded");
  }

  /** Download a model file with progress */
  async downloadModel(modelId: string, onProgress?: (downloaded: number, total: number) => void): Promise<string> {
    const spec = MODEL_SPECS[modelId as LocalModelId];
    if (!spec) throw new Error(`Unknown model: ${modelId}`);
    
    const dest = join(this.config.modelsDir, spec.filename);
    if (existsSync(dest)) return dest;

    console.log(`[llama.cpp] Downloading ${modelId} (${spec.sizeGB}GB)...`);
    
    const res = await fetch(spec.url, { 
      signal: AbortSignal.timeout(300000),
    });
    
    if (!res.ok) throw new Error(`Download failed: ${res.status}`);
    if (!res.body) throw new Error("No response body");

    const total = Number(res.headers.get("content-length") ?? "0");
    let downloaded = 0;
    const chunks: Uint8Array[] = [];

    for await (const chunk of res.body) {
      chunks.push(chunk);
      downloaded += chunk.length;
      onProgress?.(downloaded, total);
    }

    const buffer = Buffer.concat(chunks);
    writeFileSync(dest, buffer);
    console.log(`[llama.cpp] Saved ${spec.filename} (${(buffer.length/1e6).toFixed(1)}MB)`);
    
    this.modelMap.set(modelId, spec.filename);
    return dest;
  }

  /** Get status of all slots */
  async getStatus(): Promise<{ server: boolean; slots: LoadedModel[]; memory: { used: number; total: number } }> {
    let embeddingsOk = false;
    let llmOk = false;
    try {
      const [embeddingsRes, llmRes] = await Promise.all([
        fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(2000) }).then(r => r.ok).catch(() => false),
        fetch(`${this.llmBaseUrl}/health`, { signal: AbortSignal.timeout(2000) }).then(r => r.ok).catch(() => false),
      ]);
      embeddingsOk = embeddingsRes;
      llmOk = llmRes;
    } catch { /* ignore */ }
    
    return {
      server: embeddingsOk && llmOk,
      slots: this.slots.map((s, i) => ({
        id: `slot-${i}`,
        model: s.model ?? "",
        slot: i,
        loadedAt: s.loadedAt,
        lastUsed: s.lastUsed ?? s.loadedAt,
        requestCount: s.requestCount ?? 0,
      })),
      memory: { used: 0, total: 0 },
    };
  }

  /** Stop server and cleanup */
  stop(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
    // We don't kill the process since we're using external servers
    this.process = null;
    this.slots = this.slots.map(() => ({ model: null, loadedAt: 0, lastUsed: 0, requestCount: 0 }));
  }
}

// Singleton instance
let managerInstance: LlamaCppManager | null = null;

export function getLlamaManager(config?: Partial<LlamaServerConfig>): LlamaCppManager {
  if (!managerInstance) {
    managerInstance = new LlamaCppManager(config);
  }
  return managerInstance;
}

export function resetLlamaManager(): void {
  if (managerInstance) {
    managerInstance.stop();
    managerInstance = null;
  }
}

// Re-export types from local-ai for convenience
export { MODEL_SPECS, type LocalModelId, type ModelSpec, type ModelCapability, RECOMMENDED_COMBOS, getOptimalModelSet, estimateTotalRam, canRunModels } from "./local-ai.js";