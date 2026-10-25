/**
 * Live capability lookup from OpenRouter's public model catalog.
 *
 * Raccoon's own catalog does not expose reasoning-effort levels, and its vision
 * tags have been wrong in both directions. OpenRouter publishes
 * `reasoning.supported_efforts` and `architecture.input_modalities` for the
 * models it carries, so this module fetches that catalog on demand and matches
 * entries to upstream ids by normalized names.
 *
 * The data is fetched at runtime and refreshed whenever the settings page asks
 * for fresh models; nothing about a particular model version is baked in.
 *
 * @module dsh-llm-adapters/openrouter
 */

const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models'
const REQUEST_TIMEOUT_MS = 8_000
const CACHE_TTL_MS = 5 * 60 * 1_000

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
  match(upstreamId: string, upstreamName?: string): OpenRouterModel | undefined
}

export interface OpenRouterLookup {
  models(fresh?: boolean): Promise<OpenRouterIndex>
  invalidate(): void
}

export const EMPTY_OPENROUTER_INDEX: OpenRouterIndex = {
  models: [],
  match: () => undefined,
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

/** Normalize a model name into a comparison key (`GLM-5.3` === `glm 5 3`). */
export function modelKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/^sn-/, '')
    .replace(/[^a-z0-9]/g, '')
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

export function buildOpenRouterIndex(models: readonly OpenRouterModel[]): OpenRouterIndex {
  const byId = new Map<string, OpenRouterModel>()
  const byName = new Map<string, OpenRouterModel | null>()
  for (const model of models) {
    const idKey = openRouterIdKey(model.id)
    if (idKey.length > 0) {
      const existing = byId.get(idKey)
      if (existing === undefined || variantScore(model) < variantScore(existing)) {
        byId.set(idKey, model)
      }
    }
    const nameKey = openRouterNameKey(model.name)
    if (nameKey.length === 0) continue
    const existing = byName.get(nameKey)
    if (existing === undefined) byName.set(nameKey, model)
    else if (existing !== model) byName.set(nameKey, null)
  }
  return {
    models,
    match(upstreamId, upstreamName) {
      const direct = byId.get(modelKey(upstreamId))
      if (direct !== undefined) return direct
      if (upstreamName === undefined) return undefined
      return byName.get(openRouterNameKey(upstreamName)) ?? undefined
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

/**
 * A stale-while-error cache over OpenRouter. A failed refresh keeps the last
 * successful snapshot so a transient outage does not remove every control;
 * `fresh` bypasses the TTL, and `invalidate()` forces the next read to refetch.
 */
export class OpenRouterCatalog implements OpenRouterLookup {
  private snapshot: { index: OpenRouterIndex, at: number } | undefined
  private inflight: Promise<OpenRouterIndex> | undefined

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly ttlMs: number | (() => number) = CACHE_TTL_MS,
  ) {}

  async models(fresh = false): Promise<OpenRouterIndex> {
    const ttl = typeof this.ttlMs === 'function' ? this.ttlMs() : this.ttlMs
    if (!fresh && this.snapshot !== undefined && Date.now() - this.snapshot.at < ttl) {
      return this.snapshot.index
    }
    if (this.inflight !== undefined) return this.inflight
    this.inflight = (async () => {
      try {
        const response = await this.fetchImpl(OPENROUTER_MODELS_URL, {
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        })
        if (!response.ok) throw new Error(`OpenRouter HTTP ${response.status}`)
        const index = buildOpenRouterIndex(parseOpenRouterModels(await response.json()))
        this.snapshot = { index, at: Date.now() }
        return index
      } catch {
        return this.snapshot?.index ?? EMPTY_OPENROUTER_INDEX
      } finally {
        this.inflight = undefined
      }
    })()
    return this.inflight
  }

  invalidate(): void {
    this.snapshot = undefined
  }
}
