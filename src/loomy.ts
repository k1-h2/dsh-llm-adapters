/**
 * Loomy (iFlytek) gateway client.
 *
 * The gateway is OpenAI-compatible but requires client tracing headers on every
 * call; without `traceparent` it accepts the connection and then never
 * answers. The session comes from the plugin's QR login and cannot be
 * refreshed, so an expired session is a user-visible login action.
 *
 * @module dsh-llm-adapters/loomy
 */

import { randomBytes, randomUUID } from 'node:crypto'
import { attributionHeaders } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { AccountStore } from './account-store.ts'
import { LoomyAuth } from './auth.ts'
import { LoomyQrLogin } from './loomy-login.ts'
import type { LoginStatus } from './login-page.ts'
import { parseLoomyCatalog, ModelCatalog } from './catalog.ts'
import type { ProviderModel } from './catalog.ts'
import { fetchJson } from './http.ts'
import { OpenRouterCatalog } from './openrouter.ts'
import type { OpenRouterLookup } from './openrouter.ts'
import type { QuotaSnapshot } from './types.ts'
import { ProviderHttpError, buildBody, buildMessages, buildTools, openAiStream } from './wire.ts'
import type { ReadImage } from './wire.ts'

export const LOOMY_BASE = 'https://loomyad.xunfei.cn/api/v1'
export const LOOMY_VERSION = '0.9.38'
/** Session lifetime the Loomy client itself requests (14 days). */
export const LOOMY_SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1_000

export interface LoomyProviderOptions {
  auth: LoomyAuth
  store: AccountStore
  ttlMs: () => number
  timeoutMs: () => number
  textOnly: () => ReadonlySet<string>
  forceVision: () => ReadonlySet<string>
  fetchImpl?: typeof fetch
  /** Injectable OpenRouter lookup for tests; defaults to the live catalog. */
  openRouter?: OpenRouterLookup
}

function traceparent(): string {
  return `00-${randomBytes(16).toString('hex')}-${randomBytes(8).toString('hex')}-01`
}

function sessionChatId(options: GenerateOptions): string {
  if (options.sessionId === undefined) return `chat-${randomUUID()}`
  const cleaned = String(options.sessionId).replace(/[^a-zA-Z0-9-]/g, '').slice(-36)
  return `chat-${cleaned.length > 0 ? cleaned : randomUUID()}`
}

function tracingHeaders(session: string, options: GenerateOptions, origin: 'user' | 'system'): Record<string, string> {
  return {
    authorization: `Bearer ${session}`,
    token: session,
    'loomy-version': LOOMY_VERSION,
    chatid: sessionChatId(options),
    msgid: `msg-${randomUUID()}`,
    invokeorigin: origin,
    traceparent: traceparent(),
  }
}

/**
 * Whether the model gateway accepts a browser-obtained session.
 *
 * A web login can yield a session cookie that the web app itself uses; this
 * probe is what decides whether that same value also works as a gateway
 * credential. The gateway answers 200 with a JSON error code for a bad token,
 * so HTTP status alone is not enough.
 */
export async function loomyGatewaySessionValid(
  session: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const response = await fetchImpl(`${LOOMY_BASE}/models`, {
      headers: {
        ...attributionHeaders(),
        accept: 'application/json',
        ...tracingHeaders(session, { model: '', provider: '', messages: [] }, 'system'),
      },
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) return false
    const payload: unknown = JSON.parse(await response.text())
    const root = payload !== null && typeof payload === 'object' && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : undefined
    const data = root?.data !== null && typeof root?.data === 'object'
      ? root.data as Record<string, unknown>
      : undefined
    if (Array.isArray(payload)) return true
    if (Array.isArray(root?.data)) return true
    if (Array.isArray(root?.models)) return true
    return Array.isArray(data?.models)
  } catch {
    return false
  }
}

function numeric(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value.trim())) return Number(value)
  return undefined
}

/** Find the balance record without depending on one response envelope. */
function findBalance(value: unknown, depth = 0): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || depth > 4) return undefined
  const record = value as Record<string, unknown>
  if (numeric(record.balance) !== undefined
    || numeric(record.availableBalance) !== undefined
    || numeric(record.dailyBalance) !== undefined) return record
  for (const nested of Object.values(record)) {
    const found = findBalance(nested, depth + 1)
    if (found !== undefined) return found
  }
  return undefined
}

export class LoomyProvider {
  readonly catalog: ModelCatalog
  private quotaCache: { at: number, value: QuotaSnapshot } | undefined
  private quotaInflight: Promise<QuotaSnapshot> | undefined
  private loginFlow: LoomyQrLogin | undefined
  private readonly openRouter: OpenRouterLookup

  constructor(private readonly options: LoomyProviderOptions) {
    this.openRouter = options.openRouter ?? new OpenRouterCatalog(options.fetchImpl ?? fetch)
    this.catalog = new ModelCatalog(
      () => this.fetchModels(),
      options.ttlMs,
    )
  }

  async status() {
    return this.options.auth.status()
  }

  async signedIn(): Promise<boolean> {
    return (await this.options.auth.status()).signedIn
  }

  /** Start the local WeChat QR page; the settings page opens the returned URL. */
  async startBrowserLogin(): Promise<LoginStatus> {
    return this.login().start()
  }

