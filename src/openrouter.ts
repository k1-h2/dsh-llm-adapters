/**
 * Live capability lookup from OpenRouter's public model catalog.
 *
 * Raccoon's own catalog does not expose reasoning-effort levels, and both
 * providers carry names the model vendor spells differently (`GLM-5-3` vs
 * `GLM 5.3`). OpenRouter publishes `reasoning.supported_efforts` and
 * `architecture.input_modalities`, so this module fetches that catalog on
 * demand and matches entries by normalized name.
 *
 * The data is fetched at runtime, refreshed by the plugin's scheduler, and kept
 * on disk, so a temporary outage keeps the last successful snapshot instead of
 * silently dropping every capability control.
 *
 * @module dsh-llm-adapters/openrouter
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { modelKey } from './model-name.ts'

const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models'
const REQUEST_TIMEOUT_MS = 20_000
const CACHE_VERSION = 1

export interface OpenRouterModel {
  id: string
  name: string
  inputModalities: readonly string[]
  /** Supported effort ids in OpenRouter's preferred display order. */
  efforts?: readonly string[]
  defaultEffort?: string
  /** The model rejects `none` and must always reason. */
  mandatory: boolean
}

export interface OpenRouterIndex {
  readonly models: readonly OpenRouterModel[]
  /**
   * Match one upstream model. `name` is the normalized product name; `id` is
   * the upstream id. Exact keys win, then a wildcard containment check.
   */
  match(name: string, id?: string): OpenRouterModel | undefined
}

export interface OpenRouterLookup {
  models(fresh?: boolean): Promise<OpenRouterIndex>
  invalidate(): void
}

/** What the settings page may read without triggering a network request. */
export interface OpenRouterStatus {
  models: number
  at?: number
  error?: string
  syncing: boolean
}

/** One explicit sync attempt; `ok` is false only when new data was not stored. */
export interface OpenRouterSyncResult extends OpenRouterStatus {
  ok: boolean
}

export const EMPTY_OPENROUTER_INDEX: OpenRouterIndex = {
  models: [],
  match: () => undefined,
}

interface CacheDocument {
  version: 1
  at: number
  models: readonly OpenRouterModel[]
}

function recordOf(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function stringsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map(entry => typeof entry === 'string' ? entry.trim() : '')
    .filter(entry => entry.length > 0)
}

function textOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

/** OpenRouter ids carry a vendor prefix; upstream Raccoon ids often carry `sn-`. */
function openRouterIdKey(id: string): string {
  const withoutTilde = id.startsWith('~') ? id.slice(1) : id
  const slash = withoutTilde.lastIndexOf('/')
  return modelKey(slash >= 0 ? withoutTilde.slice(slash + 1) : withoutTilde)
}

/** OpenRouter display names look like `MoonshotAI: Kimi K3`; the tail is the model. */
function openRouterNameKey(name: string): string {
  const colon = name.indexOf(':')
  return modelKey(colon >= 0 ? name.slice(colon + 1) : name)
}

/** Prefer canonical entries over batch and `~latest` aliases when keys collide. */
function variantScore(model: OpenRouterModel): number {
  return (model.id.startsWith('~') ? 10 : 0) + (model.id.includes(':batch') ? 5 : 0)
}

/**
 * Containment score for a normalized upstream name against a normalized
 * OpenRouter name. A shorter needle inside a longer candidate is the common
 * case (upstream drops a version suffix); the reverse is allowed at a lower
 * score so a vendor suffix does not defeat the match.
 */
function wildcardScore(needle: string, candidate: string): number {
  // Five characters keep generic names like `auto` from matching a router.
  if (needle.length < 5 || candidate.length < 5) return 0
  if (candidate === needle) return 100
  if (candidate.startsWith(needle)) return 80
  if (candidate.endsWith(needle)) return 70
  if (candidate.includes(needle)) return 60
  if (needle.includes(candidate)) return 50
  return 0
}

interface IndexedModel {
  model: OpenRouterModel
  keys: readonly string[]
  variant: number
}

