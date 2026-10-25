/**
 * Trae provider: model directory, SOLO chat, quota and daily check-in.
 *
 * Trae's website login yields the same `Cloud-IDE-JWT` its own clients use, so
 * the plugin talks to the same gateways they do. Two catalog sources are merged:
 *
 *  - the Remote directory (`/api/remote/v1/models`) is the model skeleton —
 *    display name, context window, multiplier, reasoning options, multimodal;
 *  - `get_detail_param` supplies the `config_name` the chat endpoint accepts and
 *    the output cap. A directory row with no callable config is NOT offered:
 *    Trae lists some client-only models (Qwen3.8-Flash, Kimi-K2.8-Preview) that
 *    the SOLO chat endpoint rejects with `4001`, and an entry that can only
 *    fail is worse than an absent one.
 *
 * Capabilities come from OpenRouter first, then from Trae's own directory, the
 * same order the other providers use. Effort names are normalized once
 * (`light` → `low`, `extra_high` → `xhigh`), and the default is the shared
 * second-strongest rule.
 *
 * @module dsh-llm-adapters/trae
 */

import { randomUUID } from 'node:crypto'
import type { GenerateOptions, StreamChunk, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { AccountStore } from './account-store.ts'
import { TraeAuth } from './auth.ts'
import type { TraeRegion } from './brand.ts'
import { ALL_REASONING_EFFORTS, DEFAULT_CONTEXT_WINDOW, ModelCatalog, defaultEffortOf } from './catalog.ts'
import type { ProviderModel } from './catalog.ts'
import { responseError } from './http.ts'
import type { LoginStatus } from './login-page.ts'
import { parseModelName } from './model-name.ts'
import { OpenRouterCatalog } from './openrouter.ts'
import type { OpenRouterIndex, OpenRouterLookup } from './openrouter.ts'
import type { TraeRegionProfile } from './trae-endpoints.ts'
import {
  TRAE_APP_ID, TRAE_REGION_PROFILES, TRAE_SOLO_CHAT_PATH, TRAE_SOLO_MODELS_PATH, TRAE_VERSION_CODE,
  TRAE_WEB_USER_AGENT,
} from './trae-endpoints.ts'
import { TraeWebLogin } from './trae-login.ts'
import type { TraeLoginAccount } from './trae-login.ts'
import type { CheckinStatus, QuotaPack, QuotaSnapshot } from './types.ts'
import { ProviderHttpError, buildMessages } from './wire.ts'
import type { ReadImage, WireMessage } from './wire.ts'

/** Chat functions, in the order Trae itself prefers them. */
export const TRAE_CHAT_FUNCTIONS: readonly string[] = [
  'solo_work_remote',
  'solo_work_lite',
  'solo_agent_remote',
  'chat_v3',
  'solo_coder',
]

/**
 * Directory functions. The first five are the chat routes above; the rest are
 * IDE-only rosters that still list real models, so they are read for the union
 * and their attribution is dropped when the chat route cannot use it.
 */
export const TRAE_DIRECTORY_FUNCTIONS: readonly string[] = [
  ...TRAE_CHAT_FUNCTIONS,
  'solo_agent',
  'builder_v3',
  'chat',
  'inline_chat',
  'solo_agent_lite',
  'solo_design_lite',
  'solo_design_remote',
]

export const TRAE_DEFAULT_FUNCTION = 'solo_work_lite'

const EFFORT_ALIASES: Readonly<Record<string, string>> = {
  none: 'none',
  minimal: 'minimal',
  light: 'low',
  low: 'low',
  medium: 'medium',
  high: 'high',
  extra_high: 'xhigh',
  xhigh: 'xhigh',
  max: 'max',
}

/** Our effort id → the spelling `llm_utils_chat` accepts. */
const WIRE_EFFORTS: Readonly<Record<string, string>> = {
  none: 'none',
  minimal: 'minimal',
  low: 'light',
  medium: 'medium',
  high: 'high',
  xhigh: 'extra_high',
  max: 'max',
}

const TRAE_ERROR_HINTS: Readonly<Record<number, string>> = {
  1005: '当前套餐不包含这个模型',
  2001: 'Trae 尚未下发这条通道的模型配置（上游问题，稍后重试）',
  4001: '这条通道不提供该模型（config_name 被拒绝）',
  4008: '账号的 SOLO 额度已用完',
  4011: 'Trae 对该账号的这条通道做了限流，请稍后再试',
  4023: 'Trae 不认识这个模型名',
  4222: '企业租户额度已用完',
}

export interface TraeRemoteModel {
  id: string
  name: string
  contextWindow?: number
  maxContextWindow?: number
  creditMultiplier?: number
  multimodal: boolean
  efforts: string[]
  function?: string
}

export interface TraeWireModel {
  configName: string
  name: string
  maxTokens?: number
  contextWindow?: number
  creditMultiplier?: number
  multimodal?: boolean
  /** Upstream usage kind; only `chat_completion` rows are user-facing models. */
  usage?: string
  /** Upstream config source; 1 marks a first-party chat config. */
  configSource?: number
  efforts: string[]
  function: string
}

export interface TraeModelMeta {
  configName: string
  function: string
  wireEfforts: Readonly<Record<string, string>>
}

export interface TraeCatalog {
  models: ProviderModel[]
  meta: Map<string, TraeModelMeta>
}

export interface TraeProviderOptions {
  auth: TraeAuth
  store: AccountStore
  region: () => TraeRegion
  ttlMs: () => number
  timeoutMs: () => number
  textOnly: () => ReadonlySet<string>
  forceVision: () => ReadonlySet<string>
  fetchImpl?: typeof fetch
  loginTimeoutMs?: number
  logger?: (message: string) => void
  /** Injectable OpenRouter lookup for tests; defaults to the live catalog. */
  openRouter?: OpenRouterLookup
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function num(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value
  if (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim())) return Number(value)
  return undefined
}

function epochMs(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  return value < 1e12 ? Math.round(value * 1_000) : Math.round(value)
}

/** Map one upstream effort name to our id, dropping names we do not know. */
export function normalizeEffort(value: unknown): string | undefined {
  return typeof value === 'string' ? EFFORT_ALIASES[value.trim()] : undefined
}

export function effortsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const entry of value) {
    const id = normalizeEffort(entry)
    if (id !== undefined && !out.includes(id)) out.push(id)
  }
  return out
}

