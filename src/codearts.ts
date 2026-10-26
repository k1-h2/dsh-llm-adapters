/**
 * Huawei CodeArts (码道) gateway client.
 *
 * Three things separate it from the other routes:
 *
 * 1. **No bearer token.** Every call is signed (`SDK-HMAC-SHA256`) with the
 *    AK/SK/security-token triple from the OAuth exchange.
 * 2. **The catalogue is two rosters.** `opengw gateway/config` lists the
 *    free-allowance ("benefit") models and `/v1/model/builtin` the ordinary
 *    ones; a model is only callable on the roster that listed it.
 * 3. **No context window anywhere.** The upstream publishes none, so the value
 *    comes from the IDE's own provider configuration (see
 *    {@link codeartsContextWindow}).
 *
 * @module dsh-llm-adapters/codearts
 */

import { randomUUID } from 'node:crypto'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { AccountStore, CodeArtsAccountRecord } from './account-store.ts'
import { CodeArtsAuth } from './auth.ts'
import type { AuthStatus } from './auth.ts'
import { ModelCatalog } from './catalog.ts'
import type { ProviderModel } from './catalog.ts'
import {
  CODEARTS_BENEFIT_FALLBACK,
  CODEARTS_CHAT_URL,
  CODEARTS_CLAIMED_STATUSES,
  CODEARTS_DAILY_LOGIN_TYPE,
  CODEARTS_EXTRA_HEADERS,
  CODEARTS_GATEWAY_CONFIG_URL,
  CODEARTS_MAX_OUTPUT_TOKENS,
  CODEARTS_MODEL_BUILTIN_PATH,
  CODEARTS_OPS_CHANNEL,
  CODEARTS_OPS_CLAIM_PATH,
  CODEARTS_OPS_CONFIRM_PATH,
  CODEARTS_OPS_DELIVERY_PATH,
  CODEARTS_PACKAGE_INFO_PATH,
  CODEARTS_SNAP_BASE,
  CODEARTS_VISION_MODELS,
  codeartsContextWindow,
} from './codearts-endpoints.ts'
import { CodeArtsLogin } from './codearts-login.ts'
import { headersForFetch, signRequestHuawei } from './codearts-sign.ts'
import { CodeArtsSessionWindow, sharedSessionWindow } from './codearts-window.ts'
import type { CodeArtsCredential } from './codearts-oauth.ts'
import type { LoginStatus } from './login-page.ts'
import type { CheckinStatus, QuotaPack, QuotaSnapshot } from './types.ts'
import { ProviderHttpError, buildMessages, buildTools, consumeOpenAiStream } from './wire.ts'
import type { ReadImage } from './wire.ts'

/** Levels the gateway really has: thinking is a single on/off switch. */
export const CODEARTS_EFFORTS: readonly string[] = ['off', 'on']
export const CODEARTS_DEFAULT_EFFORT = 'on'

export interface CodeArtsProviderOptions {
  auth: CodeArtsAuth
  store: AccountStore
  ttlMs: () => number
  timeoutMs: () => number
  textOnly: () => ReadonlySet<string>
  forceVision: () => ReadonlySet<string>
  fetchImpl?: typeof fetch
  logger?: (message: string) => void
  loginTimeoutMs?: number
  /** Chat budget; defaults to the process-wide window (survives hot reloads). */
  window?: CodeArtsSessionWindow
}

/** One roster entry before it becomes a model row. */
export interface CodeArtsModelRow {
  id: string
  name: string
  /** Display multiplier (`0.7x`) as the upstream spells it. */
  rateLabel?: string
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
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value.trim())) return Number(value)
  return undefined
}

/**
 * Unwrap the `{ code, message, data }` envelope the ops endpoints use.
 *
 * The catalogue and `statistics/plugin` answer with a bare object instead, so
 * only the calls known to be enveloped go through here. A non-zero business
 * code is a failure even though the HTTP status is 200.
 */
function unwrapEnvelope(payload: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (payload === undefined) return undefined
  const code = payload.code
  if (typeof code !== 'number') return payload
  if (code !== 0) return undefined
  return record(payload.data)
}

