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

interface AccountRequest {
  brand?: unknown
  action?: unknown
}

async function sendStatus(res: ServerResponse, adapter: LocalAdapter, fresh: boolean): Promise<void> {
  send(res, 200, await adapter.usageInfo(fresh))
}

/** Browser sign-in control and sign-out; the page never sends credentials. */
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
    await sendStatus(res, adapter, false)
    return
  }

  if (action === 'browser') {
    try {
      send(res, 200, { brand, ...(await adapter.startBrowserLogin()) })
    } catch (error) {
      send(res, 400, { error: error instanceof Error ? error.message : String(error) })
    }
    return
  }

  if (action === 'browser-cancel') {
    await adapter.cancelBrowserLogin()
    send(res, 200, { brand, ...adapter.browserLoginStatus() })
    return
  }

  send(res, 400, { error: 'action 只接受 browser、browser-cancel 或 logout' })
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

    if (path === '/account/browser' && method === 'GET') {
      send(res, 200, { brand, ...adapter.browserLoginStatus() })
      return
    }

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