/** The `consumption_rate.data.rate` figure, when the row enables it. */
function creditRate(value: unknown): number | undefined {
  const consumption = record(value)
  if (consumption?.enable !== true) return undefined
  return num(record(consumption.data)?.rate)
}

function contactConfig(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'string' || value === '') return undefined
  try {
    return record(JSON.parse(value))
  } catch {
    return undefined
  }
}

/** A field that may arrive as a nested object or as a JSON string. */
function jsonRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === 'string') {
    try {
      return record(JSON.parse(value))
    } catch {
      return undefined
    }
  }
  return record(value)
}

function effortRank(effort: string): number {
  return ALL_REASONING_EFFORTS.indexOf(effort)
}

/** Keep only levels Trae can spell, de-duplicated and in menu order. */
function sortEfforts(efforts: readonly string[]): string[] {
  return [...new Set(efforts)]
    .filter(effort => WIRE_EFFORTS[effort] !== undefined)
    .sort((left, right) => effortRank(left) - effortRank(right))
}

/**
 * Resolve one model's level menu.
 *
 * OpenRouter's live `supported_efforts` wins when it knows the model, exactly
 * as for Loomy and Raccoon; otherwise the levels Trae itself publishes are
 * used. `max` appears only when one of those sources names it, so a model the
 * Trae client exposes as light/high/extra_high is not silently given a fourth
 * level.
 */
function resolveEfforts(advertised: readonly string[], live: readonly string[] | undefined): string[] {
  const fromLive = sortEfforts(live ?? [])
  return fromLive.length > 0 ? fromLive : sortEfforts(advertised)
}

/**
 * Parse the Remote directory.
 *
 * Groups are walked in {@link TRAE_CHAT_FUNCTIONS} order first so the chat
 * attribution prefers the same function the bridge calls, then the IDE-only
 * groups fill the union. Duplicate ids keep the stronger capacity row.
 */
export function parseTraeRemoteModels(payload: unknown): TraeRemoteModel[] {
  const root = record(payload)
  const data = record(root?.data)
  const groups = Array.isArray(data?.list) ? data.list : []
  const byId = new Map<string, TraeRemoteModel>()
  const seen = new Set<string>()

  const add = (groupFunction: string | undefined, models: unknown): void => {
    if (!Array.isArray(models)) return
    const chatFunction = groupFunction !== undefined && TRAE_CHAT_FUNCTIONS.includes(groupFunction)
      ? groupFunction
      : undefined
    for (const raw of models) {
      const model = record(raw)
      const id = text(model?.name)
      if (id === undefined) continue
      const display = text(model?.display_name)
      const context = record(model?.context_window_tokens)
      const dev = num(context?.dev)
      const max = model?.max_mode === true ? num(context?.max) : undefined
      // `features` is a JSON *string* on the wire, not an object.
      const features = jsonRecord(model?.features)
      const reasoning = record(model?.reasoning_effort_config)
      const efforts = effortsOf(reasoning?.options)
      const candidate: TraeRemoteModel = {
        id,
        name: display !== undefined && display !== '-' ? display : id,
        multimodal: model?.multimodal === true,
        efforts,
        ...dev === undefined ? {} : { contextWindow: dev },
        ...max === undefined ? {} : { maxContextWindow: max },
        ...creditRate(features?.consumption_rate) === undefined
          ? {}
          : { creditMultiplier: creditRate(features?.consumption_rate)! },
        ...chatFunction === undefined ? {} : { function: chatFunction },
      }
      // Keyed case-insensitively: the gateway spells the same config differently
      // across groups (`DeepSeek-V4-Flash` vs `deepseek-v4-flash`), and two rows
      // for one id make DSH reject the whole provider as "duplicate model
      // metadata".
      const key = id.toLowerCase()
      const existing = byId.get(key)
      if (existing === undefined) {
        byId.set(key, candidate)
        continue
      }
      // Groups disagree about a model's capability map: `solo_work_lite` can
      // report `options: null` while `chat_v3` publishes light/high/xhigh for the
      // same id. The capacity winner supplies the window, but efforts and the
      // multimodal flag are unioned so a weaker group cannot hide them.
      const merged = {
        ...candidate,
        function: candidate.function ?? existing.function,
        multimodal: candidate.multimodal || existing.multimodal,
        efforts: [...new Set([...candidate.efforts, ...existing.efforts])],
        ...candidate.creditMultiplier === undefined && existing.creditMultiplier !== undefined
          ? { creditMultiplier: existing.creditMultiplier }
          : {},
      }
      if ((candidate.maxContextWindow ?? 0) > (existing.maxContextWindow ?? 0)
        || ((candidate.maxContextWindow ?? 0) === (existing.maxContextWindow ?? 0)
          && (candidate.contextWindow ?? 0) > (existing.contextWindow ?? 0))) {
        byId.set(key, merged)
      } else {
        byId.set(key, {
          ...existing,
          function: existing.function ?? candidate.function,
          multimodal: existing.multimodal || candidate.multimodal,
          efforts: merged.efforts,
          ...existing.creditMultiplier === undefined && candidate.creditMultiplier !== undefined
            ? { creditMultiplier: candidate.creditMultiplier }
            : {},
        })
      }
    }
  }

  for (const groupFunction of TRAE_DIRECTORY_FUNCTIONS) {
    for (const group of groups) {
      const item = record(group)
      if (item?.function !== groupFunction) continue
      add(groupFunction, item.models)
      seen.add(groupFunction)
    }
  }
  for (const group of groups) {
    const item = record(group)
    const name = text(item?.function)
    if (name !== undefined && seen.has(name)) continue
    add(name, item?.models)
  }
  return [...byId.values()]
}