/** `deepseek-v4-flash-0731` → `deepseek-v4-flash`; chat only knows the latter. */
export function normalizeCodeArtsModelId(id: string): string {
  const match = /^(.*)-\d{4}$/.exec(id)
  return match?.[1] ?? id
}

/**
 * Pick the credit entry that applies right now.
 *
 * `deepseek-v4.1-flash` carries two: 0.18x by default and 0.09x from 21:00 for
 * eleven hours. Showing `credit[0]` would advertise the wrong number for a third
 * of the day. Only the measured shape is understood (an hour-of-day start plus
 * an hour count); anything else falls back to the first entry, which is exactly
 * how the upstream behaves when a model has no slots at all.
 */
export function pickActiveCredit(
  credit: readonly unknown[],
  slots: unknown,
  nowMs: number = Date.now(),
): Record<string, unknown> | undefined {
  const entries = credit
    .map(entry => record(entry))
    .filter((entry): entry is Record<string, unknown> => entry !== undefined)
  if (entries.length === 0) return undefined
  const table = record(slots)
  if (table === undefined) return entries[0]
  for (const entry of entries) {
    const slotId = text(entry.time_slot_id)
    if (slotId === undefined) continue
    const slot = record(table[slotId])
    if (slot === undefined) continue
    if (slotActive(slot, nowMs)) return entry
  }
  return entries[0]
}

function slotActive(slot: Record<string, unknown>, nowMs: number): boolean {
  const schedule = text(slot.schedule)
  if (schedule === undefined) return false
  // Six-field cron, as measured: `0 0 21 * * *`.
  const parts = schedule.split(/\s+/)
  if (parts.length < 3) return false
  const minute = Number(parts[1])
  const hour = Number(parts[2])
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return false
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return false
  const duration = Number(slot.duration)
  if (!Number.isFinite(duration) || duration <= 0) return false
  // Only `hour` is measured; inventing a conversion for other units would make
  // the displayed multiplier wrong in a way nobody can trace back.
  if (slot.timeunit !== 'hour') return false
  const shanghaiMinutes = Math.floor((nowMs + 8 * 3_600_000) / 60_000) % (24 * 60)
  const start = hour * 60 + minute
  // The window may cross midnight (21:00 + 11h ends at 07:59).
  const offset = (shanghaiMinutes - start + 24 * 60) % (24 * 60)
  return offset < duration * 60
}

/** Read one roster into rows, dropping vision models and duplicates. */
export function parseCodeArtsRoster(items: unknown, nowMs: number = Date.now()): CodeArtsModelRow[] {
  if (!Array.isArray(items)) return []
  const seen = new Set<string>()
  const out: CodeArtsModelRow[] = []
  for (const item of items) {
    const entry = record(item)
    if (entry === undefined) continue
    const rawId = text(entry.model_id)
    if (rawId === undefined) continue
    const id = normalizeCodeArtsModelId(rawId)
    // The VL models read images but answer no tool calls and carry a small
    // window, so they cannot drive an agent loop. The gateway spells them both
    // ways (`Qwen3-VL-235B`, `kimi-k2.6-vl`), so the check is case-insensitive.
    const upper = id.toUpperCase()
    if (upper.includes('-VL-') || upper.endsWith('-VL')) continue
    const key = id.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    const credit = Array.isArray(entry.credit) ? entry.credit : []
    const picked = pickActiveCredit(credit, entry.time_slots, nowMs)
    const rateLabel = text(picked?.ratio_display)
    out.push({
      id,
      name: text(entry.model_name) ?? id,
      ...rateLabel === undefined ? {} : { rateLabel },
    })
  }
  return out
}

/** `0.7x` → `0.7`; anything else is left alone rather than guessed. */
export function priceFactorOfLabel(label: string | undefined): number | undefined {
  if (label === undefined) return undefined
  const match = /^(\d+(?:\.\d+)?)\s*x$/i.exec(label.trim())
  if (match === null) return undefined
  const value = Number(match[1])
  return Number.isFinite(value) ? value : undefined
}

