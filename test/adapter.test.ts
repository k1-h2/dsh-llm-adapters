import { describe, expect, it, vi } from 'vitest'
import { Readable } from 'node:stream'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { LocalAdapter } from '../src/adapter.ts'
import type { AdapterOptions } from '../src/adapter.ts'
import { API_PREFIX, buildRows, handleApi } from '../src/api.ts'
import type { ProviderModel } from '../src/catalog.ts'
import type { QuotaSnapshot } from '../src/types.ts'

const models: ProviderModel[] = [
  {
    id: 'spark-x', name: 'Spark X', contextWindow: 1_000_000, maxTokens: 32_000,
    vision: true, reasoning: true, priceFactor: 0.1,
  },
  {
    id: 'deepseek-v4-flash-0731', name: 'DeepSeek V4 Flash', contextWindow: 200_000,
    vision: false, reasoning: false, priceFactor: 3,
  },
]

function fakeClient(overrides: Record<string, unknown> = {}) {
  return {
    signedIn: async () => true,
    models: async () => models,
    catalogError: () => undefined,
    invalidateModels: vi.fn(),
    invalidateQuota: vi.fn(),
    status: async () => ({ signedIn: true, source: 'C:/auth.json', account: { name: 'Alice' } }),
    quota: async () => ({ at: 1, total: 100, available: 100, permanent: 40, daily: 60 }),
    stream: async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
    logoutAccount: vi.fn(async () => undefined),
    startBrowserLogin: vi.fn(() => ({ running: true, phase: 'waiting', url: 'https://example.test/login' })),
    browserLoginStatus: vi.fn(() => ({ running: false, phase: 'idle' })),
    cancelBrowserLogin: vi.fn(),
    close: vi.fn(),
    ...overrides,
  }
}

function makeAdapter(overrides: Record<string, unknown> = {}, options: Partial<AdapterOptions> = {}) {
  const client = fakeClient(overrides)
  const adapter = new (class extends LocalAdapter {})({
    brand: 'loomy',
    provider: 'loomy',
    displayName: () => 'Loomy Test',
    disabledModels: () => ['deepseek-v4-flash-0731'],
    modelContextWindows: () => ({ 'spark-x': 500_000 }),
    modelAliases: () => ({ alias: 'spark-x' }),
    defaultMaxTokens: () => 32_000,
    readImage: undefined,
    ...options,
  }, client as never)
  return { adapter, client }
}