/** Parse one `get_detail_param` answer into wire rows. */
export function parseTraeWireModels(payload: unknown, functionName: string): TraeWireModel[] {
  const root = record(payload)
  const list = Array.isArray(root?.config_info_list) ? root.config_info_list : []
  const out: TraeWireModel[] = []
  for (const raw of list) {
    const config = record(raw)
    const configName = text(config?.config_name)
    if (configName === undefined) continue
    const display = record(config?.display_config)
    const details = Array.isArray(config?.model_detail_list) ? config.model_detail_list : []
    const detail = record(details[0])
    const context = record(config?.context_window_tokens)
    const contact = contactConfig(config?.display_contact_config)
    const rate = creditRate(contact?.consumption_rate)
    out.push({
      configName,
      name: text(display?.display_name) ?? configName,
      function: functionName,
      multimodal: display?.multimodal === true,
      usage: text(config?.usage),
      configSource: num(config?.config_source),
      efforts: effortsOf(detail?.reasoning_effort_options ?? config?.reasoning_effort_options),
      ...num(detail?.max_tokens) === undefined ? {} : { maxTokens: num(detail?.max_tokens)! },
      ...num(detail?.prompt_max_tokens) === undefined && num(context?.dev) === undefined
        ? {}
        : { contextWindow: num(detail?.prompt_max_tokens) ?? num(context?.dev)! },
      ...rate === undefined ? {} : { creditMultiplier: rate },
    })
  }
  return out
}

/**
 * Whether a wire-only row is a real chat model.
 *
 * `get_detail_param` also lists Trae's internal configurations: `custom_model_*`
 * (usage `custom_model`), `summary`, helper agents and subagents. They are not
 * models a user can pick in Trae, and DSH rejects a provider that carries them
 * as ordinary entries. The reference plugin filters on `usage`/`config_source`
 * plus an internal-looking name, and the same rule is applied here.
 */
export function isPromotableTraeWireModel(model: TraeWireModel): boolean {
  if (model.usage !== 'chat_completion') return false
  if (model.configSource !== 1) return false
  const name = model.name.trim()
  if (name === '' || name === '-') return false
  if (name === model.configName.trim()) return false
  if (!name.includes(' ') && name.includes('_')) return false
  return true
}

/**
 * Merge the two sources into the rows DSH sees plus the call metadata.
 *
 * Remote wins the display name (it matches the IDE's own picker); wire wins the
 * config name, the output cap and the post-discount multiplier. A remote row
 * without a wire config is skipped: there is no callable route for it, so
 * offering it only produces a `4001`. Wire-only rows are promoted only when
 * they look like a real chat model, never an internal helper config.
 */
export function mergeTraeModels(
  remote: readonly TraeRemoteModel[],
  wire: readonly TraeWireModel[],
  openRouter?: OpenRouterIndex,
): TraeCatalog {
  const wireById = new Map<string, TraeWireModel>()
  const wireByName = new Map<string, TraeWireModel>()
  for (const model of wire) {
    if (!wireById.has(model.configName.toLowerCase())) wireById.set(model.configName.toLowerCase(), model)
    if (!wireByName.has(model.name.toLowerCase())) wireByName.set(model.name.toLowerCase(), model)
  }
  const usedNames = new Set<string>()
  // DSH refuses a provider whose list contains two models with one id, so ids
  // are deduped case-insensitively here rather than left to the picker.
  const usedIds = new Set<string>()
  const models: ProviderModel[] = []
  const meta = new Map<string, TraeModelMeta>()

  const push = (input: {
    id: string
    name: string
    contextWindow?: number
    maxTokens?: number
    creditMultiplier?: number
    multimodal: boolean
    maxContextWindow?: number
    efforts: readonly string[]
    configName: string
    function?: string
    labels?: readonly string[]
    /** Appended to the display name to tell two equally named rows apart. */
    disambiguate?: string
  }): void => {
    const parsed = parseModelName(input.name)
    const base = parsed.name.length > 0 ? parsed.name : input.id
    const name = input.disambiguate === undefined ? base : `${base} (${input.disambiguate})`
    const live = openRouter?.match(base, input.id)
    const efforts = resolveEfforts([...new Set(input.efforts)], live?.efforts)
    const defaultEffort = defaultEffortOf(efforts)
    const price = input.creditMultiplier
    const labels = [...new Set([...(input.labels ?? []), ...parsed.labels])]
    const modalities = live?.inputModalities ?? []
    models.push({
      id: input.id,
      name,
      ...labels.length === 0 ? {} : { labels },
      contextWindow: input.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
      ...input.maxContextWindow === undefined || input.maxContextWindow <= (input.contextWindow ?? 0)
        ? {}
        : { maxContextWindow: input.maxContextWindow },
      ...input.maxTokens === undefined ? {} : { maxTokens: input.maxTokens },
      // OpenRouter's live modality list corrects the directory's advisory
      // `multimodal` flag, exactly as it does for the other two providers.
      vision: modalities.length > 0 ? modalities.includes('image') : input.multimodal,
      reasoning: efforts.length > 0,
      ...efforts.length === 0 ? {} : { reasoningEfforts: efforts },
      ...defaultEffort === undefined ? {} : { defaultReasoningEffort: defaultEffort },
      ...price === undefined ? {} : { priceFactor: price },
    })
    meta.set(input.id, {
      configName: input.configName,
      function: input.function ?? TRAE_DEFAULT_FUNCTION,
      wireEfforts: Object.fromEntries(efforts.flatMap(effort => {
        const mapped = WIRE_EFFORTS[effort]
        return mapped === undefined ? [] : [[effort, mapped]]
      })),
    })
  }

  for (const model of remote) {
    if (usedIds.has(model.id.toLowerCase())) continue
    const wireModel = wireById.get(model.id.toLowerCase()) ?? wireByName.get(model.name.toLowerCase())
    // Trae lists client-only models (Qwen3.8-Flash, Kimi-K2.8-Preview) that
    // have no config in any chat roster. Calling one can only answer 4001, so
    // it is not offered at all.
    if (wireModel === undefined) continue
    usedIds.add(model.id.toLowerCase())
    // Two directory rows can normalize to one display name (the `-Official`
    // and plain variants of one model). Append the id to the later row so the
    // picker does not show two identical entries.
    const remoteNameKey = model.name.toLowerCase()
    const collides = usedNames.has(remoteNameKey)
    usedNames.add(remoteNameKey)
    push({
      id: model.id,
      name: model.name,
      ...collides ? { disambiguate: model.id } : {},
      ...model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow },
      ...model.maxContextWindow === undefined ? {} : { maxContextWindow: model.maxContextWindow },
      ...wireModel.maxTokens === undefined ? {} : { maxTokens: wireModel.maxTokens },
      ...wireModel.creditMultiplier === undefined && model.creditMultiplier === undefined
        ? {}
        : { creditMultiplier: wireModel.creditMultiplier ?? model.creditMultiplier! },
      multimodal: model.multimodal || wireModel.multimodal === true,
      efforts: [...new Set([...wireModel.efforts, ...model.efforts])],
      configName: wireModel.configName,
      // The wire roster is what chat actually accepts; the directory group is
      // only a hint (and can name a function that rejects the model).
      function: wireModel.function,
    })
  }

  const remoteIds = new Set(remote.map(model => model.id.toLowerCase()))
  // Names already claimed by the remote skeleton, with their best context. A
  // dated snapshot sharing a display name is real only when it is WIDER than
  // the row already shown under that name (Kimi-K2-0905 168K behind Kimi-K2
  // 28K); an equally named, equally sized duplicate is skipped.
  const claimedNames = new Map<string, number>()
  for (const model of remote) {
    const key = model.name.toLowerCase()
    claimedNames.set(key, Math.max(claimedNames.get(key) ?? 0, model.contextWindow ?? 0))
  }
  for (const model of wire) {
    const id = model.configName.toLowerCase()
    // A wire roster lists one config under several functions with different
    // display names (`custom_model_gemini`); only the first is a real row.
    if (remoteIds.has(id) || usedIds.has(id)) continue
    // `custom_model_*`, `summary`, helper agents and subagents are internal
    // configurations, not user-selectable models.
    if (!isPromotableTraeWireModel(model)) continue
    const key = model.name.toLowerCase()
    const claimed = claimedNames.get(key)
    if (claimed !== undefined && (model.contextWindow ?? 0) <= claimed) continue
    usedIds.add(id)
    usedNames.add(key)
    claimedNames.set(key, Math.max(claimed ?? 0, model.contextWindow ?? 0))
    push({
      id: model.configName,
      name: model.name,
      ...claimed === undefined ? {} : { disambiguate: model.configName },
      ...model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow },
      ...model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens },
      ...model.creditMultiplier === undefined ? {} : { creditMultiplier: model.creditMultiplier },
      multimodal: model.multimodal === true,
      efforts: model.efforts,
      configName: model.configName,
      function: model.function,
    })
  }

  return { models, meta }
}

