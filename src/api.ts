/**
 * Settings-page data source.
 *
 * Catalog and quota live behind an HTTP route because they come from the
 * upstream account, not from the stored config form. Writes still go through
 * the host's own `configForms` revision fence.
 *
 * @module dsh-llm-adapters/api
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { LocalAdapter } from './adapter.ts'
import type { BrandId } from './brand.ts'
import { isBrandId } from './brand.ts'
import { LoginError } from './login.ts'

export const API_PREFIX = '/api/llm-adapters'

export interface ModelRow {
  id: string
  name: string
  description?: string
  enabled: boolean
  vision: boolean
  contextWindow: number
  contextWindows: number[]
  defaultContextWindow: number
  override?: number
  priceFactor?: number
  badge?: string
  reasoning: boolean
}

export type AdapterMap = Readonly<Record<BrandId, LocalAdapter>>

function send(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

const WINDOW_CHOICES = [32_000, 64_000, 128_000, 200_000, 256_000, 400_000, 500_000, 1_000_000]

export async function buildRows(adapter: LocalAdapter): Promise<ModelRow[]> {
  const models = await adapter.describeCatalog()
  return models.map(model => {
    const override = adapter.contextWindowFor(model.id)
    const choices = new Set<number>([model.contextWindow])
    for (const choice of WINDOW_CHOICES) {
      if (choice < model.contextWindow) choices.add(choice)
    }
    if (override !== undefined) choices.add(override)
    return {
      id: model.id,
      name: model.name,
      ...model.description === undefined ? {} : { description: model.description },
      enabled: !adapter.isModelDisabled(model.id),
      vision: model.vision,
      contextWindow: override ?? model.contextWindow,
      contextWindows: [...choices].sort((a, b) => a - b),
      defaultContextWindow: model.contextWindow,
      ...override === undefined ? {} : { override },
      ...model.priceFactor === undefined ? {} : { priceFactor: model.priceFactor },
      ...model.badge === undefined ? {} : { badge: model.badge },
      reasoning: model.reasoning,
    }
  })
}

function brandFrom(value: unknown): BrandId | undefined {
  if (value === null || value === undefined || value === '') return undefined
  return isBrandId(value) ? value : undefined
}

/** Largest request body this route accepts; credentials are small. */
const MAX_BODY_BYTES = 4096

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const part of req) {
    const chunk = Buffer.isBuffer(part) ? part : Buffer.from(String(part))
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') throw new Error('缺少请求体')
  return JSON.parse(text)
}

/** Brute-force guard: failed attempts per provider in a rolling window. */
const MAX_LOGIN_FAILURES = 8
const FAILURE_WINDOW_MS = 5 * 60 * 1_000
const SMS_COOLDOWN_MS = 60_000
const loginFailures = new Map<BrandId, { at: number, count: number }>()
const smsSentAt = new Map<BrandId, number>()

interface AccountRequest {
  brand?: unknown
  action?: unknown
  phone?: unknown
  password?: unknown
  code?: unknown
  msgid?: unknown
}

function phoneFrom(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.replace(/\s+/g, '')
  return /^1[3-9]\d{9}$/.test(trimmed) ? trimmed : undefined
}

function failureCode(code: string | undefined): number {
  if (code === 'BAD_CREDENTIALS') return 401
  if (code === 'RATE_LIMIT') return 429
  if (code === 'NETWORK' || code === 'HTTP_502' || code === 'HTTP_504') return 502
  return 400
}

async function sendStatus(res: ServerResponse, brand: BrandId, adapter: LocalAdapter, fresh: boolean): Promise<void> {
  void brand
  send(res, 200, await adapter.usageInfo(fresh))
}