function isVisionModel(id: string): boolean {
  return CODEARTS_VISION_MODELS.some(entry => entry.toLowerCase() === id.toLowerCase())
}

/** Raised inside the stream loop for conditions a retry can fix. */
class CodeArtsRetry extends Error {
  constructor(readonly kind: 'queue' | 'auth' | 'benefit', message: string) {
    super(message)
    this.name = 'CodeArtsRetry'
  }
}

const QUEUE_MARKERS = ['TM.00001041', 'ModelArts.81111.429', 'too many requests', 'queue']
const AUTH_MARKERS = ['APIG.0602', 'APIG.0301', 'invalid token', 'token expired', 'not logged in']

function classifyFailure(status: number, body: string): Error {
  const lower = body.toLowerCase()
  if (body.includes('InferHub.4004.200')) {
    return new CodeArtsRetry('benefit', '该账号没有这个模型的免费额度包')
  }
  if (status === 401 || status === 403 || AUTH_MARKERS.some(marker => lower.includes(marker.toLowerCase()))) {
    return new CodeArtsRetry('auth', body === '' ? `HTTP ${status}` : body)
  }
  if (status === 429 || QUEUE_MARKERS.some(marker => lower.includes(marker.toLowerCase()))) {
    return new CodeArtsRetry('queue', body === '' ? `HTTP ${status}` : body)
  }
  if (body.includes('InferHub.4291.200') || lower.includes('insufficient balance') || lower.includes('quota')) {
    return new ProviderHttpError('CodeArts 额度已用完。可换一个模型，或等免费额度重置后再试。', 402)
  }
  return new ProviderHttpError(body === '' ? `HTTP ${status}` : body.slice(0, 400), status)
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  if (signal?.aborted === true) {
    reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
    return
  }
  const onAbort = (): void => {
    clearTimeout(timer)
    reject(signal?.reason instanceof Error ? signal.reason : new Error('aborted'))
  }
  const timer = setTimeout(() => {
    signal?.removeEventListener('abort', onAbort)
    resolve()
  }, ms)
  signal?.addEventListener('abort', onAbort, { once: true })
})

/** Retries for a gateway that is busy for reasons the window cannot predict. */
const QUEUE_ATTEMPTS = 3
/** Minimum pause before retrying a rejected call; the window adds its own. */
const QUEUE_BACKOFF_MS = 20_000

/**
 * The message a user sees once waiting is hopeless.
 *
 * The raw gateway text (`TM.00001041`) reads like a bug; the limit is the
 * trial plan's, and the only fix on this side is to say so.
 */
function queueExhausted(): ProviderHttpError {
  return new ProviderHttpError(
    'CodeArts 体验版每分钟只允许 3 个会话，当前已被占满。请稍等片刻再发，或关闭其它 CodeArts 会话。',
    429,
  )
}

export class CodeArtsProvider {
  private readonly catalog: ModelCatalog
  private readonly login: CodeArtsLogin
  private quotaSnapshot: { value: QuotaSnapshot, at: number } | undefined
  private quotaInflight: Promise<QuotaSnapshot> | undefined
  private benefitModels = new Set<string>(CODEARTS_BENEFIT_FALLBACK)
  /** Models that answered `InferHub.4004.200`: no allowance pack to bill. */
  private readonly noBenefit = new Set<string>()
  private noBenefitLoaded = false
  private readonly window: CodeArtsSessionWindow
  private readonly sessionId = randomUUID()

  constructor(private readonly options: CodeArtsProviderOptions) {
    this.window = options.window ?? sharedSessionWindow()
    this.catalog = new ModelCatalog(() => this.loadModels(), options.ttlMs)
    this.login = new CodeArtsLogin({
      ...options.loginTimeoutMs === undefined ? {} : { timeoutMs: options.loginTimeoutMs },
      ...options.fetchImpl === undefined ? {} : { fetcher: options.fetchImpl },
      ...options.logger === undefined ? {} : { logger: options.logger },
      save: async (account) => {
        await options.store.saveCodearts(account as CodeArtsAccountRecord)
        // A different account starts with a clean budget: the slots the gateway
        // remembers belong to the old one.
        this.window.reset()
        this.noBenefit.clear()
        this.invalidateModels()
        this.invalidateQuota()
      },
    })
  }