/** Trae tool schemas want `parameters` as a JSON string, without boolean `required`. */
export function normalizeTraeToolSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(entry => normalizeTraeToolSchema(entry))
  if (value === null || typeof value !== 'object') return value
  const source = value as Record<string, unknown>
  const result: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(source)) {
    if (key === 'required' && typeof entry === 'boolean') continue
    result[key] = normalizeTraeToolSchema(entry)
  }
  const properties = record(source.properties)
  if (properties !== undefined) {
    const promoted = new Set<string>()
    if (Array.isArray(source.required)) {
      for (const name of source.required) if (typeof name === 'string') promoted.add(name)
    }
    for (const [name, property] of Object.entries(properties)) {
      if (record(property)?.required === true) promoted.add(name)
    }
    if (promoted.size > 0) result.required = [...promoted]
  }
  return result
}

/** Project the harness request onto Trae's message shape. */
export function traeMessages(messages: readonly WireMessage[]): Record<string, unknown>[] {
  return messages.map(message => {
    const content = typeof message.content === 'string'
      ? [{ type: 'text', text: message.content }]
      : message.content
    const out: Record<string, unknown> = {
      role: message.role,
      // The gateway rejects an empty content array on a tool row; an empty text
      // block is the shape it accepts when a tool produced no text.
      content: message.role === 'tool' && content.length === 0
        ? [{ type: 'text', text: '' }]
        : content,
    }
    if (message.role === 'assistant' && message.tool_calls !== undefined && message.tool_calls.length > 0) {
      out.tool_calls = message.tool_calls.map(call => ({
        id: call.id,
        type: 'function',
        function_call: { name: call.function.name, arguments: call.function.arguments },
      }))
    }
    if (message.role === 'tool' && message.tool_call_id !== undefined) {
      out.tool_call_id = message.tool_call_id
    }
    return out
  })
}

export function traeTools(tools: GenerateOptions['tools']): Record<string, unknown>[] | undefined {
  if (tools === undefined || tools.length === 0) return undefined
  return tools.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: JSON.stringify(normalizeTraeToolSchema(tool.parameters)),
    },
  }))
}

interface TraeSseEvent {
  event?: string
  data: string
}

/** Trae's named SSE frames, tolerating CRLF and split chunks. */
async function* traeEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<TraeSseEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const parse = (block: string): TraeSseEvent | undefined => {
    let event: string | undefined
    const data: string[] = []
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith(':')) continue
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
    }
    if (data.length === 0) return undefined
    return { ...event === undefined ? {} : { event }, data: data.join('\n') }
  }
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let match = /\r?\n\r?\n/.exec(buffer)
      while (match !== null) {
        const block = buffer.slice(0, match.index)
        buffer = buffer.slice(match.index + match[0].length)
        const event = parse(block)
        if (event !== undefined) yield event
        match = /\r?\n\r?\n/.exec(buffer)
      }
    }
    buffer += decoder.decode()
    const event = parse(buffer)
    if (event !== undefined) yield event
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