/** Account login, SMS sending, and sign-out; credentials travel in the body. */
async function handleAccount(req: IncomingMessage, res: ServerResponse, adapters: AdapterMap): Promise<void> {
  let body: AccountRequest
  try {
    body = ((await readJson(req)) ?? {}) as AccountRequest
  } catch (error) {
    send(res, 400, { error: `请求体无法解析：${error instanceof Error ? error.message : String(error)}` })
    return
  }
  const brand = brandFrom(body.brand)
  if (brand === undefined) {
    send(res, 400, { error: 'brand 只接受 loomy 或 raccoon' })
    return
  }
  const adapter = adapters[brand]
  const action = body.action

  if (action === 'logout') {
    await adapter.logoutAccount()
    await sendStatus(res, brand, adapter, false)
    return
  }

  const phone = phoneFrom(body.phone)
  if (phone === undefined) {
    send(res, 400, { error: '请输入 11 位手机号。' })
    return
  }

  if (action === 'sms-send') {
    const last = smsSentAt.get(brand)
    if (last !== undefined && Date.now() - last < SMS_COOLDOWN_MS) {
      send(res, 429, { error: `请等待 ${Math.ceil((SMS_COOLDOWN_MS - (Date.now() - last)) / 1000)} 秒后再获取验证码。` })
      return
    }
    try {
      const ticket = await adapter.sendSmsCode(phone)
      smsSentAt.set(brand, Date.now())
      send(res, 200, { brand, msgid: ticket.msgid, cooldownSeconds: Math.floor(SMS_COOLDOWN_MS / 1000) })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      send(res, 400, { error: message })
    }
    return
  }

  if (action !== 'password' && action !== 'sms-login') {
    send(res, 400, { error: 'action 只接受 password、sms-send、sms-login 或 logout' })
    return
  }

  const failure = loginFailures.get(brand)
  if (failure !== undefined && failure.count >= MAX_LOGIN_FAILURES && Date.now() - failure.at < FAILURE_WINDOW_MS) {
    send(res, 429, { error: '登录失败次数过多，请 5 分钟后再试。' })
    return
  }

  try {
    if (action === 'password') {
      if (typeof body.password !== 'string' || body.password.length === 0 || body.password.length > 128) {
        send(res, 400, { error: '请输入密码（最多 128 个字符）。' })
        return
      }
      await adapter.loginWithPassword(phone, body.password)
    } else {
      if (typeof body.code !== 'string' || !/^\d{4,8}$/.test(body.code.trim())) {
        send(res, 400, { error: '请输入短信验证码。' })
        return
      }
      if (typeof body.msgid !== 'string' || body.msgid.length === 0) {
        send(res, 400, { error: '请先获取短信验证码。' })
        return
      }
      await adapter.loginWithSms(phone, body.code.trim(), body.msgid)
    }
    loginFailures.delete(brand)
    smsSentAt.delete(brand)
    await sendStatus(res, brand, adapter, true)
  } catch (error) {
    const code = error instanceof LoginError ? error.code : undefined
    const previous = loginFailures.get(brand)
    const next = previous !== undefined && Date.now() - previous.at < FAILURE_WINDOW_MS
      ? { at: previous.at, count: previous.count + 1 }
      : { at: Date.now(), count: 1 }
    loginFailures.set(brand, next)
    send(res, failureCode(code), {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

export async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  adapters: AdapterMap,
): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname.slice(API_PREFIX.length) || '/'
    const method = req.method ?? 'GET'

    // Writes select their provider in the body, like the auth routes of the
    // sibling plugin: the page never puts a brand in the URL for writes.
    if (path === '/account' && method === 'POST') {
      await handleAccount(req, res, adapters)
      return
    }

    const brand = brandFrom(url.searchParams.get('brand'))
    if (brand === undefined) {
      send(res, 400, { error: 'brand 只接受 loomy 或 raccoon' })
      return
    }
    const adapter = adapters[brand]
    const fresh = url.searchParams.get('fresh') === '1'

    if (path === '/models' && method === 'GET') {
      if (fresh) adapter.invalidateCatalog()
      if (!(await adapter.isSignedIn())) {
        send(res, 200, {
          brand,
          models: [],
          signedIn: false,
          notice: await adapter.catalogError(),
        })
        return
      }
      const rows = await buildRows(adapter)
      const error = await adapter.catalogError()
      send(res, 200, {
        brand,
        models: rows,
        signedIn: true,
        ...error === undefined ? {} : { notice: error },
        ...rows.length === 0 && error === undefined ? { notice: '账号没有返回任何模型。' } : {},
      })
      return
    }

    if (path === '/status' && method === 'GET') {
      if (fresh) adapter.invalidateUsage()
      const status = await adapter.usageInfo(fresh)
      send(res, 200, status)
      return
    }

    send(res, 404, { error: '未知接口' })
  } catch (error) {
    send(res, 500, { error: error instanceof Error ? error.message : String(error) })
  }
}
