import { createSignal, createMemo, For, Show, type JSX } from "solid-js"
import "./bench-tab.css"

// ── Data types ──────────────────────────────────────────────

export interface BenchPass {
  pass_id: number
  prompt_category: string
  prompt_tokens: number
  predicted_tokens: number
  prompt_per_second: number
  predicted_per_second: number
  prompt_ms: number
  predicted_ms: number
}

export interface BenchSummary {
  tg_mean: number
  tg_median: number
  tg_stdev: number
  tg_min: number
  tg_max: number
  pp_mean: number
  pp_median: number
  pp_stdev: number
  pp_min: number
  pp_max: number
  total_passes: number
  thinking_passes: number
}

export interface BenchResult {
  run_id: string
  label: string
  docker_image: string
  model_file: string
  port: number
  thinking_mode: boolean
  server_props: {
    build_commit: string
    n_gpu_layers: number
    flash_attn: boolean
    ctx_size: number
    batch_size: number
    cache_type_k: string
    cache_type_v: string
  }
  passes: BenchPass[]
  summary: BenchSummary
  timestamp: string
}

export interface ModelInfo {
  name: string
  filename: string
  sizeBytes: number
  maxContext?: number
}

export type ModelHealth = "healthy" | "offline" | "loading"

export interface ModelCardData extends ModelInfo {
  health: ModelHealth
}

// ── Formatting helpers ──────────────────────────────────────

