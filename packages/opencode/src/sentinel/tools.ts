import z from "zod"
import path from "path"
import fs from "fs"
import { execFile as execFileCb } from "child_process"
import { promisify } from "util"
import { Tool } from "@/tool/tool"
import { Instance } from "@/project/instance"
import { SentinelDocker } from "./docker"

const execFile = promisify(execFileCb)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** GGUF filter: skip embedding models and multipart non-first parts. */
function isRelevantGguf(name: string): boolean {
  if (name.startsWith("bge-")) return false
  if (/-0000[2-9]-of-/.test(name)) return false
  if (/-000[1-9][0-9]-of-/.test(name)) return false
  return true
}

/** Format bytes as "X.YG". */
function formatGB(bytes: number): string {
  return (bytes / 1024 ** 3).toFixed(1) + "G"
}

/** Sum the sizes of all parts for a multipart GGUF, or just the single file size. */
function totalGgufSize(modelsDir: string, filename: string): number {
  const match = filename.match(/-00001-of-(\d+)/)
  if (!match) {
    try {
      return fs.statSync(path.join(modelsDir, filename)).size
    } catch {
      return 0
    }
  }
  const nParts = parseInt(match[1], 10)
  let total = 0
  for (let i = 1; i <= nParts; i++) {
    const partName = filename.replace(/-00001-of-\d+/, `-${String(i).padStart(5, "0")}-of-${match[1]}`)
    try {
      total += fs.statSync(path.join(modelsDir, partName)).size
    } catch {
      // part missing — skip
    }
  }
  return total
}

/** Find GGUF files matching a pattern (exact or substring). */
function findMatchingGguf(modelsDir: string, pattern: string): string[] {
  let files: string[]
  try {
    files = fs.readdirSync(modelsDir).filter((f) => f.endsWith(".gguf"))
  } catch {
    return []
  }

  // Exact match first
  if (pattern.endsWith(".gguf") && files.includes(pattern)) {
    return [pattern]
  }

  // Substring match (case-insensitive)
  const lower = pattern.toLowerCase()
  const matches = files.filter((f) => f.toLowerCase().includes(lower))

  // Filter out embedding and multipart non-first
  return matches.filter(isRelevantGguf)
}

/** Derive a clean label from a GGUF filename. */
function labelFromGguf(filename: string): string {
  return filename.replace(/\.gguf$/, "").replace(/-00001-of-\d+/, "")
}

/** Read and parse a JSON file, returning undefined on error. */
function readJson(filepath: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(fs.readFileSync(filepath, "utf-8")) as Record<string, unknown>
  } catch {
    return undefined
  }
}