function traeFailure(event: TraeSseEvent): { code?: number, message: string } | undefined {
  let payload: unknown
  try {
    payload = JSON.parse(event.data)
  } catch {
    return undefined
  }
  const root = record(payload)
  const code = typeof root?.code === 'number' ? root.code : undefined
  if (event.event !== 'error' && !(code !== undefined && code >= 4000)) return undefined
  return {
    ...code === undefined ? {} : { code },
    message: text(root?.message) ?? '',
  }
}

function failureStatus(code: number | undefined): number {
  if (code === 1005 || code === 4222) return 402
  if (code === 4011 || code === 4008) return 429
  if (code === 4001 || code === 4023) return 400
  return 502
}

function describeFailure(failure: { code?: number, message: string }): string {
  const hint = failure.code === undefined ? 'Trae 拒绝了这次请求' : TRAE_ERROR_HINTS[failure.code] ?? 'Trae 拒绝了这次请求'
  const parts = [hint, ...failure.code === undefined ? [] : [`Trae code ${failure.code}`]]
  if (failure.message !== '') parts.push(`上游：${failure.message}`)
  return parts.join(' · ')
}

/** Convert Trae's stream into harness chunks. */
export async function* openTraeStream(body: ReadableStream<Uint8Array>, model: string): AsyncGenerator<StreamChunk> {
  let nextIndex = 0
  let current: { kind: 'text' | 'reasoning', index: number, text: string } | undefined
  const tools = new Map<number, { id?: string, name?: string, arguments: string }>()
  let usage: StreamChunk | undefined
  let finish: string | undefined
  let sawContent = false
  let sawDone = false

  const start = (kind: 'text' | 'reasoning'): StreamChunk => {
    current = { kind, index: nextIndex++, text: '' }
    return { type: 'block-start', index: current.index, blockType: kind }
  }
  const close = (): StreamChunk | undefined => {
    if (current === undefined) return undefined
    const block = current.kind === 'text'
      ? { type: 'text' as const, text: current.text }
      : { type: 'reasoning' as const, text: current.text }
    const chunk: StreamChunk = { type: 'block-end', index: current.index, block }
    current = undefined
    return chunk
  }

  for await (const event of traeEvents(body)) {
    if (event.data.trim() === '[DONE]') {
      sawDone = true
      break
    }
    const failure = traeFailure(event)
    if (failure !== undefined) throw new ProviderHttpError(describeFailure(failure), failureStatus(failure.code))
    let payload: unknown
    try {
      payload = JSON.parse(event.data)
    } catch {
      continue
    }
    const root = record(payload)
    if (root === undefined) continue
    if (event.event === 'token_usage') {
      const prompt = num(root.prompt_tokens)
      const completion = num(root.completion_tokens)
      const cacheRead = num(root.cache_read_input_tokens) ?? 0
      const reasoning = num(root.reasoning_tokens) ?? 0
      if (prompt !== undefined || completion !== undefined) {
        const input = Math.max(0, (prompt ?? 0) - cacheRead)
        const output = completion ?? 0
        const total = num(root.total_tokens) ?? input + cacheRead + output
        usage = {
          type: 'usage',
          usage: {
            inputTokens: input,
            outputTokens: output,
            totalTokens: total,
            ...cacheRead === 0 ? {} : { cacheReadTokens: cacheRead },
            ...reasoning === 0 ? {} : { reasoningTokens: reasoning },
          },
        }
      }
      continue
    }
    if (event.event === 'done' || (root.finish_reason !== undefined && root.response === undefined)) {
      sawDone = true
      if (typeof root.finish_reason === 'string') finish = root.finish_reason
      continue
    }
    const reasoning = text(root.reasoning_content)
    if (reasoning !== undefined) {
      if (current?.kind !== 'reasoning') {
        const ended = close()
        if (ended !== undefined) yield ended
        yield start('reasoning')
      }
      current!.text += reasoning
      sawContent = true
      yield { type: 'reasoning-delta', index: current!.index, text: reasoning }
    }
    const response = text(root.response)
    if (response !== undefined) {
      if (current?.kind !== 'text') {
        const ended = close()
        if (ended !== undefined) yield ended
        yield start('text')
      }
      current!.text += response
      sawContent = true
      yield { type: 'text-delta', index: current!.index, text: response }
    }
    if (Array.isArray(root.tool_calls)) {
      // Trae sends the call id and name on the FIRST fragment and empty strings
      // on every argument fragment. Treating '' as a value would erase the id,
      // and a tool result keyed by an empty call id is rejected by the host.
      for (const [position, raw] of root.tool_calls.entries()) {
        const call = record(raw)
        if (call === undefined) continue
        const index = typeof call.index === 'number' ? call.index : position
        const held = tools.get(index) ?? { arguments: '' }
        const fn = record(call.function_call) ?? record(call.function)
        const id = typeof call.id === 'string' ? call.id.trim() : ''
        if (id !== '') held.id = id
        const name = typeof fn?.name === 'string' ? fn.name : ''
        if (name !== '') held.name = (held.name ?? '') + name
        const args = fn?.arguments
        if (typeof args === 'string') held.arguments += args
        else if (args !== undefined) held.arguments += JSON.stringify(args)
        tools.set(index, held)
        sawContent = true
      }
    }
  }

  const ended = close()
  if (ended !== undefined) yield ended

  let toolCalls = 0
  const usedIds = new Set<string>()
  for (const [, tool] of [...tools.entries()].sort((left, right) => left[0] - right[0])) {
    const fallback = () => `call_${randomUUID().replaceAll('-', '').slice(0, 24)}`
    const preferred = tool.id?.trim() ?? ''
    let callId = preferred !== '' ? preferred : fallback()
    // Two calls must not share an id: the host pairs every result with exactly
    // one advertised call and rejects a repeated id.
    while (usedIds.has(callId)) callId = fallback()
    usedIds.add(callId)
    const branded = callId as ToolCallId
    const name = tool.name ?? 'unknown_tool'
    const args = tool.arguments === '' ? '{}' : tool.arguments
    const blockIndex = nextIndex++
    yield { type: 'block-start', index: blockIndex, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: blockIndex, id: branded, name, argumentsDelta: args }
    yield {
      type: 'block-end',
      index: blockIndex,
      block: { type: 'tool-call', id: branded, name, arguments: args },
    }
    toolCalls++
  }

  if (usage !== undefined) yield usage

  const mapped = finish === 'length' || finish === 'max_tokens'
    ? 'max-tokens'
    : finish === 'tool_calls' || finish === 'function_call'
      ? 'tool-calls'
      : toolCalls > 0
        ? 'tool-calls'
        : 'stop'
  // A stream that ends without a single token is not a successful empty
  // answer; surfacing it as a length stop keeps the transcript honest.
  const reason = sawContent || sawDone ? mapped : 'max-tokens'
  yield { type: 'finish', reason: { kind: reason } }
}

