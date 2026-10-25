/**
 * Provider-neutral model rows plus the two upstream catalog parsers.
 *
 * The settings page needs more than `LlmModelInfo` (vision, context, multiplier,
 * labels), so adapters keep this shape internally and project it down to the
 * harness on `listModels`/`resolveModel`.
 *
 * Capability rules are shared by both providers: match the normalized name
 * against OpenRouter first, fall back to the upstream declaration, and expose
 * every effort/modality when neither source says anything. No model is
 * special-cased.
 *
 * @module dsh-llm-adapters/catalog
 */

import { parseModelName } from './model-name.ts'
import type { OpenRouterIndex } from './openrouter.ts'

export { priceFactorOf } from './model-name.ts'

export interface ProviderModel {
  id: string
  name: string
  description?: string
  /** Non-price bracket contents from the upstream name (`限时免费`, …). */
  labels?: readonly string[]
  contextWindow: number
  maxTokens?: number
  vision: boolean
  reasoning: boolean
  reasoningEfforts?: readonly string[]
  defaultReasoningEffort?: string
  priceFactor?: number
  badge?: string
  tags?: readonly string[]
}

/** Every level the shared fallback exposes when no source knows the model. */
export const ALL_REASONING_EFFORTS: readonly string[] = [
  'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max',
]
export const ALL_INPUT_MODALITIES: readonly string[] = ['text', 'image']

/** Legacy two-state ids, kept so older saved selections still map on the wire. */
export const RACCOON_EFFORT_ON = 'on'
export const RACCOON_EFFORT_OFF = 'off'

export const DEFAULT_CONTEXT_WINDOW = 200_000

const NO_MODELS: readonly ProviderModel[] = []

/** Largest number found under one of `keys`, ignoring nested unrelated data. */
function numberField(record: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.floor(value)
    if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value)
  }
  return undefined
}

function stringField(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return undefined
}

function stringArray(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (!Array.isArray(value)) return []
  return value
    .map(entry => typeof entry === 'string' ? entry : undefined)
    .filter((entry): entry is string => entry !== undefined)
}

function recordOf(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

/**
 * Pick the lowest supported effort for a fast default. OpenRouter's own
 * default is often `max`, which would make every first reply slower; the full
 * list is still exposed so the user can opt into more reasoning.
 */
function preferredEffort(efforts: readonly string[]): string | undefined {
  for (const candidate of ['none', 'off', 'low', 'minimal', 'medium', 'high', 'xhigh', 'max', 'on']) {
    if (efforts.includes(candidate)) return candidate
  }
  return efforts[0]
}

function effortsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const entry of value) {
    if (typeof entry === 'string' && entry.trim().length > 0) out.push(entry.trim())
    else if (entry !== null && typeof entry === 'object') {
      const record = entry as Record<string, unknown>
      const id = stringField(record, ['value', 'id', 'name'])
      if (id !== undefined) out.push(id)
    }
  }
  return [...new Set(out)]
}

interface ResolvedCapabilities {
  efforts: readonly string[]
  defaultEffort?: string
  modalities: readonly string[]
}

/**
 * Resolve one model's efforts and modalities from the two allowed sources.
 *
 * 1. Live OpenRouter metadata wins when it carries the field.
 * 2. Otherwise the upstream declaration (`reasoning_efforts`, `input_modalities`,
 *    `vision`, tags) is used.
 * 3. When neither says anything, every effort and both modalities are exposed.
 */
function resolveCapabilities(input: {
  live?: { efforts?: readonly string[]; inputModalities?: readonly string[] }
  upstreamEfforts?: readonly string[]
  upstreamDefaultEffort?: string
  upstreamReasoning?: boolean
  upstreamModalities?: readonly string[]
}): ResolvedCapabilities {
  const liveEfforts = input.live?.efforts ?? []
  const upstreamEfforts = input.upstreamEfforts ?? []
  const fromOpenRouter = liveEfforts.length > 0
  const efforts = fromOpenRouter
    ? liveEfforts
    : upstreamEfforts.length > 0
      ? upstreamEfforts
      : input.upstreamReasoning === false
        ? []
        : ALL_REASONING_EFFORTS
  const defaultEffort = efforts.length === 0
    ? undefined
    : fromOpenRouter
      ? preferredEffort(efforts)
      : input.upstreamDefaultEffort !== undefined && efforts.includes(input.upstreamDefaultEffort)
        ? input.upstreamDefaultEffort
        : preferredEffort(efforts)

  const liveModalities = input.live?.inputModalities ?? []
  const upstreamModalities = input.upstreamModalities ?? []
  const modalities = liveModalities.length > 0
    ? liveModalities
    : upstreamModalities.length > 0
      ? upstreamModalities
      : ALL_INPUT_MODALITIES
  return {
    efforts,
    ...defaultEffort === undefined ? {} : { defaultEffort },
    modalities,
  }
}

