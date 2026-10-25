/**
 * SenseTime Raccoon (小浣熊) gateway client.
 *
 * The gateway is OpenAI-compatible and authenticates with an OAuth access
 * token. Tokens rotate on refresh; {@link RaccoonAuth} writes the rotated pair
 * back to whichever store supplied them.
 *
 * @module dsh-llm-adapters/raccoon
 */

import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { AccountStore } from './account-store.ts'
import { RaccoonAuth } from './auth.ts'
import { RaccoonQrLogin } from './raccoon-login.ts'
import type { LoginStatus } from './login-page.ts'
import { ModelCatalog, parseRaccoonCatalog } from './catalog.ts'
import type { ProviderModel } from './catalog.ts'
import { fetchJson } from './http.ts'
import type { QuotaSnapshot } from './types.ts'
import { ProviderHttpError, buildBody, buildMessages, buildTools, openAiStream } from './wire.ts'
import type { ReadImage } from './wire.ts'

export const RACCOON_BASE = 'https://xiaohuanxiong.com/api/web'
export const RACCOON_CLIENT_VERSION = '1.0.0'

export interface RaccoonProviderOptions {
  auth: RaccoonAuth
  store: AccountStore
  ttlMs: () => number
  timeoutMs: () => number
  textOnly: () => ReadonlySet<string>
  forceVision: () => ReadonlySet<string>
  fetchImpl?: typeof fetch
}

function numeric(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value.trim())) return Number(value)
  return undefined
}

function messageOf(payload: unknown): string | undefined {
  if (payload === null || typeof payload !== 'object') return undefined
  const record = payload as Record<string, unknown>
  return typeof record.message === 'string' && record.message.length > 0 ? record.message : undefined
}

function raccoonHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    'x-org-code': '',
    'x-raccoon-language': 'zh-CN',
    'x-client-platform': 'desktop',
    'x-client-version': RACCOON_CLIENT_VERSION,
  }
}