/** CN entitlement document → the card's quota shape. */
export function parseTraeUsage(payload: unknown): QuotaSnapshot {
  const root = record(payload) ?? {}
  const data = record(root.data) ?? root
  const summary = record(data.usage_summary) ?? {}
  const total = num(summary.total_amount)
  const used = num(summary.consumed_amount)
  const rawRatio = num(summary.consumption_ratio)
  const ratio = rawRatio === undefined ? undefined : rawRatio <= 1 ? rawRatio * 100 : rawRatio
  const packs: QuotaPack[] = []
  const list = Array.isArray(data.user_entitlement_pack_list) ? data.user_entitlement_pack_list : []
  for (const raw of list) {
    const pack = record(raw)
    if (pack === undefined) continue
    const base = record(pack.entitlement_base_info) ?? {}
    const quota = record(base.quota)
    const packageQuota = record(record(record(base.product_extra)?.package_extra)?.quota)
    const limit = num(packageQuota?.credits_limit) ?? num(quota?.credits_limit)
    const consumed = num(record(pack.usage)?.credits_amount)
    const end = epochMs(num(base.end_time))
    packs.push({
      label: text(pack.display_desc) ?? '额度包',
      ...limit === undefined ? {} : { total: limit },
      ...consumed === undefined ? {} : { used: consumed },
      ...end === undefined ? {} : { expiresAt: end },
    })
  }
  packs.sort((left, right) => (left.expiresAt ?? Number.MAX_SAFE_INTEGER) - (right.expiresAt ?? Number.MAX_SAFE_INTEGER))
  return {
    ...total === undefined ? {} : { total },
    ...used === undefined ? {} : { used },
    ...ratio === undefined ? {} : { ratio },
    ...packs.length === 0 ? {} : { packs },
    at: Date.now(),
  }
}

/** International subscription document → the card's quota shape. */
export function parseTraePlan(payload: unknown): QuotaSnapshot {
  const root = record(payload) ?? {}
  const trial = record(root.trial_status)
  const inTrial = root.in_trial === true || trial?.is_in_trial === true
  const plan = text(root.user_pay_identity_str)
    ?? (inTrial ? '试用' : root.has_package === true ? '订阅' : '免费')
  const trialEnd = epochMs(num(trial?.trial_end_time) ?? num(root.trial_end_time))
  return {
    plan,
    ...trialEnd === undefined ? {} : { trialEndsAt: trialEnd },
    at: Date.now(),
  }
}

export function parseTraeCheckin(payload: unknown): CheckinStatus {
  const root = record(payload) ?? {}
  const reward = (num(root.credits) ?? 0) + (num(root.extra_credits) ?? 0)
  return {
    available: root.enable !== false,
    claimed: root.checked_in === true,
    deviceClaimed: root.did_checked_in === true,
    ...reward === 0 ? {} : { reward },
    ...text(root.message) === undefined ? {} : { message: text(root.message)! },
  }
}

export class TraeProvider {
  private catalogInstance: ModelCatalog
  private catalogRegion: TraeRegion
  private meta = new Map<string, TraeModelMeta>()
  private quotaCache: { at: number, region: TraeRegion, value: QuotaSnapshot } | undefined
  private quotaInflight: Promise<QuotaSnapshot> | undefined
  private quotaInflightRegion: TraeRegion | undefined
  private loginFlow: TraeWebLogin | undefined
  private readonly fetchImpl: typeof fetch
  private readonly openRouter: OpenRouterLookup

  constructor(private readonly options: TraeProviderOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch
    this.openRouter = options.openRouter ?? new OpenRouterCatalog(this.fetchImpl)
    this.catalogRegion = options.region()
    this.catalogInstance = new ModelCatalog(() => this.fetchCatalog(), options.ttlMs)
  }

  /** The catalog the currently selected region sees. */
  get catalog(): ModelCatalog {
    return this.catalogInstance
  }

  /**
   * Keep every cache on the selected region.
   *
   * The two deployments share no model ids, config names or quota, so a switch
   * swaps the catalog instance (which also orphans any fetch still in flight for
   * the previous region) and drops the quota reading.
   */
  private ensureRegion(): TraeRegion {
    const region = this.options.region()
    if (this.catalogRegion === region) return region
    this.catalogRegion = region
    this.catalogInstance = new ModelCatalog(() => this.fetchCatalog(), this.options.ttlMs)
    this.meta = new Map()
    this.quotaCache = undefined
    this.quotaInflight = undefined
    this.quotaInflightRegion = undefined
    return region
  }

  private profile(): TraeRegionProfile {
    return TRAE_REGION_PROFILES[this.options.region()]
  }

  async status() {
    return { ...(await this.options.auth.status()), region: this.options.region() }
  }

  async signedIn(): Promise<boolean> {
    return (await this.options.auth.status()).signedIn
  }

  async models(fresh = false): Promise<readonly ProviderModel[]> {
    this.ensureRegion()
    if (fresh) this.openRouter.invalidate()
    return this.catalogInstance.models(fresh)
  }

  catalogError(): string | undefined {
    return this.catalogInstance.error()
  }

  invalidateModels(): void {
    // A settings refresh must also re-read OpenRouter: the effort/modality menu
    // is served from it, and its own TTL would otherwise hide upstream changes.
    this.openRouter.invalidate()
    this.catalogInstance.invalidate()
  }

  invalidateQuota(): void {
    this.quotaCache = undefined
    this.quotaInflight = undefined
    this.quotaInflightRegion = undefined
  }