export function buildOpenRouterIndex(models: readonly OpenRouterModel[]): OpenRouterIndex {
  const byName = new Map<string, OpenRouterModel | null>()
  const byId = new Map<string, OpenRouterModel | null>()
  const indexed: IndexedModel[] = []
  for (const model of models) {
    const nameKey = openRouterNameKey(model.name)
    const idKey = openRouterIdKey(model.id)
    const keys = [...new Set([nameKey, idKey].filter(key => key.length > 0))]
    indexed.push({ model, keys, variant: variantScore(model) })
    for (const [map, key] of [[byName, nameKey], [byId, idKey]] as const) {
      if (key.length === 0) continue
      const existing = map.get(key)
      if (existing === undefined) map.set(key, model)
      else if (existing === null) continue
      else if (existing !== model) {
        const currentVariant = variantScore(model)
        const existingVariant = variantScore(existing)
        if (currentVariant < existingVariant) map.set(key, model)
        else if (currentVariant > existingVariant) continue
        else map.set(key, null)
      }
    }
  }

  const wildcard = (needle: string): OpenRouterModel | undefined => {
    if (needle.length < 5) return undefined
    let best: { model: OpenRouterModel, score: number, variant: number } | undefined
    let ambiguous = false
    for (const entry of indexed) {
      let score = 0
      for (const key of entry.keys) score = Math.max(score, wildcardScore(needle, key))
      if (score === 0) continue
      if (best === undefined || score > best.score || (score === best.score && entry.variant < best.variant)) {
        best = { model: entry.model, score, variant: entry.variant }
        ambiguous = false
      } else if (score === best.score && entry.variant === best.variant && entry.model.id !== best.model.id) {
        ambiguous = true
      }
    }
    return ambiguous ? undefined : best?.model
  }

  return {
    models,
    match(name, id) {
      const nameKey = modelKey(name)
      const idKey = id === undefined ? '' : modelKey(id)
      const exactName = nameKey.length === 0 ? undefined : byName.get(nameKey)
      if (exactName !== undefined) return exactName ?? undefined
      const exactId = idKey.length === 0 ? undefined : byId.get(idKey)
      if (exactId !== undefined) return exactId ?? undefined
      return wildcard(nameKey) ?? wildcard(idKey)
    },
  }
}

/** Parse the subset of `GET /api/v1/models` this plugin uses. */
export function parseOpenRouterModels(payload: unknown): OpenRouterModel[] {
  const root = recordOf(payload)
  const data = Array.isArray(root.data) ? root.data : []
  const out: OpenRouterModel[] = []
  for (const candidate of data) {
    const record = recordOf(candidate)
    const id = textOf(record.id)
    if (id === undefined) continue
    const name = textOf(record.name) ?? id
    const architecture = recordOf(record.architecture)
    const reasoning = recordOf(record.reasoning)
    const mandatory = reasoning.mandatory === true
    const declared = stringsOf(reasoning.supported_efforts)
    const efforts = mandatory ? declared.filter(effort => effort !== 'none') : declared
    out.push({
      id,
      name,
      inputModalities: stringsOf(architecture.input_modalities).map(mode => mode.toLowerCase()),
      ...efforts.length === 0 ? {} : { efforts },
      ...textOf(reasoning.default_effort) === undefined ? {} : { defaultEffort: textOf(reasoning.default_effort)! },
      mandatory,
    })
  }
  return out
}

/** Validate one model read back from the on-disk cache. */
function storedModel(value: unknown): OpenRouterModel | undefined {
  const record = recordOf(value)
  const id = textOf(record.id)
  const name = textOf(record.name)
  if (id === undefined || name === undefined) return undefined
  return {
    id,
    name,
    inputModalities: stringsOf(record.inputModalities),
    ...Array.isArray(record.efforts) ? { efforts: stringsOf(record.efforts) } : {},
    ...textOf(record.defaultEffort) === undefined ? {} : { defaultEffort: textOf(record.defaultEffort)! },
    mandatory: record.mandatory === true,
  }
}