function formatNumber(value: number, decimals: number = 1): string {
  return value.toFixed(decimals)
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  const month = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  const hours = String(d.getHours()).padStart(2, "0")
  const minutes = String(d.getMinutes()).padStart(2, "0")
  return `${month}-${day} ${hours}:${minutes}`
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${formatNumber(kb, 0)} KB`
  const mb = kb / 1024
  if (mb < 1024) return `${formatNumber(mb, 1)} MB`
  const gb = mb / 1024
  return `${formatNumber(gb, 1)} GB`
}

function deltaPercent(current: number, baseline: number): number {
  if (baseline === 0) return 0
  return ((current - baseline) / baseline) * 100
}

type DeltaTrend = "positive" | "negative" | "neutral"

function deltaTrend(percent: number): DeltaTrend {
  if (percent > 1) return "positive"
  if (percent < -1) return "negative"
  return "neutral"
}

function formatDelta(percent: number): string {
  const sign = percent >= 0 ? "+" : ""
  return `${sign}${percent.toFixed(1)}%`
}

// ── BenchToolbar ────────────────────────────────────────────

interface BenchToolbarProps {
  selectedCount: number
  onRefresh?: () => void
  onClearSelection?: () => void
}

function BenchToolbar(props: BenchToolbarProps) {
  return (
    <div data-component="bench-toolbar">
      <span data-slot="title">Bench Results</span>
      <Show when={props.selectedCount > 0}>
        <button data-slot="action" onClick={() => props.onClearSelection?.()}>
          Clear ({props.selectedCount})
        </button>
      </Show>
      <button data-slot="action" onClick={() => props.onRefresh?.()}>
        Refresh
      </button>
    </div>
  )
}

// ── Delta badge ─────────────────────────────────────────────

function DeltaBadge(props: { current: number; baseline: number }) {
  const pct = createMemo(() => deltaPercent(props.current, props.baseline))
  const trend = createMemo(() => deltaTrend(pct()))

  return (
    <span data-slot="delta" data-trend={trend()}>
      {formatDelta(pct())}
    </span>
  )
}

// ── BenchResultsTable ───────────────────────────────────────

interface BenchResultsTableProps {
  results: BenchResult[]
  selected: Set<string>
  onToggle: (runId: string) => void
}

export function BenchResultsTable(props: BenchResultsTableProps) {
  const sorted = createMemo(() =>
    [...props.results].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()),
  )

  const baseline = createMemo(() => {
    const sel = props.selected
    if (sel.size < 2) return undefined
    const first = sorted().find((r) => sel.has(r.run_id))
    return first
  })

  return (
    <Show
      when={sorted().length > 0}
      fallback={
        <div data-slot="empty">
          <span>No benchmark results found.</span>
          <span>Run `sentinel bench run` to generate results.</span>
        </div>
      }
    >
      <div>
        <div data-slot="section-header">Results</div>
        <table data-component="bench-results-table">
          <thead>
            <tr>
              <th style={{ width: "2rem" }}></th>
              <th>Label</th>
              <th>Model</th>
              <th data-align="right">TG Mean</th>
              <th data-align="right">TG Med</th>
              <th data-align="right">PP Mean</th>
              <th data-align="right">PP Med</th>
              <th data-align="right">Passes</th>
              <th>Date</th>
              <Show when={baseline()}>
                <th data-align="right">TG Delta</th>
                <th data-align="right">PP Delta</th>
              </Show>
            </tr>
          </thead>
          <tbody>
            <For each={sorted()}>
              {(result) => {
                const isSelected = createMemo(() => props.selected.has(result.run_id))
                const isBaseline = createMemo(() => baseline()?.run_id === result.run_id)
                const modelLabel = createMemo(() => {
                  if (result.model_file && result.model_file !== "unknown") {
                    return result.model_file.replace(/\.gguf$/i, "")
                  }
                  return result.label
                })

                return (
                  <tr data-selected={isSelected()} onClick={() => props.onToggle(result.run_id)}>
                    <td>
                      <input
                        data-slot="checkbox"
                        type="checkbox"
                        checked={isSelected()}
                        onChange={() => props.onToggle(result.run_id)}
                        onClick={(e: MouseEvent) => e.stopPropagation()}
                      />
                    </td>
                    <td>{result.label}</td>
                    <td title={result.model_file}>{modelLabel()}</td>
                    <td data-align="right">{formatNumber(result.summary.tg_mean)}</td>
                    <td data-align="right">{formatNumber(result.summary.tg_median)}</td>
                    <td data-align="right">{formatNumber(result.summary.pp_mean)}</td>
                    <td data-align="right">{formatNumber(result.summary.pp_median)}</td>
                    <td data-align="right">{result.summary.total_passes}</td>
                    <td>{formatDate(result.timestamp)}</td>
                    <Show when={baseline()}>
                      {(base) => (
                        <>
                          <td data-align="right">
                            <Show when={!isBaseline()} fallback={<span style={{ color: "var(--text-weak)" }}>base</span>}>
                              <DeltaBadge current={result.summary.tg_mean} baseline={base().summary.tg_mean} />
                            </Show>
                          </td>
                          <td data-align="right">
                            <Show when={!isBaseline()} fallback={<span style={{ color: "var(--text-weak)" }}>base</span>}>
                              <DeltaBadge current={result.summary.pp_mean} baseline={base().summary.pp_mean} />
                            </Show>
                          </td>
                        </>
                      )}
                    </Show>
                  </tr>
                )
              }}
            </For>
          </tbody>
        </table>
      </div>
    </Show>
  )
}

// ── BarChart ────────────────────────────────────────────────

interface BarChartItem {
  label: string
  value: number
}

interface BarChartProps {
  title: string
  data: BarChartItem[]
  unit: string
  color: string
}

function BarChart(props: BarChartProps) {
  const max = createMemo(() => {
    const values = props.data.map((d) => d.value)
    return values.length > 0 ? Math.max(...values) : 1
  })

  return (
    <div data-component="bench-bar-chart">
      <div data-slot="chart-title">{props.title}</div>
      <For each={props.data}>
        {(item) => (
          <div data-slot="bar-row">
            <span data-slot="bar-label" title={item.label}>
              {item.label}
            </span>
            <div data-slot="bar-track">
              <div
                data-slot="bar-fill"
                style={{
                  width: `${max() > 0 ? (item.value / max()) * 100 : 0}%`,
                  background: props.color,
                }}
              />
            </div>
            <span data-slot="bar-value">
              {formatNumber(item.value)} {props.unit}
            </span>
          </div>
        )}
      </For>
    </div>
  )
}

// ── BenchCharts ─────────────────────────────────────────────

interface BenchChartsProps {
  results: BenchResult[]
}

export function BenchCharts(props: BenchChartsProps) {
  const tgData = createMemo((): BarChartItem[] =>
    props.results.map((r) => ({
      label: r.label || r.run_id,
      value: r.summary.tg_mean,
    })),
  )

  const ppData = createMemo((): BarChartItem[] =>
    props.results.map((r) => ({
      label: r.label || r.run_id,
      value: r.summary.pp_mean,
    })),
  )

  return (
    <Show when={props.results.length > 0}>
      <div data-component="bench-charts">
        <BarChart title="Token Generation (TG) — tok/s" data={tgData()} unit="tok/s" color="var(--surface-success-strong)" />
        <BarChart title="Prompt Processing (PP) — tok/s" data={ppData()} unit="tok/s" color="var(--text-interactive-base)" />
      </div>
    </Show>
  )
}

// ── ModelCards ───────────────────────────────────────────────

interface ModelCardsProps {
  models: ModelCardData[]
  onSwap?: (model: ModelCardData) => void
}

export function ModelCards(props: ModelCardsProps) {
  return (
    <Show when={props.models.length > 0}>
      <div>
        <div data-slot="section-header">Models</div>
        <div data-component="model-cards">
          <For each={props.models}>
            {(model) => (
              <div
                data-component="model-card"
                data-active={model.health === "healthy"}
                onClick={() => props.onSwap?.(model)}
                title={`Click to hotswap ${model.name}`}
              >
                <div data-slot="model-name">{model.name}</div>
                <div data-slot="model-meta">
                  <span data-slot="health-dot" data-status={model.health} />
                  <span>{formatFileSize(model.sizeBytes)}</span>
                  <Show when={model.maxContext}>
                    {(ctx) => <span>{(ctx() / 1024).toFixed(0)}K ctx</span>}
                  </Show>
                </div>
              </div>
            )}
          </For>
        </div>
      </div>
    </Show>
  )
}

// ── BenchTab (main) ─────────────────────────────────────────

export interface BenchTabProps {
  results?: BenchResult[]
  models?: ModelCardData[]
  onRefresh?: () => void
  onSwapModel?: (model: ModelCardData) => void
}

export function BenchTab(props: BenchTabProps): JSX.Element {
  const [selected, setSelected] = createSignal<Set<string>>(new Set())

  const results = createMemo(() => props.results ?? [])
  const models = createMemo(() => props.models ?? [])

  const toggleSelection = (runId: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(runId)) {
        next.delete(runId)
      } else {
        next.add(runId)
      }
      return next
    })
  }

  const clearSelection = () => {
    setSelected(new Set())
  }

  const selectedResults = createMemo(() => {
    const sel = selected()
    return results().filter((r) => sel.has(r.run_id))
  })

  return (
    <div data-component="bench-tab">
      <BenchToolbar selectedCount={selected().size} onRefresh={props.onRefresh} onClearSelection={clearSelection} />

      <BenchResultsTable results={results()} selected={selected()} onToggle={toggleSelection} />

      <BenchCharts results={selectedResults()} />

      <ModelCards models={models()} onSwap={props.onSwapModel} />
    </div>
  )
}