  private headers(token: string, profile: TraeRegionProfile): Record<string, string> {
    return {
      authorization: `Cloud-IDE-JWT ${token}`,
      'content-type': 'application/json',
      accept: 'application/json',
      'x-trae-client-type': 'web',
      // These four are bound by the gateway on every call, including
      // get_detail_param; omitting the version code makes chat fail with
      // `expr_path=app_version_code` and turns the wire roster empty.
      'x-app-id': TRAE_APP_ID,
      'x-app-version-code': TRAE_VERSION_CODE,
      'x-ide-version-code': TRAE_VERSION_CODE,
      'x-ide-version-type': 'stable',
      'x-trae-user-timezone': profile.timezone,
      'x-preferenced-language': profile.language,
      referer: `${profile.webOrigin}/`,
      'user-agent': TRAE_WEB_USER_AGENT,
    }
  }

  private chatHeaders(
    token: string,
    identity: { deviceId: string, machineId: string, userId?: string },
    profile: TraeRegionProfile,
  ): Record<string, string> {
    const trace = randomUUID().replaceAll('-', '')
    return {
      ...this.headers(token, profile),
      accept: 'text/event-stream',
      'x-ide-token': token,
      'x-cloudide-token': token,
      'x-device-id': identity.deviceId,
      'x-machine-id': identity.machineId,
      ...identity.userId === undefined ? {} : { 'x-uid': identity.userId },
      'x-custom-trace-id': trace,
      'x-flow-traceparent': `04-${trace}-${trace.slice(0, 16)}-01`,
      'request-traffic-type': 'prod',
    }
  }

  private async fetchRemote(profile: TraeRegionProfile, token: string): Promise<TraeRemoteModel[]> {
    const bases = [profile.remoteBase, `${profile.chatBase}/api/remote/v1`]
      .filter((base, index, all) => all.indexOf(base) === index)
    let lastError: unknown
    for (const base of bases) {
      try {
        const response = await this.fetchImpl(`${base}/models?functions=${TRAE_DIRECTORY_FUNCTIONS.join(',')}`, {
          headers: this.headers(token, profile),
          signal: AbortSignal.timeout(this.options.timeoutMs()),
        })
        if (!response.ok) throw new ProviderHttpError(await responseError(response), response.status)
        const payload = await response.json()
        const models = parseTraeRemoteModels(payload)
        if (models.length > 0) return models
        lastError = new Error('Trae 模型目录没有返回任何模型')
      } catch (error) {
        lastError = error
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError))
  }

  private async fetchWire(
    profile: TraeRegionProfile,
    token: string,
    identity: { deviceId: string, machineId: string, userId?: string },
  ): Promise<TraeWireModel[]> {
    const out: TraeWireModel[] = []
    for (const functionName of TRAE_CHAT_FUNCTIONS) {
      try {
        const response = await this.fetchImpl(`${profile.chatBase}${TRAE_SOLO_MODELS_PATH}`, {
          method: 'POST',
          headers: { ...this.chatHeaders(token, identity, profile), accept: 'application/json' },
          body: JSON.stringify({
            function: functionName,
            config_names: null,
            need_prompt: false,
            current_config_info: null,
            poly_prompt: true,
            mode_type: null,
            agent_type: null,
          }),
          signal: AbortSignal.timeout(this.options.timeoutMs()),
        })
        if (!response.ok) continue
        out.push(...parseTraeWireModels(await response.json(), functionName))
      } catch {
        /* one directory function failing must not hide the others */
      }
    }
    return out
  }

  private async fetchCatalog(): Promise<ProviderModel[]> {
    const region = this.options.region()
    const token = await this.options.auth.accessToken()
    const identity = await this.options.auth.identity()
    const profile = this.profile()
    // OpenRouter is the shared capability source; a failure falls back to the
    // directory's own declaration rather than failing the refresh.
    const openRouter = this.openRouter.models().catch(() => undefined)
    let remote: TraeRemoteModel[] = []
    let remoteError: unknown
    try {
      remote = await this.fetchRemote(profile, token)
    } catch (error) {
      remoteError = error
    }
    const wire = await this.fetchWire(profile, token, identity)
    if (remote.length === 0 && wire.length === 0) {
      throw remoteError instanceof Error ? remoteError : new Error('Trae 没有返回任何模型')
    }
    const catalog = mergeTraeModels(remote, wire, await openRouter)
    if (catalog.models.length === 0) {
      throw new Error('Trae 目录里没有可调用的模型；请稍后刷新，或重新登录后再试。')
    }
    // A switch during the fetch leaves this result for the old region only.
    if (this.options.region() === region) this.meta = catalog.meta
    const textOnly = this.options.textOnly()
    const forceVision = this.options.forceVision()
    return catalog.models.map(model => ({
      ...model,
      // The directory's `multimodal` flag is advisory; the two ID lists are the
      // explicit correction, with text-only winning as on every provider.
      vision: textOnly.has(model.id) ? false : forceVision.has(model.id) ? true : model.vision,
    }))
  }

  async quota(fresh = false): Promise<QuotaSnapshot> {
    const region = this.ensureRegion()
    if (!fresh && this.quotaCache !== undefined && this.quotaCache.region === region
      && Date.now() - this.quotaCache.at < 60_000) {
      return this.quotaCache.value
    }
    if (this.quotaInflight !== undefined && this.quotaInflightRegion === region) return this.quotaInflight
    this.quotaInflight = (async () => {
      try {
        const profile = this.profile()
        const token = await this.options.auth.accessToken()
        const identity = await this.options.auth.identity()
        const path = profile.checkin
          ? '/trae/api/v2/pay/web_user_ent_usage'
          : '/trae/api/v1/pay/ide_user_pay_status'
        const response = await this.fetchImpl(`${profile.payBase}${path}`, {
          method: 'POST',
          headers: {
            ...this.headers(token, profile),
            'x-device-id': identity.deviceId,
            'x-machine-id': identity.machineId,
          },
          body: JSON.stringify(profile.checkin ? { require_usage: true } : {}),
          signal: AbortSignal.timeout(this.options.timeoutMs()),
        })
        if (!response.ok) {
          if (response.status === 401 || response.status === 403) await this.options.auth.accessToken(true)
          throw new ProviderHttpError(await responseError(response), response.status)
        }
        const payload = await response.json()
        const value = profile.checkin ? parseTraeUsage(payload) : parseTraePlan(payload)
        this.quotaCache = { at: Date.now(), region, value }
        return value
      } finally {
        this.quotaInflight = undefined
        this.quotaInflightRegion = undefined
      }
    })()
    this.quotaInflightRegion = region
    return this.quotaInflight
  }

