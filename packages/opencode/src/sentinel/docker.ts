import { Process } from "@/util/process"

/**
 * Docker compose lifecycle management for Sentinel LLM containers.
 *
 * Wraps docker compose commands for stopping, starting, restarting
 * services and performing hot-swap model changes on the Sentinel stack.
 */
export namespace SentinelDocker {
  const HEALTH_POLL_MS = 5_000
  const DEFAULT_HEALTH_TIMEOUT_MS = 600_000
  const DEFAULT_PORT = 6969
  const DEFAULT_SERVICE = "orchestrator"
  const DEFAULT_CTX_MIN = 8192
  const DEFAULT_CTX_MAX = 65536
  const DEFAULT_CTX_FALLBACK = 32768

  /**
   * Model family prefix to maximum native context size.
   * Used by {@link lookupMaxCtx} for auto-detecting context windows.
   */
  export const MODEL_CATALOG: Record<string, number> = {
    "Qwen3.5": 262144,
    "Qwen3-Coder": 262144,
    "Qwen2.5": 131072,
    "gpt-oss-20b": 131072,
    "gpt-oss-120b": 131072,
    "gemma-3-270m": 32768,
    "gemma-4": 262144,
    "MiniMax-M2.1": 196608,
  }

  /**
   * Look up the maximum native context size for a GGUF filename.
   * Matches model family prefixes case-insensitively against {@link MODEL_CATALOG}.
   *
   * @param filename - GGUF filename (e.g. "Qwen3.5-122B-A10B-UD-Q4_K_XL-00001-of-00003.gguf")
   * @returns Maximum native context size, or 32768 if no match
   */
  export function lookupMaxCtx(filename: string): number {
    const lower = filename.toLowerCase()
    for (const [prefix, ctx] of Object.entries(MODEL_CATALOG)) {
      if (lower.startsWith(prefix.toLowerCase())) return ctx
    }
    return DEFAULT_CTX_FALLBACK
  }

  /**
   * Compute the auto context size for a model file.
   * Formula: clamp(lookupMaxCtx / 4, 8192, 65536)
   */
  function autoCtx(filename: string): number {
    const quarter = Math.floor(lookupMaxCtx(filename) / 4)
    return Math.max(DEFAULT_CTX_MIN, Math.min(quarter, DEFAULT_CTX_MAX))
  }

  /**
   * Convert a service name to the env var prefix used by docker-compose.yml.
   * e.g. "orchestrator" -> "ORCHESTRATOR", "deep-thinker" -> "DEEP_THINKER"
   */
  function envPrefix(service: string): string {
    return service.toUpperCase().replace(/-/g, "_")
  }

  /**
   * Run a docker compose command in the given project directory.
   *
   * @param args - Arguments to pass after `docker compose`
   * @param projectDir - Path to the directory containing docker-compose.yml
   * @param env - Additional environment variables to merge
   * @returns The command result
   */
  async function compose(
    args: string[],
    projectDir: string,
    env?: Record<string, string>,
  ): Promise<Process.TextResult> {
    return Process.text(["docker", "compose", ...args], {
      cwd: projectDir,
      env: env as NodeJS.ProcessEnv | undefined,
    })
  }

  /**
   * Stop a docker compose service.
   *
   * @param service - Compose service name (e.g. "orchestrator")
   * @param projectDir - Path to the directory containing docker-compose.yml
   */
  export async function stopService(service: string, projectDir: string): Promise<void> {
    await compose(["stop", service], projectDir)
  }

  /**
   * Start a docker compose service with optional environment variable overrides.
   *
   * @param service - Compose service name (e.g. "orchestrator")
   * @param projectDir - Path to the directory containing docker-compose.yml
   * @param env - Environment variables to pass to docker compose
   */
  export async function startService(
    service: string,
    projectDir: string,
    env: Record<string, string>,
  ): Promise<void> {
    await compose(["up", "-d", service], projectDir, env)
  }