function visionFrom(input: {
  modalities: readonly string[]
  textOnly: ReadonlySet<string>
  forceVision: ReadonlySet<string>
  id: string
}): boolean {
  if (input.textOnly.has(input.id)) return false
  if (input.forceVision.has(input.id)) return true
  return input.modalities.some(mode => mode.toLowerCase() === 'image')
}

function loomyUpstreamModalities(capabilities: Record<string, unknown>): readonly string[] | undefined {
  const declared = stringArray(capabilities.input_modalities ?? capabilities.inputModalities)
  if (declared.length > 0) return declared
  if (capabilities.vision === true) return ALL_INPUT_MODALITIES
  if (capabilities.vision === false) return ['text']
  return undefined
}

function raccoonUpstreamModalities(tags: readonly string[]): readonly string[] | undefined {
  // No tags at all means the upstream said nothing; an explicit tag list
  // without `vision` is an upstream text-only declaration.
  if (tags.length === 0) return undefined
  const lower = tags.map(tag => tag.toLowerCase())
  const sees = lower.some(tag => tag === 'vision' || tag === 'image' || tag === 'image-understanding' || tag === 'image_input')
  return sees ? ALL_INPUT_MODALITIES : ['text']
}

/**
 * Parse Loomy's `/models` response.
 *
 * The upstream returns an OpenAI-style list but varies whether the array sits
 * at `data`, `models`, or `data.models`; the multiplier and promo text are
 * embedded in the display name rather than in structured fields.
 */
export function parseLoomyCatalog(
  payload: unknown,
  options: {
    textOnly?: ReadonlySet<string>
    forceVision?: ReadonlySet<string>
    openRouter?: OpenRouterIndex
  } = {},
): ProviderModel[] {
  const root = recordOf(payload)
  const data = recordOf(root.data)
  const candidates = Array.isArray(payload)
    ? payload
    : Array.isArray(root.data)
      ? root.data
      : Array.isArray(root.models)
        ? root.models
        : Array.isArray(data.models)
          ? data.models
          : []
  const textOnly = options.textOnly ?? new Set<string>()
  const forceVision = options.forceVision ?? new Set<string>()
  const out: ProviderModel[] = []
  for (const candidate of candidates) {
    const record = recordOf(candidate)
    const id = stringField(record, ['id', 'model', 'modelId'])
    if (id === undefined) continue
    const rawName = stringField(record, ['display_name', 'displayName', 'name', 'label']) ?? id
    const parsed = parseModelName(rawName)
    const description = stringField(record, ['description', 'desc'])
    const capabilities = recordOf(record.capabilities)
    const tags = stringArray(record.tags)
    const live = options.openRouter?.match(parsed.name, id)
    const resolved = resolveCapabilities({
      live,
      upstreamEfforts: effortsOf(record.reasoning_efforts ?? record.reasoningEfforts),
      upstreamDefaultEffort: stringField(record, ['default_reasoning_effort', 'defaultReasoningEffort']),
      upstreamReasoning: typeof capabilities.reasoning === 'boolean' ? capabilities.reasoning : undefined,
      upstreamModalities: loomyUpstreamModalities(capabilities),
    })
    out.push({
      id,
      name: parsed.name || id,
      ...description === undefined ? {} : { description },
      ...parsed.labels.length === 0 ? {} : { labels: parsed.labels },
      contextWindow: numberField(record, ['context_length', 'context_window', 'contextWindow', 'max_context_length']) ?? DEFAULT_CONTEXT_WINDOW,
      ...numberField(record, ['max_output_tokens', 'max_tokens', 'maxTokens', 'max_output_length']) === undefined
        ? {}
        : { maxTokens: numberField(record, ['max_output_tokens', 'max_tokens', 'maxTokens', 'max_output_length'])! },
      vision: visionFrom({
        modalities: resolved.modalities,
        textOnly,
        forceVision,
        id,
      }),
      reasoning: resolved.efforts.length > 0,
      ...resolved.efforts.length === 0 ? {} : { reasoningEfforts: resolved.efforts },
      ...resolved.defaultEffort === undefined ? {} : { defaultReasoningEffort: resolved.defaultEffort },
      ...parsed.priceFactor === undefined ? {} : { priceFactor: parsed.priceFactor },
      ...tags.length === 0 ? {} : { tags },
    })
  }
  return out
}

function raccoonBadge(record: Record<string, unknown>): string | undefined {
  const status = stringField(record, ['billing_status'])
  const note = stringField(record, ['billing_status_note'])
  if (note !== undefined) return note
  if (status === 'limited_free') return '限免'
  if (status === 'discount') return '折扣'
  return undefined
}