/**
 * A persistent, atomically-replaced OpenRouter snapshot.
 *
 * `models()` never triggers a network request once a snapshot exists: refreshes
 * are driven by {@link sync}, which the plugin calls on a schedule and the
 * settings page can trigger. A failed sync leaves both the in-memory and the
 * on-disk copy untouched, so an offline start still has the last known levels
 * and modalities.
 */
export class OpenRouterCatalog implements OpenRouterLookup {
  private snapshot: { index: OpenRouterIndex, at: number } | undefined
  private inflight: Promise<OpenRouterSyncResult> | undefined
  private lastError: string | undefined

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly options: { cacheFile?: string } = {},
  ) {
    this.loadFromDisk()
  }

  private loadFromDisk(): void {
    const file = this.options.cacheFile
    if (file === undefined) return
    try {
      const document = recordOf(JSON.parse(readFileSync(file, 'utf8')) as unknown)
      if (document.version !== CACHE_VERSION || !Array.isArray(document.models) || typeof document.at !== 'number') return
      const models = document.models
        .map(storedModel)
        .filter((model): model is OpenRouterModel => model !== undefined)
      if (models.length === 0) return
      this.snapshot = { index: buildOpenRouterIndex(models), at: document.at }
    } catch {
      // A missing or unreadable cache is the normal first-run state.
    }
  }

  /** Replace the cache file only after the new document is complete (tmp + rename). */
  private persist(models: readonly OpenRouterModel[], at: number): void {
    const file = this.options.cacheFile
    if (file === undefined) return
    try {
      mkdirSync(dirname(file), { recursive: true })
      const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
      writeFileSync(temporary, JSON.stringify({
        version: CACHE_VERSION,
        at,
        models,
      } satisfies CacheDocument), { encoding: 'utf8', mode: 0o600 })
      renameSync(temporary, file)
    } catch {
      // The in-memory snapshot is still valid; the next sync retries the file.
    }
  }

  private async fetchAndReplace(): Promise<OpenRouterSyncResult> {
    try {
      const response = await this.fetchImpl(OPENROUTER_MODELS_URL, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      if (!response.ok) throw new Error(`OpenRouter HTTP ${response.status}`)
      const models = parseOpenRouterModels(await response.json())
      if (models.length === 0) throw new Error('OpenRouter 没有返回任何模型')
      const index = buildOpenRouterIndex(models)
      const at = Date.now()
      // Publish only after the whole document parsed: readers see either the
      // previous snapshot or the new one, never a half-built index.
      this.snapshot = { index, at }
      this.lastError = undefined
      this.persist(models, at)
      return { ok: true, models: models.length, at, syncing: false }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.lastError = message
      return {
        ok: false,
        models: this.snapshot?.index.models.length ?? 0,
        ...this.snapshot === undefined ? {} : { at: this.snapshot.at },
        error: message,
        syncing: false,
      }
    }
  }

  /**
   * Fetch and replace the snapshot. Concurrent callers share one request, and
   * a failure keeps the previous snapshot and reports why.
   */
  sync(): Promise<OpenRouterSyncResult> {
    if (this.inflight !== undefined) return this.inflight
    this.inflight = this.fetchAndReplace().finally(() => { this.inflight = undefined })
    return this.inflight
  }

  async models(fresh = false): Promise<OpenRouterIndex> {
    if (fresh || this.snapshot === undefined) await this.sync()
    return this.snapshot?.index ?? EMPTY_OPENROUTER_INDEX
  }

  /** A read-only reading for the settings card; never starts a request. */
  status(): OpenRouterStatus {
    return {
      models: this.snapshot?.index.models.length ?? 0,
      ...this.snapshot === undefined ? {} : { at: this.snapshot.at },
      ...this.lastError === undefined ? {} : { error: this.lastError },
      syncing: this.inflight !== undefined,
    }
  }

  /** Drop the in-memory copy; the next read refetches (the file stays). */
  invalidate(): void {
    this.snapshot = undefined
    this.lastError = undefined
  }
}