/** Get the most recent JSON files from a directory, sorted by mtime descending. */
function recentJsonFiles(dir: string, limit: number): string[] {
  let files: string[]
  try {
    files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => path.join(dir, f))
  } catch {
    return []
  }

  return files
    .map((f) => ({ path: f, mtime: fs.statSync(f).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit)
    .map((f) => f.path)
}

// ---------------------------------------------------------------------------
// Tool 1: sentinel_discover — list available GGUF models
// ---------------------------------------------------------------------------

export const SentinelDiscoverTool = Tool.define("sentinel_discover", {
  description:
    "List all available GGUF model files in the project's models/ directory. " +
    "Shows filename, file size (GB), and maximum native context size from the model catalog. " +
    "Excludes embedding models (bge-*) and multipart non-first parts.",
  parameters: z.object({}),
  async execute() {
    const modelsDir = path.join(Instance.directory, "models")
    let entries: string[]
    try {
      entries = fs.readdirSync(modelsDir).filter((f) => f.endsWith(".gguf")).sort()
    } catch {
      return {
        title: "models/",
        metadata: { count: 0 },
        output: "No models/ directory found.",
      }
    }

    // Filter to relevant files
    const relevant = entries.filter(isRelevantGguf)

    if (relevant.length === 0) {
      return {
        title: "models/",
        metadata: { count: 0 },
        output: "No GGUF models found in models/.",
      }
    }

    // Build table
    const header = `${"Filename".padEnd(65)} ${"Size".padStart(8)} ${"Max CTX".padStart(10)}`
    const separator = "-".repeat(header.length)
    const rows = relevant.map((name) => {
      const size = totalGgufSize(modelsDir, name)
      const maxCtx = SentinelDocker.lookupMaxCtx(name)
      const note = /-00001-of-/.test(name) ? " (multipart)" : ""
      return `${name.padEnd(65)} ${formatGB(size).padStart(8)} ${maxCtx.toLocaleString().padStart(10)}${note}`
    })

    const output = [header, separator, ...rows, "", `${relevant.length} models found (embedding models excluded)`].join(
      "\n",
    )

    return {
      title: `${relevant.length} models`,
      metadata: { count: relevant.length },
      output,
    }
  },
})

// ---------------------------------------------------------------------------
// Tool 2: sentinel_bench_load — load a model and benchmark it
// ---------------------------------------------------------------------------

export const SentinelBenchLoadTool = Tool.define("sentinel_bench_load", {
  description:
    "Load a GGUF model into the orchestrator container and benchmark it. " +
    "Finds the matching GGUF file, hot-swaps the Docker container, waits for health, " +
    "then runs the inference benchmark and returns TG/PP results.",
  parameters: z.object({
    model: z.string().describe("GGUF filename or pattern (e.g. gpt-oss-20b)"),
    passes: z.number().optional().describe("Benchmark passes (default 3)"),
    ctx: z.number().optional().describe("Context size override"),
  }),
  async execute(args, _ctx) {
    const modelsDir = path.join(Instance.directory, "models")
    const matches = findMatchingGguf(modelsDir, args.model)

    if (matches.length === 0) {
      return {
        title: "No match",
        metadata: {},
        output: `No model matching '${args.model}' found in models/.\nUse sentinel_discover to list available models.`,
      }
    }

    const gguf = matches[0]
    const label = labelFromGguf(gguf)
    const passes = args.passes ?? 3
    const lines: string[] = []

    if (matches.length > 1) {
      lines.push(`Multiple matches found, using first: ${gguf}`)
      lines.push(`Other matches: ${matches.slice(1).join(", ")}`)
      lines.push("")
    }

    // Hot-swap the model
    lines.push(`Loading ${gguf}...`)
    const result = await SentinelDocker.hotswapModel({
      projectDir: Instance.directory,
      ggufFilename: gguf,
      ctx: args.ctx,
    })

    if (!result.success) {
      lines.push(`FAILED: Model did not become healthy after ${Math.round(result.elapsed / 1000)}s`)
      return {
        title: `Load failed: ${label}`,
        metadata: { model: gguf, success: false },
        output: lines.join("\n"),
      }
    }

    lines.push(`Model healthy (${Math.round(result.elapsed / 1000)}s load time)`)
    lines.push(`Running benchmark: ${passes} passes...`)
    lines.push("")

    // Run the benchmark via sentinel CLI
    const sentinelBin = path.join(Instance.directory, ".venv", "bin", "sentinel")
    try {
      const { stdout, stderr } = await execFile(
        sentinelBin,
        ["bench", "run", "--port", "6969", "--label", label, "--passes", passes.toString()],
        {
          cwd: Instance.directory,
          timeout: 600_000,
          env: {
            ...process.env,
            PATH: `${path.join(Instance.directory, ".venv", "bin")}:${process.env.PATH}`,
          },
        },
      )

      if (stderr) {
        lines.push(stderr.trim())
      }

      // Read the latest result
      const resultsDir = path.join(Instance.directory, "benchmarks", "results", "inference")
      const resultFiles = recentJsonFiles(resultsDir, 1)

      if (resultFiles.length > 0) {
        const data = readJson(resultFiles[0])
        if (data) {
          const summary = data.summary as Record<string, number> | undefined
          if (summary) {
            lines.push("Benchmark Results:")
            lines.push(`  Token Generation: ${summary.tg_mean?.toFixed(2)} tok/s mean, ${summary.tg_median?.toFixed(2)} tok/s median`)
            lines.push(`  Prompt Processing: ${summary.pp_mean?.toFixed(2)} tok/s mean, ${summary.pp_median?.toFixed(2)} tok/s median`)
            lines.push(`  TG stdev: ${summary.tg_stdev?.toFixed(2)}, PP stdev: ${summary.pp_stdev?.toFixed(2)}`)
            lines.push(`  Total passes: ${summary.total_passes}`)
            lines.push("")
            lines.push(`Results saved: ${resultFiles[0]}`)
          }
        }
      }

      if (!lines.some((l) => l.includes("Benchmark Results:"))) {
        // Fallback: show raw output
        lines.push(stdout.trim())
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      lines.push(`Benchmark error: ${msg}`)
    }

    return {
      title: `Bench: ${label}`,
      metadata: { model: gguf, label },
      output: lines.join("\n"),
    }
  },
})

// ---------------------------------------------------------------------------
// Tool 3: sentinel_hotswap — switch to a different model
// ---------------------------------------------------------------------------

export const SentinelHotswapTool = Tool.define("sentinel_hotswap", {
  description:
    "Hot-swap the orchestrator LLM container to a different GGUF model. " +
    "Stops the current container, starts with the new model, and waits for health. " +
    "OpenCode keeps running — only the backing LLM changes.",
  parameters: z.object({
    model: z.string().describe("GGUF filename or pattern (e.g. Qwen3.5-27B, gpt-oss-20b)"),
    ctx: z.number().optional().describe("Context size override (auto-detected from model catalog if omitted)"),
  }),
  async execute(args, _ctx) {
    const modelsDir = path.join(Instance.directory, "models")
    const matches = findMatchingGguf(modelsDir, args.model)

    if (matches.length === 0) {
      return {
        title: "No match",
        metadata: {},
        output: `No model matching '${args.model}' found in models/.\nUse sentinel_discover to list available models.`,
      }
    }

    const gguf = matches[0]
    const label = labelFromGguf(gguf)
    const lines: string[] = []

    if (matches.length > 1) {
      lines.push(`Multiple matches, using: ${gguf}`)
    }

    lines.push(`Hot-swapping to ${gguf}...`)

    const result = await SentinelDocker.hotswapModel({
      projectDir: Instance.directory,
      ggufFilename: gguf,
      ctx: args.ctx,
    })

    if (result.success) {
      lines.push(`Model loaded successfully in ${Math.round(result.elapsed / 1000)}s`)
      lines.push(`Active model: ${result.model}`)
    } else {
      lines.push(`FAILED: Model did not become healthy after ${Math.round(result.elapsed / 1000)}s`)
    }

    return {
      title: result.success ? `Loaded: ${label}` : `Failed: ${label}`,
      metadata: {
        model: gguf,
        success: result.success,
        elapsed_ms: result.elapsed,
      },
      output: lines.join("\n"),
    }
  },
})

// ---------------------------------------------------------------------------
// Tool 4: sentinel_status — check stack status
// ---------------------------------------------------------------------------

export const SentinelStatusTool = Tool.define("sentinel_status", {
  description:
    "Check the health status of the Sentinel stack: orchestrator LLM (port 6969), " +
    "embedder (port 6973), and Graphiti memory (port 8000). " +
    "Shows which model is currently loaded on the orchestrator.",
  parameters: z.object({}),
  async execute() {
    interface ServiceCheck {
      name: string
      port: number
      healthPath: string
    }

    const services: ServiceCheck[] = [
      { name: "Orchestrator LLM", port: 6969, healthPath: "/health" },
      { name: "Embedder (bge-m3)", port: 6973, healthPath: "/health" },
      { name: "Graphiti Memory", port: 8000, healthPath: "/health" },
    ]

    const lines: string[] = ["Sentinel Stack Status", "=" .repeat(40), ""]

    // Check all services in parallel
    const checks = await Promise.allSettled(
      services.map(async (svc) => {
        try {
          const res = await fetch(`http://localhost:${svc.port}${svc.healthPath}`, {
            signal: AbortSignal.timeout(5000),
          })
          return { ...svc, healthy: res.ok, status: res.status }
        } catch {
          return { ...svc, healthy: false, status: 0 }
        }
      }),
    )

    for (const result of checks) {
      if (result.status === "fulfilled") {
        const { name, port, healthy } = result.value
        const icon = healthy ? "UP" : "DOWN"
        lines.push(`  ${name.padEnd(25)} :${port}  ${icon}`)
      }
    }

    // Get currently loaded model
    lines.push("")
    const loadedModel = await SentinelDocker.getLoadedModel(6969)
    if (loadedModel) {
      lines.push(`Current model: ${loadedModel}`)
    } else {
      lines.push("Current model: (none / unreachable)")
    }

    return {
      title: "Stack status",
      metadata: {},
      output: lines.join("\n"),
    }
  },
})

// ---------------------------------------------------------------------------
// Tool 5: sentinel_bench_compare — compare recent benchmark runs
// ---------------------------------------------------------------------------

export const SentinelBenchCompareTool = Tool.define("sentinel_bench_compare", {
  description:
    "Compare recent inference benchmark runs. Reads the last N result JSON files " +
    "and formats a comparison table showing TG/PP metrics with deltas between runs.",
  parameters: z.object({
    last: z.number().optional().describe("Number of recent runs to compare (default 3)"),
  }),
  async execute(args, _ctx) {
    const count = args.last ?? 3
    const resultsDir = path.join(Instance.directory, "benchmarks", "results", "inference")
    const files = recentJsonFiles(resultsDir, count)

    if (files.length === 0) {
      return {
        title: "No results",
        metadata: {},
        output: `No benchmark results found in ${resultsDir}.\nRun sentinel_bench_load first.`,
      }
    }

    if (files.length < 2) {
      const data = readJson(files[0])
      const summary = (data?.summary ?? {}) as Record<string, number>
      const label = (data?.label as string) ?? "unknown"
      return {
        title: `1 run: ${label}`,
        metadata: { count: 1 },
        output: [
          `Only 1 result available (need at least 2 to compare):`,
          `  Label: ${label}`,
          `  TG: ${summary.tg_mean?.toFixed(2)} tok/s mean, ${summary.tg_median?.toFixed(2)} median`,
          `  PP: ${summary.pp_mean?.toFixed(2)} tok/s mean, ${summary.pp_median?.toFixed(2)} median`,
        ].join("\n"),
      }
    }

    // Parse all results (newest first in files, but we display oldest-first)
    const runs = files
      .map((f) => readJson(f))
      .filter((d): d is Record<string, unknown> => d !== undefined)
      .reverse()

    if (runs.length < 2) {
      return {
        title: "Parse error",
        metadata: {},
        output: "Could not parse enough result files for comparison.",
      }
    }

    // Build comparison table
    const metrics: Array<{ display: string; key: string; unit: string }> = [
      { display: "TG Mean", key: "tg_mean", unit: "tok/s" },
      { display: "TG Median", key: "tg_median", unit: "tok/s" },
      { display: "TG Stdev", key: "tg_stdev", unit: "" },
      { display: "PP Mean", key: "pp_mean", unit: "tok/s" },
      { display: "PP Median", key: "pp_median", unit: "tok/s" },
      { display: "PP Stdev", key: "pp_stdev", unit: "" },
      { display: "Total Passes", key: "total_passes", unit: "" },
    ]

    // Column headers
    const labels = runs.map((r) => (r.label as string) ?? "?")
    const colWidth = Math.max(14, ...labels.map((l) => l.length + 2))

    const header =
      "Metric".padEnd(20) + labels.map((l) => l.padStart(colWidth)).join("") + (runs.length === 2 ? "  Delta" : "")
    const separator = "-".repeat(header.length)

    const rows = metrics.map((m) => {
      const values = runs.map((r) => {
        const summary = (r.summary ?? {}) as Record<string, number>
        return summary[m.key] ?? 0
      })

      let row = m.display.padEnd(20)
      for (const v of values) {
        const formatted = Number.isInteger(v) ? String(v) : v.toFixed(2)
        row += formatted.padStart(colWidth)
      }

      // Delta column for exactly 2 runs
      if (runs.length === 2 && values[0] > 0) {
        const delta = ((values[1] - values[0]) / values[0]) * 100
        const sign = delta >= 0 ? "+" : ""
        row += `  ${sign}${delta.toFixed(1)}%`
      }

      return row
    })

    const output = [
      `Benchmark Comparison (${runs.length} runs)`,
      "",
      header,
      separator,
      ...rows,
    ].join("\n")

    return {
      title: `Compare ${runs.length} runs`,
      metadata: { count: runs.length },
      output,
    }
  },
})