/** Whether the gateway accepts a token harvested from the browser. */
export async function raccoonAccessTokenValid(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const response = await fetchImpl(`${RACCOON_BASE}/llm/v2/model_catalog`, {
      headers: { ...raccoonHeaders(token), accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) return false
    const payload: unknown = JSON.parse(await response.text())
    if (payload === null || typeof payload !== 'object') return false
    const record = payload as Record<string, unknown>
    if (typeof record.code === 'number' && record.code !== 0) return false
    const data = record.data !== null && typeof record.data === 'object'
      ? record.data as Record<string, unknown>
      : undefined
    return Array.isArray(data?.categories)
  } catch {
    return false
  }
}

function jwtExpiry(token: string): number | undefined {
  const parts = token.split('.')
  if (parts.length < 2) return undefined
  try {
    const base64 = parts[1]!.replace(/-/g, '+').replace(/_/g, '/')
    const padded = base64 + '='.repeat((4 - base64.length % 4) % 4)
    const payload: unknown = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'))
    if (payload === null || typeof payload !== 'object') return undefined
    const exp = (payload as Record<string, unknown>).exp
    return typeof exp === 'number' && Number.isFinite(exp) ? exp : undefined
  } catch {
    return undefined
  }
}

/**
 * Among the tokens a browser login leaves behind, the refresh token is the
 * other JWT with the furthest expiry; the access token itself is excluded.
 */
export function raccoonRefreshCandidate(tokens: readonly string[], accessToken: string): string | undefined {
  let best: { token: string, expiry: number } | undefined
  for (const token of tokens) {
    if (token === accessToken) continue
    const expiry = jwtExpiry(token)
    if (expiry === undefined) continue
    if (best === undefined || expiry > best.expiry) best = { token, expiry }
  }
  return best?.token
}

export class RaccoonProvider {
  readonly catalog: ModelCatalog
  private quotaCache: { at: number, value: QuotaSnapshot } | undefined
  private quotaInflight: Promise<QuotaSnapshot> | undefined
  private loginFlow: RaccoonQrLogin | undefined

  constructor(private readonly options: RaccoonProviderOptions) {
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

  private login(): RaccoonQrLogin {
    if (this.loginFlow !== undefined) return this.loginFlow
    this.loginFlow = new RaccoonQrLogin({
      fetchImpl: this.options.fetchImpl ?? fetch,
      save: async account => {
        await this.options.store.saveRaccoon({
          accessToken: account.token,
          loginAt: Date.now(),
          ...(account.refreshToken === undefined ? {} : { refreshToken: account.refreshToken }),
          ...(account.phone === undefined ? {} : { phone: account.phone }),
          ...(account.name === undefined ? {} : { name: account.name }),
          ...(account.ownerType === undefined ? {} : { ownerType: account.ownerType }),
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

  private headers(token: string): Record<string, string> {
    return raccoonHeaders(token)
  }

  /** Run one JSON call, refreshing once when the gateway rejects the token. */
  private async authorizedJson<T>(path: string, init: { method?: string, body?: unknown } = {}): Promise<T> {
    let token = await this.options.auth.accessToken()
    try {
      return await fetchJson<T>(`${RACCOON_BASE}${path}`, {
        ...init,
        headers: this.headers(token),
        timeoutMs: this.options.timeoutMs(),
        fetchImpl: this.options.fetchImpl,
      })
    } catch (error) {
      if (!(error instanceof ProviderHttpError) || error.status !== 401) throw error
      token = await this.options.auth.accessToken(true)
      try {
        return await fetchJson<T>(`${RACCOON_BASE}${path}`, {
          ...init,
          headers: this.headers(token),
          timeoutMs: this.options.timeoutMs(),
          fetchImpl: this.options.fetchImpl,
        })
      } catch (retryError) {
        if (retryError instanceof ProviderHttpError && retryError.status === 401) {
          this.invalidateModels()
          this.invalidateQuota()
          throw new Error('小浣熊登录态被上游拒绝。请在设置页重新登录，或打开小浣熊桌面端重新登录。')
        }
        throw retryError
      }
    }
  }

  private async fetchModels(): Promise<ProviderModel[]> {
    const payload = await this.authorizedJson<unknown>('/llm/v2/model_catalog')
    if (payload !== null && typeof payload === 'object') {
      const code = (payload as Record<string, unknown>).code
      if (typeof code === 'number' && code !== 0) {
        throw new Error(messageOf(payload) ?? `小浣熊模型目录返回 code=${code}`)
      }
    }
    const models = parseRaccoonCatalog(payload, {
      textOnly: this.options.textOnly(),
      forceVision: this.options.forceVision(),
    })
    if (models.length === 0) throw new Error('小浣熊返回的模型目录为空。')
    return models
  }

  async models(fresh = false): Promise<readonly ProviderModel[]> {
    return this.catalog.models(fresh)
  }

  catalogError(): string | undefined {
    return this.catalog.error()
  }

  invalidateModels(): void {
    this.catalog.invalidate()
  }

  async quota(fresh = false): Promise<QuotaSnapshot> {
    if (!fresh && this.quotaCache !== undefined && Date.now() - this.quotaCache.at < 60_000) {
      return this.quotaCache.value
    }
    if (this.quotaInflight !== undefined) return this.quotaInflight
    this.quotaInflight = (async () => {
      try {
        const payload = await this.authorizedJson<unknown>('/points/v1/balance')
        const root = payload !== null && typeof payload === 'object' ? payload as Record<string, unknown> : {}
        if (typeof root.code === 'number' && root.code !== 0) {
          throw new Error(messageOf(payload) ?? `小浣熊额度接口返回 code=${root.code}`)
        }
        const data = root.data !== null && typeof root.data === 'object'
          ? root.data as Record<string, unknown>
          : root
        const total = numeric(data.total) ?? numeric(data.balance) ?? numeric(data.points)
        if (total === undefined) throw new Error('小浣熊额度响应格式无法识别。')
        const snapshot: QuotaSnapshot = { at: Date.now(), total }
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
    let token = await this.options.auth.accessToken()
    const messages = await buildMessages(options, readImage)
    const tools = buildTools(options)
    const body = buildBody(options, model, messages, tools)
    for (let attempt = 0; attempt < 2; attempt++) {
      let emitted = false
      try {
        for await (const chunk of openAiStream({
          url: `${RACCOON_BASE}/llm/v2/chat/completions`,
          headers: this.headers(token),
          body,
          signal: options.signal,
          fetchImpl: this.options.fetchImpl,
          onUnauthorized: () => {
            this.invalidateModels()
            this.invalidateQuota()
            onUnauthorized?.()
          },
        })) {
          emitted = true
          yield chunk
        }
        return
      } catch (error) {
        // The token can expire between the local expiry check and the wire
        // request. Retry once with a rotated token, but never after any byte
        // reached the caller: a second stream would duplicate the answer.
        if (!emitted && attempt === 0 && error instanceof ProviderHttpError
          && (error.status === 401 || error.status === 403)) {
          token = await this.options.auth.accessToken(true)
          continue
        }
        if (error instanceof ProviderHttpError && (error.status === 401 || error.status === 403)) {
          throw new Error('小浣熊登录态被上游拒绝。请在设置页重新登录，或打开小浣熊桌面端重新登录后再点“重新读取登录态”。')
        }
        throw error
      }
    }
  }
}