/**
 * Parse Raccoon's `model_catalog` response.
 *
 * Only `categories[type=chat]` is relevant. The catalogue's `name` is both the
 * model id and the value the completion endpoint accepts; the human label comes
 * from `description` (the product name), while `display_description` is a
 * workload sentence shown as the description.
 */
export function parseRaccoonCatalog(
  payload: unknown,
  options: {
    textOnly?: ReadonlySet<string>
    forceVision?: ReadonlySet<string>
    /** Live OpenRouter index, matched by normalized name or id. */
    openRouter?: OpenRouterIndex
  } = {},
): ProviderModel[] {
  const root = recordOf(payload)
  const data = recordOf(root.data)
  const categories = Array.isArray(data.categories) ? data.categories : []
  const chat = categories
    .map(recordOf)
    .find(category => category.type === 'chat')
  const candidates = Array.isArray(chat?.models) ? chat.models : []
  const textOnly = options.textOnly ?? new Set<string>()
  const forceVision = options.forceVision ?? new Set<string>()
  const out: ProviderModel[] = []
  for (const candidate of candidates) {
    const record = recordOf(candidate)
    const id = stringField(record, ['name', 'id', 'model'])
    if (id === undefined || id === 'raccoon-work') continue
    if (record.visible === false) continue
    const params = recordOf(record.params)
    const tags = stringArray(record.tags)
    const rawName = stringField(record, ['description', 'display_name', 'model_name']) ?? id
    const parsed = parseModelName(rawName)
    const display = stringField(record, ['display_description', 'displayDescription'])
    const description = display === undefined || display === parsed.name ? undefined : display
    const live = options.openRouter?.match(parsed.name, id)
    const resolved = resolveCapabilities({
      live,
      upstreamEfforts: effortsOf(record.reasoning_efforts ?? record.reasoningEfforts),
      upstreamDefaultEffort: stringField(record, ['default_reasoning_effort', 'defaultReasoningEffort']),
      upstreamModalities: raccoonUpstreamModalities(tags),
    })
    const base = billingMultiplier(record)
    out.push({
      id,
      name: parsed.name || id,
      ...description === undefined ? {} : { description },
      ...parsed.labels.length === 0 ? {} : { labels: parsed.labels },
      contextWindow: numberField(params, ['context_window', 'contextWindow']) ?? DEFAULT_CONTEXT_WINDOW,
      ...numberField(params, ['max_tokens', 'maxTokens']) === undefined
        ? {}
        : { maxTokens: numberField(params, ['max_tokens', 'maxTokens'])! },
      vision: visionFrom({
        modalities: resolved.modalities,
        textOnly,
        forceVision,
        id,
      }),
      reasoning: resolved.efforts.length > 0,
      ...resolved.efforts.length === 0 ? {} : { reasoningEfforts: resolved.efforts },
      ...resolved.defaultEffort === undefined ? {} : { defaultReasoningEffort: resolved.defaultEffort },
      ...base === undefined ? {} : { priceFactor: base },
      ...raccoonBadge(record) === undefined ? {} : { badge: raccoonBadge(record)! },
      ...tags.length === 0 ? {} : { tags },
    })
  }
  return out
}

function billingMultiplier(record: Record<string, unknown>): number | undefined {
  const effective = record.billing_effective_multiplier
  if (typeof effective === 'number' && Number.isFinite(effective) && effective >= 0) return effective
  const base = record.billing_multiplier
  return typeof base === 'number' && Number.isFinite(base) && base >= 0 ? base : undefined
}

export interface CatalogSnapshot<T> {
  models: readonly T[]
  at: number
}

/**
 * A small stale-while-error cache.
 *
 * A failed refresh keeps the last successful list and reports the failure
 * separately, so a transient network error does not make every model vanish
 * from the picker. `fresh` always bypasses the TTL.
 */
export class ModelCatalog {
  private snapshot: CatalogSnapshot<ProviderModel> | undefined
  private lastError: string | undefined
  private inflight: Promise<readonly ProviderModel[]> | undefined

  constructor(
    private readonly load: () => Promise<ProviderModel[]>,
    private readonly ttlMs: () => number,
  ) {}

  async models(fresh = false): Promise<readonly ProviderModel[]> {
    if (!fresh && this.snapshot !== undefined && Date.now() - this.snapshot.at < this.ttlMs()) {
      return this.snapshot.models
    }
    if (this.inflight !== undefined) return this.inflight
    this.inflight = (async () => {
      try {
        const models = await this.load()
        this.snapshot = { models, at: Date.now() }
        this.lastError = undefined
        return models
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error)
        return this.snapshot?.models ?? NO_MODELS
      } finally {
        this.inflight = undefined
      }
    })()
    return this.inflight
  }

  error(): string | undefined {
    return this.lastError
  }

  invalidate(): void {
    this.snapshot = undefined
    this.lastError = undefined
    this.inflight = undefined
  }
}