  async checkinStatus(): Promise<CheckinStatus> {
    this.ensureRegion()
    const profile = this.profile()
    if (!profile.checkin) return { available: false, claimed: false, deviceClaimed: false }
    const token = await this.options.auth.accessToken()
    const identity = await this.options.auth.identity()
    const response = await this.fetchImpl(`${profile.apiBase}/trae/api/v2/ug/checkin_credits/status`, {
      method: 'POST',
      headers: {
        ...this.headers(token, profile),
        'x-device-id': identity.deviceId,
        'x-machine-id': identity.machineId,
      },
      body: '{}',
      signal: AbortSignal.timeout(this.options.timeoutMs()),
    })
    if (!response.ok) throw new ProviderHttpError(await responseError(response), response.status)
    return parseTraeCheckin(await response.json())
  }

  /** Claim today's reward. The only state-changing call in this provider. */
  async claimCheckin(): Promise<CheckinStatus> {
    this.ensureRegion()
    const profile = this.profile()
    if (!profile.checkin) throw new Error('Trae 国际版没有签到活动')
    const token = await this.options.auth.accessToken()
    const identity = await this.options.auth.identity()
    const response = await this.fetchImpl(`${profile.apiBase}/trae/api/v2/ug/checkin_credits/claim`, {
      method: 'POST',
      headers: {
        ...this.headers(token, profile),
        'x-device-id': identity.deviceId,
        'x-machine-id': identity.machineId,
      },
      body: '{}',
      signal: AbortSignal.timeout(this.options.timeoutMs()),
    })
    if (!response.ok) throw new ProviderHttpError(await responseError(response), response.status)
    const payload = record(await response.json()) ?? {}
    const code = typeof payload.code === 'number' ? payload.code : 0
    if (code === 0) {
      this.invalidateQuota()
      return { available: true, claimed: true, deviceClaimed: false }
    }
    if (code === 9095) {
      return { available: true, claimed: false, deviceClaimed: true, message: '本机今日已签到' }
    }
    throw new Error(text(payload.message) ?? `签到失败（code ${code}）`)
  }

  async *stream(
    options: GenerateOptions,
    model: string,
    readImage: ReadImage | undefined,
    onInvalidate: () => void,
  ): AsyncGenerator<StreamChunk> {
    this.ensureRegion()
    const profile = this.profile()
    const token = await this.options.auth.accessToken()
    const identity = await this.options.auth.identity()
    await this.models()
    const meta = this.meta.get(model)
    if (meta === undefined) {
      throw new ProviderHttpError(
        `Trae 未在当前账号的可调用模型里找到「${model}」。它可能只存在于 Trae 客户端通道；请在模型菜单里换一个模型。`,
        400,
      )
    }
    const messages = await buildMessages(options, readImage)
    const effort = options.reasoningEffort === undefined ? undefined : meta.wireEfforts[options.reasoningEffort]
    const tools = traeTools(options.tools)
    const body: Record<string, unknown> = {
      messages: traeMessages(messages),
      model: meta.configName,
      config_name: meta.configName,
      function: meta.function,
      stream: true,
      ...options.maxTokens === undefined ? {} : { max_tokens: Math.max(1, Math.floor(options.maxTokens)) },
      ...tools === undefined ? {} : { tools },
      ...effort === undefined ? {} : { reasoning_effort: effort },
    }
    try {
      const response = await this.fetchImpl(`${profile.chatBase}${TRAE_SOLO_CHAT_PATH}`, {
        method: 'POST',
        headers: this.chatHeaders(token, identity, profile),
        body: JSON.stringify(body),
        signal: options.signal ?? AbortSignal.timeout(120_000),
      })
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) await this.options.auth.accessToken(true)
        throw new ProviderHttpError(await responseError(response), response.status)
      }
      if (response.body === null) throw new ProviderHttpError('Trae 没有返回响应体', 502)
      yield* openTraeStream(response.body, model)
    } finally {
      onInvalidate()
    }
  }

  async startBrowserLogin(region?: TraeRegion): Promise<LoginStatus> {
    const running = this.loginFlow?.status()
    if (running?.running === true) return running
    const target = region ?? this.options.region()
    const flow = new TraeWebLogin({
      region: target,
      ...this.options.loginTimeoutMs === undefined ? {} : { timeoutMs: this.options.loginTimeoutMs },
      ...this.options.logger === undefined ? {} : { logger: this.options.logger },
      save: async (account: TraeLoginAccount) => {
        await this.options.store.saveTrae({
          accessToken: account.accessToken,
          region: target,
          deviceId: account.deviceId,
          machineId: account.machineId,
          loginAt: Date.now(),
          ...account.userId === undefined ? {} : { userId: account.userId },
          ...account.name === undefined ? {} : { name: account.name },
          ...account.expiresAt === undefined ? {} : { expiresAt: account.expiresAt },
        })
        this.invalidateModels()
        this.invalidateQuota()
      },
    })
    this.loginFlow = flow
    return flow.start()
  }

  browserLoginStatus(): LoginStatus {
    return this.loginFlow?.status() ?? { running: false, phase: 'idle' }
  }

  async cancelBrowserLogin(): Promise<void> {
    await this.loginFlow?.cancel()
  }

  async logoutAccount(): Promise<void> {
    await this.options.auth.logout()
    this.invalidateModels()
    this.invalidateQuota()
  }

  close(): void {
    void this.loginFlow?.close()
  }
}