describe('LocalAdapter', () => {
  it('reports the configured display name', () => {
    const { adapter } = makeAdapter()
    expect(adapter.providerInfo('loomy')).toEqual({ id: 'loomy', name: 'Loomy Test' })
  })

  it('lists only enabled models with the adapter catalog metadata', async () => {
    const { adapter } = makeAdapter()
    expect(await adapter.listModels('loomy')).toEqual([{
      provider: 'loomy',
      id: 'spark-x',
      name: 'Spark X',
      inputModalities: ['text', 'image'],
    }])
  })

  it('resolves aliases, the user window override and output limit', async () => {
    const { adapter } = makeAdapter()
    const info = await adapter.resolveModel('loomy', 'alias')
    expect(info).toMatchObject({
      id: 'alias',
      name: 'Spark X',
      context: { contextWindow: 500_000 },
      defaultMaxTokens: 32_000,
      inputModalities: ['text', 'image'],
    })
  })

  it('passes the alias and effective max tokens to the provider stream', async () => {
    const received: { model?: string, max?: number } = {}
    const { adapter } = makeAdapter({
      stream: async function* (_options: unknown, model: string, _read: unknown, _onAuth: unknown): AsyncGenerator<StreamChunk> {
        received.model = model
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    })
    const chunks: StreamChunk[] = []
    for await (const chunk of adapter.stream({
      provider: 'loomy', model: 'alias', messages: [],
    })) chunks.push(chunk)
    expect(received.model).toBe('spark-x')
    expect(chunks).toEqual([{ type: 'finish', reason: { kind: 'stop' } }])
  })

  it('reports login and quota state for the settings page', async () => {
    const { adapter } = makeAdapter()
    const status = await adapter.usageInfo(true)
    expect(status).toMatchObject({
      brand: 'loomy',
      signedIn: true,
      account: { name: 'Alice' },
      quota: { available: 100, permanent: 40, daily: 60 },
    })
  })

  it('keeps the account visible when quota reading fails', async () => {
    const { adapter } = makeAdapter({
      quota: async () => { throw new Error('quota offline') },
    })
    const status = await adapter.usageInfo()
    expect(status.signedIn).toBe(true)
    expect(status.quotaError).toBe('quota offline')
  })

  it('refuses to read a catalog while signed out', async () => {
    const { adapter } = makeAdapter({
      signedIn: async () => false,
      status: async () => ({ signedIn: false, error: 'not logged in' }),
    })
    expect(await adapter.describeCatalog()).toEqual([])
    expect(await adapter.listModels('loomy')).toEqual([])
    expect(await adapter.catalogError()).toBe('not logged in')
  })
})

describe('buildRows', () => {
  it('joins the live catalog with disabled ids and window overrides', async () => {
    const { adapter } = makeAdapter()
    const rows = await buildRows(adapter)
    expect(rows[0]).toMatchObject({
      id: 'spark-x',
      enabled: true,
      contextWindow: 500_000,
      defaultContextWindow: 1_000_000,
      override: 500_000,
      priceFactor: 0.1,
      vision: true,
      reasoning: true,
    })
    expect(rows[0]!.contextWindows).toContain(1_000_000)
    expect(rows[0]!.contextWindows).toContain(500_000)
    expect(rows[1]).toMatchObject({
      id: 'deepseek-v4-flash-0731',
      enabled: false,
      contextWindow: 200_000,
      defaultContextWindow: 200_000,
    })
  })
})

interface Captured {
  status: number
  body: Record<string, unknown>
}

function request(url: string, method = 'GET'): Readable & { url: string, method: string } {
  const req = Readable.from([]) as Readable & { url: string, method: string }
  req.url = url
  req.method = method
  return req
}

function jsonRequest(url: string, body: unknown, method = 'POST'): Readable & { url: string, method: string } {
  const req = Readable.from([Buffer.from(JSON.stringify(body), 'utf8')]) as Readable & { url: string, method: string }
  req.url = url
  req.method = method
  return req
}

function response(): { res: never, captured: Captured } {
  const captured: Captured = { status: 0, body: {} }
  const res = {
    writeHead(status: number) { captured.status = status },
    end(body: string | Buffer) { captured.body = JSON.parse(String(body)) as Record<string, unknown> },
    setHeader() {},
  }
  return { res: res as never, captured }
}

describe('settings API', () => {
  it('serves model rows and echoes the brand', async () => {
    const { adapter } = makeAdapter()
    const { res, captured } = response()
    await handleApi(request(`${API_PREFIX}/models?brand=loomy`), res, { loomy: adapter, raccoon: adapter })
    expect(captured.status).toBe(200)
    expect(captured.body.brand).toBe('loomy')
    expect((captured.body.models as unknown[]).length).toBe(2)
    expect(captured.body.signedIn).toBe(true)
  })

  it('serves account and quota status', async () => {
    const { adapter } = makeAdapter()
    const { res, captured } = response()
    await handleApi(request(`${API_PREFIX}/status?brand=loomy&fresh=1`), res, { loomy: adapter, raccoon: adapter })
    expect(captured.status).toBe(200)
    expect(captured.body).toMatchObject({
      brand: 'loomy',
      signedIn: true,
      quota: { total: 100 },
    })
  })

  it('rejects an unknown brand and route', async () => {
    const { adapter } = makeAdapter()
    const bad = response()
    await handleApi(request(`${API_PREFIX}/models?brand=nope`), bad.res, { loomy: adapter, raccoon: adapter })
    expect(bad.captured.status).toBe(400)

    const missing = response()
    await handleApi(request(`${API_PREFIX}/unknown?brand=loomy`), missing.res, { loomy: adapter, raccoon: adapter })
    expect(missing.captured.status).toBe(404)
  })
})

describe('account API', () => {
  it('starts a QR login and reports its status', async () => {
    const startBrowserLogin = vi.fn(async () => ({ running: true, phase: 'waiting', url: 'https://example.test/login' }))
    const { adapter } = makeAdapter({ startBrowserLogin })
    const { res, captured } = response()
    await handleApi(jsonRequest(`${API_PREFIX}/account`, {
      brand: 'loomy',
      action: 'browser',
    }), res, { loomy: adapter, raccoon: adapter })
    expect(captured.status).toBe(200)
    expect(startBrowserLogin).toHaveBeenCalledOnce()
    expect(captured.body).toMatchObject({
      brand: 'loomy',
      running: true,
      phase: 'waiting',
      url: 'https://example.test/login',
    })
  })

  it('surfaces a local-page error instead of pretending to run', async () => {
    const { adapter } = makeAdapter({
      startBrowserLogin: async () => { throw new Error('本地登录页启动失败。') },
    })
    const { res, captured } = response()
    await handleApi(jsonRequest(`${API_PREFIX}/account`, { brand: 'loomy', action: 'browser' }), res, {
      loomy: adapter,
      raccoon: adapter,
    })
    expect(captured.status).toBe(400)
    expect(String(captured.body.error)).toContain('本地登录页')
  })

  it('serves the QR login status for polling', async () => {
    const { adapter } = makeAdapter({
      browserLoginStatus: () => ({ running: true, phase: 'waiting', url: 'https://example.test/login' }),
    })
    const { res, captured } = response()
    await handleApi(request(`${API_PREFIX}/account/browser?brand=loomy`), res, {
      loomy: adapter,
      raccoon: adapter,
    })
    expect(captured.status).toBe(200)
    expect(captured.body).toMatchObject({ brand: 'loomy', running: true, phase: 'waiting' })
  })

  it('cancels an in-flight QR login', async () => {
    const cancelBrowserLogin = vi.fn(async () => undefined)
    const { adapter } = makeAdapter({
      cancelBrowserLogin,
      browserLoginStatus: () => ({ running: false, phase: 'cancelled', error: '已取消登录。' }),
    })
    const { res, captured } = response()
    await handleApi(jsonRequest(`${API_PREFIX}/account`, { brand: 'loomy', action: 'browser-cancel' }), res, {
      loomy: adapter,
      raccoon: adapter,
    })
    expect(captured.status).toBe(200)
    expect(cancelBrowserLogin).toHaveBeenCalledOnce()
    expect(captured.body).toMatchObject({ phase: 'cancelled' })
  })

  it('signs out and clears the account state', async () => {
    const logoutAccount = vi.fn(async () => undefined)
    const { adapter: loomyAdapter } = makeAdapter()
    const { adapter: raccoonAdapter } = makeAdapter({
      logoutAccount,
      status: async () => ({ signedIn: false }),
    }, { brand: 'raccoon' })
    const { res, captured } = response()
    await handleApi(jsonRequest(`${API_PREFIX}/account`, { brand: 'raccoon', action: 'logout' }), res, {
      loomy: loomyAdapter,
      raccoon: raccoonAdapter,
    })
    expect(captured.status).toBe(200)
    expect(logoutAccount).toHaveBeenCalledOnce()
    expect(captured.body).toMatchObject({ brand: 'raccoon', signedIn: false })
  })

  it('rejects an unknown action and an unknown brand', async () => {
    const { adapter } = makeAdapter()
    const unknownAction = response()
    await handleApi(jsonRequest(`${API_PREFIX}/account`, {
      brand: 'loomy', action: 'password',
    }), unknownAction.res, { loomy: adapter, raccoon: adapter })
    expect(unknownAction.captured.status).toBe(400)

    const unknownBrand = response()
    await handleApi(jsonRequest(`${API_PREFIX}/account`, { brand: 'nope', action: 'logout' }), unknownBrand.res, {
      loomy: adapter,
      raccoon: adapter,
    })
    expect(unknownBrand.captured.status).toBe(400)
  })
})