  private get fetcher(): typeof fetch {
    return this.options.fetchImpl ?? fetch
  }

  private async credential(): Promise<CodeArtsCredential> {
    return this.options.auth.credential()
  }

  // ---------------------------------------------------------------- catalog

  async models(fresh = false): Promise<readonly ProviderModel[]> {
    return this.catalog.models(fresh)
  }

  catalogError(): string | undefined {
    return this.catalog.error()
  }

  invalidateModels(): void {
    this.catalog.invalidate()
  }

  /** Signed GET returning the parsed body, or `undefined` on any failure. */
  private async signedGet(credential: CodeArtsCredential, url: string): Promise<unknown> {
    const signed = await signRequestHuawei(
      credential.accessKeyId,
      credential.secretAccessKey,
      credential.securityToken,
      'GET',
      url,
    )
    try {
      const response = await this.fetcher(url, {
        method: 'GET',
        headers: { ...headersForFetch(signed), ...CODEARTS_EXTRA_HEADERS, accept: 'application/json' },
        signal: AbortSignal.timeout(this.options.timeoutMs()),
      })
      if (!response.ok) return undefined
      return await response.json()
    } catch {
      return undefined
    }
  }

  private async loadModels(): Promise<ProviderModel[]> {
    const credential = await this.credential()
    const now = Date.now()
    const gateway = await this.signedGet(credential, CODEARTS_GATEWAY_CONFIG_URL)
    const builtin = await this.signedGet(credential, `${CODEARTS_SNAP_BASE}${CODEARTS_MODEL_BUILTIN_PATH}`)

    const gatewayRows = parseCodeArtsRoster(record(record(gateway)?.result)?.models, now)
    const builtinRows = parseCodeArtsRoster(record(builtin)?.builtinModels, now)
    if (gatewayRows.length === 0 && builtinRows.length === 0) {
      throw new Error('CodeArts 没有返回任何模型（签名、凭据或网关异常）')
    }

    // The benefit set decides whether a request must carry `maas_type`. Only
    // ids that survive normalization unchanged are recorded, because the
    // suffixed spelling is a different (non-benefit) registration upstream.
    if (gatewayRows.length > 0) {
      this.benefitModels = new Set(gatewayRows.map(row => row.id))
    }

    const textOnly = this.options.textOnly()
    const forceVision = this.options.forceVision()
    const rows: ProviderModel[] = []
    const seen = new Set<string>()
    for (const row of [...gatewayRows, ...builtinRows]) {
      const key = row.id.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      const vision = textOnly.has(row.id) ? false : forceVision.has(row.id) || isVisionModel(row.id)
      const factor = priceFactorOfLabel(row.rateLabel)
      rows.push({
        id: row.id,
        name: row.name,
        contextWindow: codeartsContextWindow(row.id),
        maxTokens: CODEARTS_MAX_OUTPUT_TOKENS,
        vision,
        reasoning: true,
        reasoningEfforts: CODEARTS_EFFORTS,
        defaultReasoningEffort: CODEARTS_DEFAULT_EFFORT,
        ...factor === undefined ? {} : { priceFactor: factor },
      })
    }
    return rows
  }

  /** Whether this model must be called with `maas_type: benefit`. */
  isBenefitModel(model: string): boolean {
    const key = model.trim().toLowerCase()
    // A rejection is remembered: the header costs a chat slot even when the
    // gateway answers `InferHub.4004.200`, so guessing again every turn would
    // spend a third of the minute's budget on a call that cannot succeed.
    if (this.noBenefit.has(key)) return false
    for (const id of this.benefitModels) {
      if (id.toLowerCase() === key) return true
    }
    return false
  }

  /** Load the persisted "no allowance pack" verdicts once. */
  private async loadNoBenefit(): Promise<void> {
    if (this.noBenefitLoaded) return
    this.noBenefitLoaded = true
    const stored = await this.options.store.codearts()
    for (const id of stored?.noBenefit ?? []) this.noBenefit.add(id.trim().toLowerCase())
  }

