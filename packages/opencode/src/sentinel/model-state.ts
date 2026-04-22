import { Log } from "@/util/log"
import { SentinelDocker } from "./docker"

/**
 * Shared model swap state — tracks which model is loaded in the LLM
 * container and manages preloading when the user switches models.
 *
 * Used by both the TUI (to trigger preloads on model select) and the
 * LLM stream layer (to skip redundant swaps).
 */
export namespace ModelState {
  const log = Log.create({ service: "model-state" })
  const PORT = 6969

  export type Status = "idle" | "detecting" | "swapping" | "ready" | "error"

  let _status: Status = "idle"
  let _currentModel: string | undefined
  let _targetModel: string | undefined
  let _swapGeneration = 0
  let _detectedOnce = false
  let _activeSwap: Promise<boolean> | undefined
  const _listeners = new Set<() => void>()

  /** Strip path prefixes so "/models/Foo.gguf" and "Foo.gguf" compare equal. */
  export function normalize(id: string): string {
    const slash = id.lastIndexOf("/")
    return slash >= 0 ? id.slice(slash + 1) : id
  }

  export function status(): Status {
    return _status
  }
  export function currentModel(): string | undefined {
    return _currentModel
  }
  export function targetModel(): string | undefined {
    return _targetModel
  }

  /** Subscribe to state changes. Returns unsubscribe function. */
  export function subscribe(fn: () => void): () => void {
    _listeners.add(fn)
    return () => _listeners.delete(fn)
  }

  function notify() {
    for (const fn of _listeners) fn()
  }

  function setState(s: Status, target?: string) {
    _status = s
    _targetModel = target
    notify()
  }

  /** Detect what model is currently loaded. Called once on first use. */
  export async function detect(): Promise<string | undefined> {
    if (_detectedOnce) return _currentModel
    _detectedOnce = true
    setState("detecting")
    const running = await SentinelDocker.getLoadedModel(PORT)
    if (running) {
      _currentModel = normalize(running)
      log.info("detected running model", { model: _currentModel })
    }
    setState("idle")
    return _currentModel
  }

  /**
   * Ensure a model is loaded. If it's already loaded, returns immediately.
   * If a swap is already in progress for this model, returns the existing promise.
   * Otherwise starts a new swap.
   *
   * @param modelID - The model to load (GGUF filename or model ID)
   * @param projectDir - Project root for finding models/ directory
   * @returns true if the model is now loaded
   */
  export async function ensure(modelID: string, projectDir: string): Promise<boolean> {
    await detect()

    const normalized = normalize(modelID)

    // Already loaded
    if (_currentModel === normalized) return true

    // Not a local GGUF — just track it
    if (!normalized.endsWith(".gguf")) {
      _currentModel = normalized
      notify()
      return true
    }

    // Check file exists
    const fs = await import("fs")
    if (!fs.existsSync(`${projectDir}/models/${normalized}`)) {
      _currentModel = normalized
      notify()
      return true
    }

    // If a swap to the same model is already in progress, wait for it
    if (_activeSwap && _targetModel === normalized) {
      return _activeSwap
    }

    // Start new swap
    const generation = ++_swapGeneration
    log.info("model swap starting", { from: _currentModel, to: normalized })
    setState("swapping", normalized)

    const swapPromise = SentinelDocker.hotswapModel({
      projectDir,
      ggufFilename: normalized,
    }).then((result) => {
      // Superseded by a newer swap request
      if (generation !== _swapGeneration) return false

      if (result.success) {
        _currentModel = normalize(result.model)
        log.info("model swap complete", {
          model: _currentModel,
          elapsed: `${Math.round(result.elapsed / 1000)}s`,
        })
        setState("ready")
      } else {
        log.error("model swap failed", {
          model: normalized,
          elapsed: `${Math.round(result.elapsed / 1000)}s`,
        })
        setState("error")
      }
      _activeSwap = undefined
      return result.success
    })

    _activeSwap = swapPromise
    return swapPromise
  }
}
