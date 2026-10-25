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

export async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  adapters: AdapterMap,
): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname.slice(API_PREFIX.length) || '/'
    const brand = brandFrom(url.searchParams.get('brand'))
    if (brand === undefined) {
      send(res, 400, { error: 'brand 只接受 loomy 或 raccoon' })
      return
    }
    const adapter = adapters[brand]
    const fresh = url.searchParams.get('fresh') === '1'
    const method = req.method ?? 'GET'

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
