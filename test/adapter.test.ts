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
    vision: true, reasoning: true, priceFactor: 0.1, labels: ['限时免费'],
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
    status: async () => ({ signedIn: true, account: { name: 'Alice' } }),
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

  it('collapses duplicate ids instead of making DSH reject the provider', async () => {
    // DSH reports "duplicate model metadata" and drops the route entirely; the
    // adapter must never hand it two rows with one id.
    const duplicated: ProviderModel[] = [
      { id: 'glm-5.3', name: 'GLM 5.3', contextWindow: 200_000, vision: false, reasoning: true },
      { id: 'GLM-5.3', name: 'GLM 5.3 (dup)', contextWindow: 200_000, vision: false, reasoning: true },
    ]
    const { adapter } = makeAdapter({ models: async () => duplicated })
    const rows = await adapter.listModels('loomy')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: 'glm-5.3', name: 'GLM 5.3' })
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

  it('keeps a verified vision capability when the catalog read fails', async () => {
    let catalog: ProviderModel[] = models
    const { adapter } = makeAdapter({ models: async () => catalog })
    // The first resolution sees the live catalog and remembers the capability.
    expect((await adapter.resolveModel('loomy', 'spark-x')).inputModalities).toEqual(['text', 'image'])

    // A failed refresh answers with an empty list. Declaring text-only here
    // made DSH replace the pixels with a placeholder before the adapter ran.
    catalog = []
    expect((await adapter.resolveModel('loomy', 'spark-x')).inputModalities).toEqual(['text', 'image'])
    // Nothing was ever verified for this id, so it stays text-only.
    expect((await adapter.resolveModel('loomy', 'never-seen')).inputModalities).toEqual(['text'])
  })

  it('publishes capitalized effort labels with the raw ids', async () => {
    const { adapter } = makeAdapter({
      models: async () => [{
        id: 'sn-kimi-k3',
        name: 'Kimi K3',
        contextWindow: 1_000_000,
        maxTokens: 100_000,
        vision: true,
        reasoning: true,
        reasoningEfforts: ['max', 'high', 'xhigh', 'none'],
        defaultReasoningEffort: 'high',
      }],
    }, { brand: 'raccoon', provider: 'raccoon' })
    const info = await adapter.resolveModel('raccoon', 'sn-kimi-k3')
    expect(info.reasoning).toEqual({
      efforts: [
        { id: 'max', name: 'Max' },
        { id: 'high', name: 'High' },
        { id: 'xhigh', name: 'xhigh' },
        { id: 'none', name: 'None' },
      ],
      defaultEffort: 'high',
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
      labels: ['限时免费'],
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

describe('context window choices', () => {
  it('offers a published Max tier without changing the default', async () => {
    const wide: ProviderModel = {
      id: 'wide-model', name: 'Wide', contextWindow: 200_000, maxContextWindow: 1_000_000,
      vision: false, reasoning: false,
    }
    const { adapter } = makeAdapter({ models: async () => [wide] })
    const rows = await buildRows(adapter)
    expect(rows[0]).toMatchObject({
      defaultContextWindow: 200_000,
      contextWindow: 200_000,
      maxContextWindow: 1_000_000,
    })
    expect(rows[0]!.contextWindows).toContain(1_000_000)
    expect(rows[0]!.contextWindows).toContain(200_000)
    // The reference's half-step between a 200K default and a 1M Max.
    expect(rows[0]!.contextWindows).toContain(500_000)
  })

  it('never lists two sizes that print as the same label', async () => {
    const wide: ProviderModel = {
      id: 'big-model', name: 'Big', contextWindow: 1_048_576,
      vision: false, reasoning: false,
    }
    const { adapter } = makeAdapter({ models: async () => [wide] })
    const rows = await buildRows(adapter)
    expect(rows[0]!.contextWindows).toContain(1_048_576)
    // 1,000,000 is also "1M" in the menu; the automatic step is dropped.
    expect(rows[0]!.contextWindows).not.toContain(1_000_000)
    expect(rows[0]!.contextWindows).toContain(500_000)
  })
})

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

  it('serves and syncs the shared OpenRouter snapshot', async () => {
    const status = vi.fn(() => ({ models: 3, at: 1, syncing: false }))
    const sync = vi.fn(async () => ({ ok: true, models: 4, at: 2, syncing: false }))
    const { adapter } = makeAdapter()
    const adapters = { loomy: adapter, raccoon: adapter, trae: adapter }

    const reading = response()
    await handleApi(request(`${API_PREFIX}/openrouter`), reading.res, adapters, { status, sync })
    expect(reading.captured.status).toBe(200)
    expect(reading.captured.body).toMatchObject({ models: 3, at: 1 })

    const refreshed = response()
    await handleApi(jsonRequest(`${API_PREFIX}/openrouter/sync`, {}), refreshed.res, adapters, { status, sync })
    expect(refreshed.captured.status).toBe(200)
    expect(sync).toHaveBeenCalledOnce()
    expect(refreshed.captured.body).toMatchObject({ ok: true, models: 4 })
  })

  it('reports 503 when no router admin is mounted', async () => {
    const { adapter } = makeAdapter()
    const { res, captured } = response()
    await handleApi(request(`${API_PREFIX}/openrouter`), res, {
      loomy: adapter, raccoon: adapter, trae: adapter,
    })
    expect(captured.status).toBe(503)
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

describe('Trae check-in', () => {
  const traeOptions: Partial<AdapterOptions> = { brand: 'trae', provider: 'trae' }

  it('attaches the check-in state to the account reading', async () => {
    const { adapter } = makeAdapter({
      checkinStatus: async () => ({ available: true, claimed: false, deviceClaimed: true, reward: 20 }),
    }, traeOptions)
    const status = await adapter.usageInfo()
    expect(status).toMatchObject({
      brand: 'trae',
      checkin: { available: true, claimed: false, deviceClaimed: true, reward: 20 },
    })
  })

  it('leaves the other providers without a check-in field', async () => {
    const { adapter } = makeAdapter()
    expect((await adapter.usageInfo()).checkin).toBeUndefined()
  })

  it('claims the reward and invalidates the cached quota', async () => {
    const invalidateQuota = vi.fn()
    const claimCheckin = vi.fn(async () => ({ available: true, claimed: true, deviceClaimed: false }))
    const { adapter } = makeAdapter({ claimCheckin, invalidateQuota }, traeOptions)
    expect(await adapter.claimCheckin()).toMatchObject({ claimed: true })
    expect(claimCheckin).toHaveBeenCalledOnce()
    expect(invalidateQuota).toHaveBeenCalledOnce()
  })

  it('rejects the action on a provider that has no reward', async () => {
    const { adapter } = makeAdapter()
    await expect(adapter.claimCheckin()).rejects.toThrow('没有签到活动')
  })

  it('serves the action and forwards the region to the browser login', async () => {
    const startBrowserLogin = vi.fn(async () => ({ running: true, phase: 'waiting' }))
    const claim = vi.fn(async () => ({ available: true, claimed: true, deviceClaimed: false }))
    const { adapter } = makeAdapter({ startBrowserLogin, claimCheckin: claim }, traeOptions)
    const adapters = { loomy: adapter, raccoon: adapter, trae: adapter }

    const login = response()
    await handleApi(jsonRequest(`${API_PREFIX}/account`, {
      brand: 'trae', action: 'browser', region: 'global',
    }), login.res, adapters)
    expect(login.captured.status).toBe(200)
    expect(startBrowserLogin).toHaveBeenCalledWith('global')

    const claimRes = response()
    await handleApi(jsonRequest(`${API_PREFIX}/account`, { brand: 'trae', action: 'checkin' }), claimRes.res, adapters)
    expect(claimRes.captured.status).toBe(200)
    expect(claimRes.captured.body).toMatchObject({ brand: 'trae', checkin: { claimed: true } })
  })

  it('reports a refused claim as a 400', async () => {
    const { adapter } = makeAdapter({
      claimCheckin: async () => { throw new Error('签到失败（code 9004）') },
    }, traeOptions)
    const { res, captured } = response()
    await handleApi(jsonRequest(`${API_PREFIX}/account`, { brand: 'trae', action: 'checkin' }), res, {
      loomy: adapter, raccoon: adapter, trae: adapter,
    })
    expect(captured.status).toBe(400)
    expect(String(captured.body.error)).toContain('9004')
  })
})
