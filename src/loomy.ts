/**
 * Loomy (iFlytek) gateway client.
 *
 * The gateway is OpenAI-compatible but requires client tracing headers on every
 * call; without `traceparent` it accepts the connection and then never
 * answers. The session comes from the desktop client's auth file and cannot be
 * refreshed, so an expired session is a user-visible login action.
 *
 * @module dsh-llm-adapters/loomy
 */

import { randomBytes, randomUUID } from 'node:crypto'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { AccountStore } from './account-store.ts'
import { LoomyAuth } from './auth.ts'
import { parseLoomyCatalog, ModelCatalog } from './catalog.ts'
import type { ProviderModel } from './catalog.ts'
import { fetchJson } from './http.ts'
import {
  LOOMY_SESSION_TTL_MS, loomyAccountName, loomyLoginWithPassword, loomyLoginWithSms, loomySendSmsCode,
} from './login.ts'
import type { QuotaSnapshot } from './types.ts'
import { ProviderHttpError, buildBody, buildMessages, buildTools, openAiStream } from './wire.ts'
import type { ReadImage } from './wire.ts'

export const LOOMY_BASE = 'https://loomyad.xunfei.cn/api/v1'
export const LOOMY_VERSION = '0.9.38'

export interface LoomyProviderOptions {
  auth: LoomyAuth
  store: AccountStore
  ttlMs: () => number
  timeoutMs: () => number
  textOnly: () => ReadonlySet<string>
  forceVision: () => ReadonlySet<string>
  fetchImpl?: typeof fetch
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

  constructor(private readonly options: LoomyProviderOptions) {
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

  /**
   * Sign in through the account service and keep the session in the plugin
   * store. The password is encrypted for transit and never persisted.
   */
  async loginWithPassword(phone: string, password: string): Promise<void> {
    const deviceId = await this.options.store.loomyDeviceId()
    const result = await loomyLoginWithPassword({
      phone,
      password,
      deviceId,
      fetchImpl: this.options.fetchImpl,
    })
    const name = await loomyAccountName({
      session: result.session,
      deviceId,
      fetchImpl: this.options.fetchImpl,
    })
    const now = Date.now()
    await this.options.store.saveLoomy({
      session: result.session,
      deviceId,
      loginAt: now,
      expiresAt: now + LOOMY_SESSION_TTL_MS,
      ...result.userId === undefined ? {} : { userId: result.userId },
      ...result.phone === undefined ? { phone } : { phone: result.phone },
      ...name === undefined ? {} : { name },
    })
    this.invalidateModels()
    this.invalidateQuota()
  }

  async sendSmsCode(phone: string): Promise<{ msgid: string }> {
    const deviceId = await this.options.store.loomyDeviceId()
    return loomySendSmsCode({ phone, deviceId, fetchImpl: this.options.fetchImpl })
  }

  async loginWithSms(phone: string, code: string, msgid: string): Promise<void> {
    const deviceId = await this.options.store.loomyDeviceId()
    const result = await loomyLoginWithSms({ phone, code, msgid, deviceId, fetchImpl: this.options.fetchImpl })
    const name = await loomyAccountName({
      session: result.session,
      deviceId,
      fetchImpl: this.options.fetchImpl,
    })
    const now = Date.now()
    await this.options.store.saveLoomy({
      session: result.session,
      deviceId,
      loginAt: now,
      expiresAt: now + LOOMY_SESSION_TTL_MS,
      ...result.userId === undefined ? {} : { userId: result.userId },
      ...result.phone === undefined ? { phone } : { phone: result.phone },
      ...name === undefined ? {} : { name },
    })
    this.invalidateModels()
    this.invalidateQuota()
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
    throw new Error(status.error ?? 'Loomy 尚未登录。请先启动 Loomy 客户端并完成登录。')
  }

  private async fetchModels(): Promise<ProviderModel[]> {
    const session = await this.session()
    const payload = await fetchJson<unknown>(`${LOOMY_BASE}/models`, {
      headers: {
        ...tracingHeaders(session, { model: '', provider: '', messages: [] }, 'system'),
        accept: 'application/json',
      },
      timeoutMs: this.options.timeoutMs(),
      fetchImpl: this.options.fetchImpl,
    })
    const models = parseLoomyCatalog(payload, {
      textOnly: this.options.textOnly(),
      forceVision: this.options.forceVision(),
    })
    if (models.length === 0) throw new Error('Loomy 返回的模型目录为空。')
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
        throw new Error('Loomy 登录态已失效。请打开 Loomy 客户端重新登录，然后在设置页点“重新读取登录态”。')
      }
      throw error
    }
  }
}