  private async rememberNoBenefit(model: string): Promise<void> {
    const key = model.trim().toLowerCase()
    this.noBenefit.add(key)
    try {
      const stored = await this.options.store.codearts()
      if (stored === undefined) return
      const known = new Set((stored.noBenefit ?? []).map(id => id.toLowerCase()))
      if (known.has(key)) return
      await this.options.store.saveCodearts({ ...stored, noBenefit: [...known, key] })
    } catch {
      // Persisting is an optimisation; the in-memory verdict already helps.
    }
  }

  // ------------------------------------------------------------------ quota

  async quota(fresh = false): Promise<QuotaSnapshot> {
    if (!fresh && this.quotaSnapshot !== undefined && Date.now() - this.quotaSnapshot.at < this.options.ttlMs()) {
      return this.quotaSnapshot.value
    }
    if (this.quotaInflight !== undefined) return this.quotaInflight
    this.quotaInflight = (async () => {
      try {
        const value = await this.readQuota()
        this.quotaSnapshot = { value, at: Date.now() }
        return value
      } finally {
        this.quotaInflight = undefined
      }
    })()
    return this.quotaInflight
  }

  invalidateQuota(): void {
    this.quotaSnapshot = undefined
  }

  private async readQuota(): Promise<QuotaSnapshot> {
    const credential = await this.credential()
    const payload = record(await this.signedGet(credential, `${CODEARTS_SNAP_BASE}${CODEARTS_PACKAGE_INFO_PATH}`))
    if (payload === undefined) throw new Error('CodeArts 没有返回账户信息')
    const info = parseCodeArtsPackage(payload)
    return {
      ...info.credit.total === undefined ? {} : { total: info.credit.total },
      ...info.packageName === '' ? {} : { plan: info.packageName },
      ...info.credit.packs.length === 0 ? {} : { packs: info.credit.packs },
      at: Date.now(),
    }
  }

  // ----------------------------------------------------------------- check-in

  async checkinStatus(): Promise<CheckinStatus> {
    const credential = await this.credential()
    const info = await this.accountInfo(credential)
    if (info === undefined) return { available: false, claimed: false, deviceClaimed: false, message: '账户信息读取失败' }
    if (!info.isCreditPackage) {
      return { available: false, claimed: false, deviceClaimed: false, message: '非积分计费账户，没有签到活动' }
    }
    const activities = await this.activities(credential)
    if (activities === undefined) {
      return { available: false, claimed: false, deviceClaimed: false, message: '活动列表读取失败' }
    }
    const activity = activities.find(entry => entry.type === CODEARTS_DAILY_LOGIN_TYPE)
    if (activity === undefined) {
      return { available: false, claimed: false, deviceClaimed: false, message: '当前账号没有每日签到活动' }
    }
    const claimed = !activity.claimable && CODEARTS_CLAIMED_STATUSES.includes(activity.status)
    return {
      available: true,
      claimed,
      deviceClaimed: false,
      ...activity.amount > 0 ? { reward: activity.amount } : {},
      ...claimed ? { message: '今天已领取' } : {},
    }
  }

  async claimCheckin(): Promise<CheckinStatus> {
    const before = await this.checkinStatus()
    if (!before.available) throw new Error(before.message ?? '没有可领取的签到活动')
    if (before.claimed) return before

    const credential = await this.credential()
    const activities = await this.activities(credential)
    const activity = activities?.find(entry => entry.type === CODEARTS_DAILY_LOGIN_TYPE)
    if (activity === undefined) throw new Error('没有找到每日签到活动')
    if (!activity.claimable) {
      return { ...before, claimed: CODEARTS_CLAIMED_STATUSES.includes(activity.status), message: `当前不可领取（${activity.status}）` }
    }

    const claimed = await this.signedPost(credential, `${CODEARTS_SNAP_BASE}${CODEARTS_OPS_CLAIM_PATH}`, {
      campaignId: activity.campaignId,
      channel: CODEARTS_OPS_CHANNEL,
    })
    if (claimed === undefined) throw new Error('领取失败，请稍后再试')
    // The IDE confirms the delivery when the claim answers with an id; skipping
    // it leaves the credits pending instead of booked.
    if (claimed.id !== null && claimed.id !== undefined) {
      await this.signedPost(credential, `${CODEARTS_SNAP_BASE}${CODEARTS_OPS_CONFIRM_PATH}`, {
        campaignId: activity.campaignId,
      })
    }
    this.invalidateQuota()
    // The claim answers with the delivered amount (`totalAmount`), not the
    // campaign's advertised `benefitAmount`; the activity is the fallback.
    const reward = num(claimed.totalAmount)
      ?? num(claimed.benefitAmount)
      ?? num(claimed.credit)
      ?? num(claimed.creditAmount)
      ?? activity.amount
    return {
      available: true,
      claimed: true,
      deviceClaimed: false,
      ...reward > 0 ? { reward } : {},
    }
  }

