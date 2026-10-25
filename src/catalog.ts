/**
 * Provider-neutral model rows plus the two upstream catalog parsers.
 *
 * The settings page needs more than `LlmModelInfo` (vision, context, multiplier,
 * badges), so adapters keep this shape internally and project it down to the
 * harness on `listModels`/`resolveModel`.
 *
 * @module dsh-llm-adapters/catalog
 */

import type { OpenRouterIndex } from './openrouter.ts'

export interface ProviderModel {
  id: string
  name: string
  description?: string
  contextWindow: number
  maxTokens?: number
  vision: boolean
  reasoning: boolean
  reasoningEfforts?: readonly string[]
  reasoningEffortNames?: Readonly<Record<string, string>>
  defaultReasoningEffort?: string
  priceFactor?: number
  badge?: string
  tags?: readonly string[]
}

/** Display names for every effort id either provider can return. */
export const REASONING_EFFORT_NAMES: Readonly<Record<string, string>> = {
  none: '关闭思考',
  minimal: '最小',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
  max: '最大',
  on: '开启思考',
  off: '关闭思考',
}

/**
 * The two-state switch used where the provider exposes no effort list. Raccoon's
 * `extra_body.thinking` works for every model, so an unmatched model still gets
 * on/off control; OpenRouter only ever *upgrades* this to real levels.
 */
export const RACCOON_EFFORT_ON = 'on'
export const RACCOON_EFFORT_OFF = 'off'
export const RACCOON_SWITCH_EFFORTS: readonly string[] = [RACCOON_EFFORT_ON, RACCOON_EFFORT_OFF]
export const RACCOON_SWITCH_DEFAULT = RACCOON_EFFORT_OFF

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

/** `x3.0`, `× 0.1`, `3倍` — only a multiplier next to the catalogue name. */
export function priceFactorOf(text: string): number | undefined {
  const match = /(?:[x×]\s*([0-9]+(?:\.[0-9]+)?)|([0-9]+(?:\.[0-9]+)?)\s*倍)/i.exec(text)
  if (match === null) return undefined
  const value = Number(match[1] ?? match[2])
  return Number.isFinite(value) ? value : undefined
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

function visionFrom(input: {
  capabilities: Record<string, unknown>
  tags: readonly string[]
  /** Authoritative modality list from the provider or OpenRouter. */
  modalities?: readonly string[]
  textOnly: ReadonlySet<string>
  forceVision: ReadonlySet<string>
  fallback: boolean
  id: string
}): boolean {
  if (input.textOnly.has(input.id)) return false
  if (input.forceVision.has(input.id)) return true
  if (input.modalities !== undefined) {
    return input.modalities.some(mode => mode.toLowerCase() === 'image')
  }
  if (input.capabilities.vision === true) return true
  const tags = input.tags.map(tag => tag.toLowerCase())
  if (tags.some(tag => tag === 'vision' || tag === 'image' || tag === 'image-understanding' || tag === 'image_input')) return true
  return input.fallback
}

/**
 * Parse Loomy's `/models` response.
 *
 * The upstream returns an OpenAI-style list but varies whether the array sits
 * at `data`, `models`, or `data.models`; the multiplier is embedded in the
 * display name rather than a structured field.
 */
export function parseLoomyCatalog(
  payload: unknown,
  options: { textOnly?: ReadonlySet<string>, forceVision?: ReadonlySet<string> } = {},
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
    const display = stringField(record, ['display_name', 'displayName', 'name', 'label']) ?? id
    const description = stringField(record, ['description', 'desc'])
    const capabilities = recordOf(record.capabilities)
    const tags = stringArray(record.tags)
    const modalities = stringArray(capabilities.input_modalities ?? capabilities.inputModalities)
    const priceFactor = priceFactorOf(`${display} ${description ?? ''}`)
    const efforts = effortsOf(record.reasoning_efforts ?? record.reasoningEfforts)
    const defaultEffort = stringField(record, ['default_reasoning_effort', 'defaultReasoningEffort'])
    out.push({
      id,
      name: display,
      ...description === undefined ? {} : { description },
      contextWindow: numberField(record, ['context_length', 'context_window', 'contextWindow', 'max_context_length']) ?? DEFAULT_CONTEXT_WINDOW,
      ...numberField(record, ['max_output_tokens', 'max_tokens', 'maxTokens', 'max_output_length']) === undefined
        ? {}
        : { maxTokens: numberField(record, ['max_output_tokens', 'max_tokens', 'maxTokens', 'max_output_length'])! },
      vision: visionFrom({
        capabilities,
        tags,
        ...modalities.length === 0 ? {} : { modalities },
        textOnly,
        forceVision,
        fallback: false,
        id,
      }),
      reasoning: capabilities.reasoning === true || efforts.length > 0,
      ...efforts.length === 0
        ? {}
        : {
            reasoningEfforts: efforts,
            reasoningEffortNames: REASONING_EFFORT_NAMES,
            ...defaultEffort !== undefined && efforts.includes(defaultEffort)
              ? { defaultReasoningEffort: defaultEffort }
              : {},
          },
      ...priceFactor === undefined ? {} : { priceFactor },
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
 * from `display_description` when present.
 */
export function parseRaccoonCatalog(
  payload: unknown,
  options: {
    textOnly?: ReadonlySet<string>
    forceVision?: ReadonlySet<string>
    /** Live OpenRouter index, matched by upstream id or product name. */
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
    // `description` is the product name ("Kimi-K3"); `display_description` is a
    // sentence about the workload. Selectors must show the former.
    const name = stringField(record, ['description', 'display_name', 'model_name']) ?? id
    const display = stringField(record, ['display_description', 'displayDescription'])
    const description = display === undefined || display === name ? undefined : display
    const live = options.openRouter?.match(id, name)
    // OpenRouter upgrades the always-available on/off switch to real levels when
    // it carries the model; otherwise the switch stays.
    const efforts = live?.efforts ?? RACCOON_SWITCH_EFFORTS
    const defaultEffort = preferredEffort(efforts)
    const base = billingMultiplier(record)
    out.push({
      id,
      name,
      ...description === undefined ? {} : { description },
      contextWindow: numberField(params, ['context_window', 'contextWindow']) ?? DEFAULT_CONTEXT_WINDOW,
      ...numberField(params, ['max_tokens', 'maxTokens']) === undefined
        ? {}
        : { maxTokens: numberField(params, ['max_tokens', 'maxTokens'])! },
      vision: visionFrom({
        capabilities: {},
        tags,
        ...live === undefined ? {} : { modalities: live.inputModalities },
        textOnly,
        forceVision,
        fallback: false,
        id,
      }),
      reasoning: true,
      reasoningEfforts: efforts,
      reasoningEffortNames: REASONING_EFFORT_NAMES,
      defaultReasoningEffort: defaultEffort,
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