  browserLoginStatus(): LoginStatus {
    return this.loginFlow?.status() ?? { running: false, phase: 'idle' }
  }

  async cancelBrowserLogin(): Promise<void> {
    await this.loginFlow?.cancel()
  }

  /** Stop a login page that outlived the plugin. */
  close(): void {
    void this.loginFlow?.cancel()
  }

  private login(): LoomyQrLogin {
    if (this.loginFlow !== undefined) return this.loginFlow
    this.loginFlow = new LoomyQrLogin({
      fetchImpl: this.options.fetchImpl ?? fetch,
      save: async account => {
        const deviceId = await this.options.store.loomyDeviceId()
        const now = Date.now()
        await this.options.store.saveLoomy({
          session: account.token,
          deviceId,
          loginAt: now,
          expiresAt: now + LOOMY_SESSION_TTL_MS,
          ...(account.userId === undefined ? {} : { userId: account.userId }),
          ...(account.phone === undefined ? {} : { phone: account.phone }),
          ...(account.name === undefined ? {} : { name: account.name }),
        })
        this.invalidateModels()
        this.invalidateQuota()
      },
    })
    return this.loginFlow
  }

  async logoutAccount(): Promise<void> {
    await this.options.auth.logout()
    this.invalidateModels()
    this.invalidateQuota()
  }

  async session(): Promise<string> {
    const session = await this.options.auth.session()
    if (session !== undefined) return session
    const status = await this.options.auth.status()
    throw new Error(status.error ?? 'Loomy 尚未登录。请在设置页点「打开扫码登录」。')
  }

  private async fetchModels(): Promise<ProviderModel[]> {
    const session = await this.session()
    const [openRouter, payload] = await Promise.all([
      this.openRouter.models(),
      fetchJson<unknown>(`${LOOMY_BASE}/models`, {
        headers: {
          ...tracingHeaders(session, { model: '', provider: '', messages: [] }, 'system'),
          accept: 'application/json',
        },
        timeoutMs: this.options.timeoutMs(),
        fetchImpl: this.options.fetchImpl,
      }),
    ])
    const models = parseLoomyCatalog(payload, {
      textOnly: this.options.textOnly(),
      forceVision: this.options.forceVision(),
      openRouter,
    })
    if (models.length === 0) throw new Error('Loomy 返回的模型目录为空。')
    return models
  }

  async models(fresh = false): Promise<readonly ProviderModel[]> {
    if (fresh) this.openRouter.invalidate()
    return this.catalog.models(fresh)
  }

  catalogError(): string | undefined {
    return this.catalog.error()
  }

  invalidateModels(): void {
    this.openRouter.invalidate()
    this.catalog.invalidate()
  }

  async quota(fresh = false): Promise<QuotaSnapshot> {
    if (!fresh && this.quotaCache !== undefined && Date.now() - this.quotaCache.at < 60_000) {
      return this.quotaCache.value
    }
    if (this.quotaInflight !== undefined) return this.quotaInflight
    this.quotaInflight = (async () => {
      try {
        const session = await this.session()
        const payload = await fetchJson<unknown>(`${LOOMY_BASE}/points/records`, {
          headers: {
            ...tracingHeaders(session, { model: '', provider: '', messages: [] }, 'system'),
            accept: 'application/json',
          },
          timeoutMs: this.options.timeoutMs(),
          fetchImpl: this.options.fetchImpl,
        })
        const record = findBalance(payload)
        if (record === undefined) throw new Error('Loomy 额度响应格式无法识别。')
        const permanent = numeric(record.balance)
        const daily = numeric(record.dailyBalance)
        const available = numeric(record.availableBalance) ?? (permanent ?? 0) + (daily ?? 0)
        const cycle = typeof record.dailyCycleDate === 'string' ? record.dailyCycleDate : undefined
        const snapshot: QuotaSnapshot = {
          at: Date.now(),
          ...available === undefined ? {} : { available, total: available },
          ...permanent === undefined ? {} : { permanent },
          ...daily === undefined ? {} : { daily },
          ...cycle === undefined ? {} : { cycle },
        }
        this.quotaCache = { at: snapshot.at, value: snapshot }
        return snapshot
      } finally {
        this.quotaInflight = undefined
      }
    })()
    return this.quotaInflight
  }

  invalidateQuota(): void {
    this.quotaCache = undefined
  }

  async *stream(
    options: GenerateOptions,
    model: string,
    readImage: ReadImage | undefined,
    onUnauthorized?: () => void,
  ): AsyncGenerator<StreamChunk> {
    const session = await this.session()
    const messages = await buildMessages(options, readImage)
    const tools = buildTools(options)
    const body = buildBody(options, model, messages, tools)
    if (options.reasoningEffort !== undefined) body.reasoning_effort = options.reasoningEffort
    try {
      yield* openAiStream({
        url: `${LOOMY_BASE}/chat/completions`,
        headers: tracingHeaders(session, options, 'user'),
        body,
        signal: options.signal,
        fetchImpl: this.options.fetchImpl,
        onUnauthorized: () => {
          this.invalidateModels()
          this.invalidateQuota()
          onUnauthorized?.()
        },
      })
    } catch (error) {
      if (error instanceof ProviderHttpError && (error.status === 401 || error.status === 403)) {
        throw new Error('Loomy 登录态已失效。请在设置页点「打开扫码登录」重新扫码。')
      }
      throw error
    }
  }
}