  private async signedPost(
    credential: CodeArtsCredential,
    url: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown> | undefined> {
    const payload = JSON.stringify(body)
    const signed = await signRequestHuawei(
      credential.accessKeyId,
      credential.secretAccessKey,
      credential.securityToken,
      'POST',
      url,
      payload,
    )
    try {
      const response = await this.fetcher(url, {
        method: 'POST',
        headers: { ...headersForFetch(signed), ...CODEARTS_EXTRA_HEADERS, accept: 'application/json' },
        body: payload,
        signal: AbortSignal.timeout(this.options.timeoutMs()),
      })
      if (!response.ok) return undefined
      return unwrapEnvelope(record(await response.json()))
    } catch {
      return undefined
    }
  }

  private async accountInfo(credential: CodeArtsCredential): Promise<ReturnType<typeof parseCodeArtsPackage> | undefined> {
    const payload = record(await this.signedGet(credential, `${CODEARTS_SNAP_BASE}${CODEARTS_PACKAGE_INFO_PATH}`))
    return payload === undefined ? undefined : parseCodeArtsPackage(payload)
  }

  private async activities(credential: CodeArtsCredential): Promise<CodeArtsActivity[] | undefined> {
    const url = `${CODEARTS_SNAP_BASE}${CODEARTS_OPS_DELIVERY_PATH}?channel=${CODEARTS_OPS_CHANNEL}`
    // The ops endpoints answer `{code, message, data}`; the catalogue and the
    // statistics endpoint do not, so only this call unwraps.
    const payload = unwrapEnvelope(record(await this.signedGet(credential, url)))
    const items = payload?.items
    if (!Array.isArray(items)) return undefined
    return items.map((item) => {
      const entry = record(item) ?? {}
      return {
        campaignId: String(entry.campaignId ?? ''),
        type: text(entry.type) ?? '',
        claimable: entry.claimable === true || String(entry.claimable).toLowerCase() === 'true',
        status: text(entry.status) ?? '',
        amount: num(entry.benefitAmount) ?? num(entry.amount) ?? num(entry.creditAmount) ?? 0,
      }
    })
  }

  // ------------------------------------------------------------------ stream

  async *stream(
    options: GenerateOptions,
    model: string,
    readImage: ReadImage | undefined,
    onInvalidate: () => void,
  ): AsyncGenerator<StreamChunk> {
    const messages = await buildMessages(options, readImage)
    const tools = buildTools(options)
    const thinkingOff = options.reasoningEffort === 'off' || options.reasoningEffort === 'none'
    const chatId = randomUUID()
    const body = {
      model,
      messages,
      stream: true,
      // Enables prefix caching; without it the gateway reports no cached tokens.
      prompt_cache_key: this.sessionId,
      include: ['reasoning.encrypted_content'],
      reasoning_summary: 'auto',
      // The gateway's own switch is `thinking`, not `reasoning_effort`: the
      // levels are a single on/off pair. `enabled` is the default, so it is only
      // sent when the user turns thinking off.
      ...thinkingOff ? { thinking: { type: 'disabled' } } : {},
      // Streams oversized tool arguments in fragments; without it a big file
      // write arrives as one event the gateway cuts off.
      tool_stream: true,
      max_tokens: clampMaxTokens(options.maxTokens),
      ...tools === undefined || tools.length === 0 ? {} : { tools },
    }
    const payload = JSON.stringify(body)

    await this.loadNoBenefit()
    let authRefreshed = false
    let benefitDropped = false
    let queueAttempts = 0
    for (;;) {
      // The plan allows three sessions a minute for the whole account, and a
      // rejected call spends one just like a served one. Wait for a slot here
      // instead of firing into `TM.00001041` and hoping a retry lands later.
      const slot = await this.window.open(options.signal)
      let response: Response
      try {
        response = await this.send(chatId, payload, model, benefitDropped, options.signal)
      } catch (error) {
        if (error instanceof CodeArtsRetry) {
          if (error.kind === 'auth' && !authRefreshed) {
            authRefreshed = true
            await this.options.auth.refresh(true)
            continue
          }
          if (error.kind === 'benefit' && !benefitDropped) {
            benefitDropped = true
            await this.rememberNoBenefit(model)
            continue
          }
          if (error.kind === 'queue' && queueAttempts < QUEUE_ATTEMPTS) {
            queueAttempts++
            slot.release()
            await sleep(Math.max(this.window.waitMs(), QUEUE_BACKOFF_MS), options.signal)
            continue
          }
          if (error.kind === 'queue') throw queueExhausted()
        }
        throw error
      }

      let produced = false
      try {
        for await (const chunk of consumeOpenAiStream(response, {
          ...options.signal === undefined ? {} : { signal: options.signal },
          onFrame: (frame) => {
            const code = text(frame.error_code)
            if (code === undefined) return
            const message = text(frame.error_msg) ?? code
            if (QUEUE_MARKERS.some(marker => code.includes(marker))) {
              throw new CodeArtsRetry('queue', message)
            }
            if (code.includes('InferHub.4004.200')) throw new CodeArtsRetry('benefit', message)
            throw new ProviderHttpError(message, 502)
          },
        })) {
          produced = true
          yield chunk
        }
        return
      } catch (error) {
        // A queue rejection can arrive as the first SSE frame. Retrying is only
        // safe while nothing has been emitted, or the answer would repeat.
        if (!produced && error instanceof CodeArtsRetry && error.kind === 'queue' && queueAttempts < QUEUE_ATTEMPTS) {
          queueAttempts++
          slot.release()
          await sleep(Math.max(this.window.waitMs(), QUEUE_BACKOFF_MS), options.signal)
          continue
        }
        if (error instanceof CodeArtsRetry && error.kind === 'queue') throw queueExhausted()
        // The same applies to an account without a benefit pack: the gateway
        // answers HTTP 200 and puts `InferHub.4004.200` in the first frame, so
        // the drop-the-header retry has to happen here, not only in `send`.
        if (!produced && error instanceof CodeArtsRetry && error.kind === 'benefit' && !benefitDropped) {
          benefitDropped = true
          await this.rememberNoBenefit(model)
          continue
        }
        if (error instanceof CodeArtsRetry && error.kind === 'auth') {
          onInvalidate()
          throw new Error('CodeArts 登录已失效，请在设置页重新登录。')
        }
        throw error
      }
    }
  }

  private async send(
    chatId: string,
    payload: string,
    model: string,
    benefitDropped: boolean,
    signal: AbortSignal | undefined,
  ): Promise<Response> {
    const credential = await this.credential()
    const benefit = !benefitDropped && this.isBenefitModel(model)
    const signed = await signRequestHuawei(
      credential.accessKeyId,
      credential.secretAccessKey,
      credential.securityToken,
      'POST',
      CODEARTS_CHAT_URL,
      payload,
      // `maas_type` participates in the signature; sending it unsigned (or
      // omitting it from SignedHeaders) is rejected by the gateway.
      benefit ? { maas_type: 'benefit' } : undefined,
    )
    const headers: Record<string, string> = {
      ...headersForFetch(signed),
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'chat-id': chatId,
      'session-id': this.sessionId,
      lang: 'en',
    }
    const timeout = AbortSignal.timeout(Math.max(this.options.timeoutMs(), 60_000))
    const response = await this.fetcher(CODEARTS_CHAT_URL, {
      method: 'POST',
      headers,
      body: payload,
      signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
    })
    if (response.ok) return response
    const text = await response.text().catch(() => '')
    throw classifyFailure(response.status, text)
  }

  // -------------------------------------------------------------- account

  async status(): Promise<AuthStatus> {
    return this.options.auth.status()
  }

  async signedIn(): Promise<boolean> {
    return (await this.options.auth.status()).signedIn
  }

  async startBrowserLogin(): Promise<LoginStatus> {
    return this.login.start()
  }

  browserLoginStatus(): LoginStatus {
    return this.login.status()
  }

  async cancelBrowserLogin(): Promise<void> {
    await this.login.cancel()
  }

  async logoutAccount(): Promise<void> {
    await this.options.auth.logout()
    this.window.reset()
    this.invalidateModels()
    this.invalidateQuota()
  }

  close(): void {
    void this.login.close()
  }
}

/** Cap `max_tokens` at the gateway's limit; a larger value is a hard 4xx. */
export function clampMaxTokens(value: number | undefined): number {
  const fallback = CODEARTS_MAX_OUTPUT_TOKENS
  if (value === undefined) return fallback
  const integer = Math.floor(value)
  if (!Number.isFinite(integer) || integer <= 0) return fallback
  return Math.min(integer, CODEARTS_MAX_OUTPUT_TOKENS)
}

export interface CodeArtsActivity {
  campaignId: string
  type: string
  claimable: boolean
  status: string
  amount: number
}

export interface CodeArtsPackageInfo {
  isCreditPackage: boolean
  packageName: string
  packageStatus: string
  credit: { total?: number, packs: QuotaPack[] }
}

/**
 * Parse `snap-manager/v1/statistics/plugin`.
 *
 * The total row is a summary of the three category rows, so it is never also
 * listed as a pack — summing both would double every credit. Only the basic
 * pack gets a real expiry (the subscription's `end_date`); the bonus and
 * on-demand packs have no per-pack date, and borrowing the subscription date
 * for them would claim credits expire when they do not.
 */
export function parseCodeArtsPackage(payload: Record<string, unknown>): CodeArtsPackageInfo {
  const pkg = record(payload.package) ?? {}
  const endDate = text(payload.end_date)
  const endMs = endDate === undefined ? undefined : Date.parse(endDate)
  const labels: Record<string, string> = {
    usageBasicPackageCredit: '基础积分包',
    usageOnDemandPackageCredit: '按需积分包',
    usageBonusPackageCredit: '赠送积分包',
  }
  const packs: QuotaPack[] = []
  let totalRemain: number | undefined
  let sawCredit = false
  for (const item of Array.isArray(payload.metrics) ? payload.metrics : []) {
    const metric = record(item)
    if (metric === undefined) continue
    const name = text(metric.name) ?? ''
    const amount = num(metric.package_credit_amount) ?? 0
    const used = num(metric.package_credit_used) ?? 0
    const remain = num(metric.package_credit_remain) ?? 0
    if (name === 'usageTotalPackageCredit') {
      sawCredit = true
      totalRemain = remain
      continue
    }
    const label = labels[name]
    if (label === undefined) continue
    sawCredit = true
    if (amount <= 0 && remain <= 0) continue
    const expiresAt = name === 'usageBasicPackageCredit' && endMs !== undefined && !Number.isNaN(endMs)
      ? endMs
      : undefined
    packs.push({ label, total: amount, used, ...expiresAt === undefined ? {} : { expiresAt } })
  }
  return {
    isCreditPackage: pkg.is_credit_package === true || String(pkg.is_credit_package).toLowerCase() === 'true',
    packageName: text(pkg.package_name_cn) ?? text(pkg.package_name_en) ?? '',
    packageStatus: text(pkg.status) ?? '',
    credit: {
      ...sawCredit ? { total: totalRemain ?? packs.reduce((sum, pack) => sum + (pack.total ?? 0) - (pack.used ?? 0), 0) } : {},
      packs,
    },
  }
}