  /**
   * Fully restart a compose service: stop, remove container, then start with new env.
   *
   * @param service - Compose service name (e.g. "orchestrator")
   * @param projectDir - Path to the directory containing docker-compose.yml
   * @param env - Environment variables to pass to docker compose on start
   */
  export async function restartService(
    service: string,
    projectDir: string,
    env: Record<string, string>,
  ): Promise<void> {
    await compose(["stop", service], projectDir)
    await compose(["rm", "-f", service], projectDir)
    await compose(["up", "-d", service], projectDir, env)
  }

  /**
   * Poll a llama-server health endpoint until it returns HTTP 200.
   *
   * @param port - Port to check (e.g. 6969)
   * @param timeoutMs - Maximum time to wait in milliseconds (default 600000)
   * @returns true if health check passed, false if timed out
   */
  export async function waitForHealth(
    port: number,
    timeoutMs: number = DEFAULT_HEALTH_TIMEOUT_MS,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://localhost:${port}/health`, {
          signal: AbortSignal.timeout(3000),
        })
        if (res.ok) return true
      } catch {
        // Connection refused or timeout — keep polling
      }
      const remaining = deadline - Date.now()
      if (remaining <= 0) break
      await sleep(Math.min(HEALTH_POLL_MS, remaining))
    }
    return false
  }

  /**
   * Query the /v1/models endpoint to discover the currently loaded model.
   *
   * @param port - Port of the llama-server instance
   * @returns The model ID string, or undefined if the endpoint is unreachable
   */
  export async function getLoadedModel(port: number): Promise<string | undefined> {
    try {
      const res = await fetch(`http://localhost:${port}/v1/models`, {
        signal: AbortSignal.timeout(5000),
      })
      if (!res.ok) return undefined
      const body = (await res.json()) as { data?: Array<{ id?: string }> }
      return body.data?.[0]?.id
    } catch {
      return undefined
    }
  }

  export interface HotswapOptions {
    /** Path to the directory containing docker-compose.yml */
    projectDir: string
    /** GGUF filename (must exist in the models/ volume) */
    ggufFilename: string
    /** llama-server port (default 6969) */
    port?: number
    /** Context size override; auto-detected from MODEL_CATALOG if omitted */
    ctx?: number
    /** Compose service name (default "orchestrator") */
    service?: string
  }

  export interface HotswapResult {
    success: boolean
    model: string
    elapsed: number
  }

  /**
   * Hot-swap an LLM model on a running compose service.
   *
   * Stops the container, removes it, then starts with new env vars pointing
   * to the requested GGUF file. Waits for the /health endpoint before returning.
   *
   * @param opts - Swap configuration
   * @returns Result with success flag, resolved model name, and elapsed time in ms
   */
  export async function hotswapModel(opts: HotswapOptions): Promise<HotswapResult> {
    const service = opts.service ?? DEFAULT_SERVICE
    const port = opts.port ?? DEFAULT_PORT
    const ctx = opts.ctx ?? autoCtx(opts.ggufFilename)
    const prefix = envPrefix(service)
    const start = Date.now()

    const env: Record<string, string> = {
      [`${prefix}_MODEL_FILE`]: opts.ggufFilename,
      [`${prefix}_CTX`]: String(ctx),
      [`${prefix}_GPU_LAYERS`]: "999",
      [`${prefix}_CACHE_TYPE_K`]: "q8_0",
      [`${prefix}_CACHE_TYPE_V`]: "q8_0",
      [`${prefix}_FA`]: "1",
      [`${prefix}_THREADS`]: "8",
      [`${prefix}_THREADS_BATCH`]: "16",
      [`${prefix}_PORT`]: String(port),
      [`${prefix}_CHAT_TEMPLATE_KWARGS`]: '{"enable_thinking":false}',
      [`${prefix}_REASONING_FORMAT`]: "none",
    }

    await restartService(service, opts.projectDir, env)

    const healthy = await waitForHealth(port)
    const elapsed = Date.now() - start

    const model = healthy ? ((await getLoadedModel(port)) ?? opts.ggufFilename) : opts.ggufFilename

    return { success: healthy, model, elapsed }
  }

  /** Promise-based sleep utility. */
  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}
