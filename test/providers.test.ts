import { describe, expect, it, vi } from 'vitest'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { LoomyProvider } from '../src/loomy.ts'
import { RaccoonProvider, raccoonSessionId } from '../src/raccoon.ts'
import { EMPTY_OPENROUTER_INDEX } from '../src/openrouter.ts'
import type { OpenRouterLookup } from '../src/openrouter.ts'

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const chunk of stream) out.push(chunk)
  return out
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

function sse(): Response {
  return new Response([
    'data: {"choices":[{"delta":{"content":"ok"}}]}',
    '',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":1}}',
    '',
    'data: [DONE]',
    '',
  ].join('\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

const options: GenerateOptions = {
  provider: 'loomy',
  model: 'spark-x',
  messages: [{
    role: 'user',
    id: 'u' as never,
    source: { kind: 'user' },
    content: [{ type: 'text', text: 'hi' }],
  }],
}

describe('LoomyProvider', () => {
  function make(fetchImpl: typeof fetch, authOverrides: Record<string, unknown> = {}) {
    const auth = {
      status: async () => ({ signedIn: true }),
      session: async () => 'loomy-session',
      ...authOverrides,
    }
    const store = {
      saveLoomy: vi.fn(async () => undefined),
      saveRaccoon: vi.fn(async () => undefined),
      loomyDeviceId: vi.fn(async () => 'web-test'),
    }
    const provider = new LoomyProvider({
      auth: auth as never,
      store: store as never,
      ttlMs: () => 1000,
      timeoutMs: () => 1000,
      textOnly: () => new Set(),
      forceVision: () => new Set(),
      fetchImpl,
      openRouter: { models: async () => EMPTY_OPENROUTER_INDEX, invalidate: () => {} },
    })
    return { provider, auth, store }
  }

  it('sends the client tracing headers and bearer session', async () => {
    const seen: { url?: string, headers?: Record<string, string> } = {}
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      seen.url = url
      seen.headers = init.headers as Record<string, string>
      return json({ data: [{ id: 'spark-x', name: 'Spark X (x0.1)', context_length: 1000 }] })
    })
    const { provider } = make(fetchMock as unknown as typeof fetch)
    expect(await provider.models()).toHaveLength(1)
    expect(seen.url).toBe('https://loomyad.xunfei.cn/api/v1/models')
    expect(seen.headers).toMatchObject({
      authorization: 'Bearer loomy-session',
      token: 'loomy-session',
      'loomy-version': '0.9.38',
      invokeorigin: 'system',
    })
    expect(seen.headers?.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/)
    expect(seen.headers?.chatid).toMatch(/^chat-/)
    expect(seen.headers?.msgid).toMatch(/^msg-/)
  })

  it('normalizes the two Loomy point pools', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toContain('/points/records')
      return json({ code: 0, data: { balance: 1000, dailyBalance: 250, availableBalance: 1250, dailyCycleDate: '2026-10-25' } })
    })
    const { provider } = make(fetchMock as unknown as typeof fetch)
    expect(await provider.quota(true)).toMatchObject({
      available: 1250, permanent: 1000, daily: 250, total: 1250, cycle: '2026-10-25',
    })
  })

  it('streams chat through the required trace headers', async () => {
    const seen: { url?: string, headers?: Record<string, string>, body?: Record<string, unknown> } = {}
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      seen.url = url
      seen.headers = init.headers as Record<string, string>
      seen.body = JSON.parse(String(init.body)) as Record<string, unknown>
      return sse()
    })
    const { provider } = make(fetchMock as unknown as typeof fetch)
    const chunks = await collect(provider.stream({ ...options, maxTokens: 123 }, 'spark-x', undefined))
    expect(seen.url).toContain('/chat/completions')
    expect(seen.headers).toMatchObject({
      authorization: 'Bearer loomy-session',
      invokeorigin: 'user',
    })
    expect(seen.body).toMatchObject({ model: 'spark-x', stream: true, max_tokens: 123 })
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('turns an expired session into an actionable error', async () => {
    const fetchMock = vi.fn(async () => json({ error: { message: 'token is required' } }, 401))
    const { provider } = make(fetchMock as unknown as typeof fetch)
    await expect(collect(provider.stream(options, 'spark-x', undefined))).rejects.toThrow('Loomy 登录态已失效')
  })
})

describe('RaccoonProvider', () => {
  function make(
    fetchImpl: typeof fetch,
    openRouter: OpenRouterLookup = {
      models: async () => EMPTY_OPENROUTER_INDEX,
      invalidate: () => {},
    },
    storeOverrides: Record<string, unknown> = {},
  ) {
    const accessToken = vi.fn(async (force?: boolean) => force === true ? 'token-2' : 'token-1')
    const auth = {
      status: async () => ({ signedIn: true }),
      accessToken,
    }
    const store = {
      saveRaccoon: vi.fn(async () => undefined),
      saveLoomy: vi.fn(async () => undefined),
      loomyDeviceId: vi.fn(async () => 'web-test'),
      raccoon: async () => undefined,
      ...storeOverrides,
    }
    const provider = new RaccoonProvider({
      auth: auth as never,
      store: store as never,
      ttlMs: () => 1000,
      timeoutMs: () => 1000,
      textOnly: () => new Set(),
      forceVision: () => new Set(),
      fetchImpl,
      openRouter,
    })
    return { provider, accessToken, store }
  }

  /** A token whose `sub` is the stable account identity the session id seeds from. */
  function raccoonToken(subject: string): string {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
    return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub: subject, sid: 'ses-1', exp: 4_102_444_800 })}.sig`
  }

  it('reads the chat category with desktop headers', async () => {
    const seen: { url?: string, headers?: Record<string, string> } = {}
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      seen.url = url
      seen.headers = init.headers as Record<string, string>
      return json({
        code: 0,
        data: { categories: [{ type: 'chat', models: [{ name: 'sn-glm-5-3-flash', params: { context_window: 1000, max_tokens: 100 } }] }] },
      })
    })
    const { provider } = make(fetchMock as unknown as typeof fetch)
    expect(await provider.models()).toHaveLength(1)
    expect(seen.url).toBe('https://xiaohuanxiong.com/api/web/llm/v2/model_catalog')
    expect(seen.headers).toMatchObject({
      authorization: 'Bearer token-1',
      'x-org-code': '',
      'x-client-platform': expect.stringMatching(/^desktop-/),
      'x-client-version': 'v1.0.35',
      'x-raccoon-language': 'zh',
    })
  })

  it('keeps the shared OpenRouter snapshot when models are refreshed', async () => {
    const invalidate = vi.fn()
    const models = vi.fn(async () => EMPTY_OPENROUTER_INDEX)
    const fetchMock = vi.fn(async () => json({
      code: 0,
      data: {
        categories: [{
          type: 'chat',
          models: [{
            name: 'sn-kimi-k3',
            description: 'Kimi-K3',
            tags: ['vision'],
            params: { context_window: 1000, max_tokens: 100 },
          }],
        }],
      },
    }))
    const { provider } = make(fetchMock as unknown as typeof fetch, { models, invalidate })
    const rows = await provider.models(true)
    // The router snapshot has its own schedule and on-disk copy; a model
    // refresh reads it but never throws it away.
    expect(invalidate).not.toHaveBeenCalled()
    expect(models).toHaveBeenCalledOnce()
    expect(rows[0]).toMatchObject({ name: 'Kimi K3', vision: true, reasoning: true })
  })

  it('reads the real points balance shape', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toContain('/points/v1/balance')
      return json({
        code: 0,
        data: {
          available_points: 4321,
          reward_points: 3000,
          daily_points: 300,
          topup_points: 0,
        },
      })
    })
    const { provider } = make(fetchMock as unknown as typeof fetch)
    expect(await provider.quota(true)).toMatchObject({
      total: 4321,
      available: 4321,
      permanent: 3000,
      daily: 300,
    })
  })

  it('reads today\'s daily grant from the points bills', async () => {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date())
    const issued = `${today}T00:13:52+08:00`
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toContain('/points/v2/bills')
      return json({
        code: 0,
        data: {
          items: [{
            biz_type: 'daily_grant', points: 300,
            grant_at: `${today}T00:00:00+08:00`, created_at: issued,
          }],
        },
      })
    })
    const { provider } = make(fetchMock as unknown as typeof fetch)
    expect(await provider.checkinStatus()).toMatchObject({
      available: true,
      claimed: true,
      reward: 300,
      grantedAt: Date.parse(issued),
      message: '今日每日积分已到账',
      url: 'https://xiaohuanxiong.com/work/home',
    })
  })

  it('does not treat yesterday\'s grant as today\'s', async () => {
    const fetchMock = vi.fn(async () => json({
      code: 0,
      data: { items: [{ biz_type: 'daily_grant', points: 300, grant_at: '2020-01-01T00:00:00+08:00' }] },
    }))
    const { provider } = make(fetchMock as unknown as typeof fetch)
    expect(await provider.checkinStatus()).toMatchObject({
      claimed: false,
      url: 'https://xiaohuanxiong.com/work/home',
    })
  })

  it('never triggers the grant: no claim path and no setting_info call', async () => {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date())
    const calls: string[] = []
    const fetchMock = vi.fn(async (url: string) => {
      calls.push(url)
      if (url.includes('/points/v2/bills')) {
        return json({
          code: 0,
          data: { items: [{ biz_type: 'daily_grant', points: 300, created_at: `${today}T00:13:00+08:00` }] },
        })
      }
      throw new Error(`unexpected ${url}`)
    })
    const { provider } = make(fetchMock as unknown as typeof fetch)
    // The claim action is gone, so the settings page has nothing to trigger with.
    expect('claimCheckin' in provider).toBe(false)
    // Detection still reports what arrived, from the ledger only.
    expect(await provider.checkinStatus()).toMatchObject({
      claimed: true,
      reward: 300,
      url: 'https://xiaohuanxiong.com/work/home',
    })
    // `setting_info` is the page-visit call that issues points; it must not be
    // spent as a side effect of merely looking.
    expect(calls.some(url => url.includes('setting_info'))).toBe(false)
  })

  it('points at the web page when the grant did not arrive', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/points/v2/bills')) return json({ code: 0, data: { items: [] } })
      throw new Error(`unexpected ${url}`)
    })
    const { provider } = make(fetchMock as unknown as typeof fetch)
    expect(await provider.checkinStatus()).toMatchObject({
      claimed: false,
      url: 'https://xiaohuanxiong.com/work/home',
    })
  })

  it('maps the thinking switch and effort level onto the request body', async () => {
    const bodies: Record<string, unknown>[] = []
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>)
      return sse()
    })
    const { provider } = make(fetchMock as unknown as typeof fetch)
    await collect(provider.stream(
      { ...options, provider: 'raccoon', reasoningEffort: 'off' as never },
      'sn-kimi-k3',
      undefined,
    ))
    await collect(provider.stream(
      { ...options, provider: 'raccoon', reasoningEffort: 'on' as never },
      'sn-kimi-k3',
      undefined,
    ))
    await collect(provider.stream(
      { ...options, provider: 'raccoon', reasoningEffort: 'max' as never },
      'sn-kimi-k3',
      undefined,
    ))
    await collect(provider.stream(
      { ...options, provider: 'raccoon', reasoningEffort: 'none' as never },
      'sn-kimi-k3',
      undefined,
    ))
    // No effort at all (a one-shot caller that skipped resolveCallConfig)
    // sends neither field, so the provider default applies.
    await collect(provider.stream(
      { ...options, provider: 'raccoon' },
      'sn-kimi-k3',
      undefined,
    ))
    expect(bodies[0]!.extra_body).toEqual({ thinking: { type: 'disabled' } })
    expect(bodies[0]!.reasoning_effort).toBeUndefined()
    expect(bodies[1]!.extra_body).toEqual({ thinking: { type: 'enabled' } })
    expect(bodies[1]!.reasoning_effort).toBeUndefined()
    expect(bodies[2]!.extra_body).toEqual({ thinking: { type: 'enabled' } })
    expect(bodies[2]!.reasoning_effort).toBe('max')
    expect(bodies[3]!.extra_body).toEqual({ thinking: { type: 'disabled' } })
    expect(bodies[3]!.reasoning_effort).toBe('none')
    expect(bodies[4]!.extra_body).toBeUndefined()
    expect(bodies[4]!.reasoning_effort).toBeUndefined()
  })

  it('asks for a new scan when the gateway rejects the stored token', async () => {
    const calls: { token?: string }[] = []
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>
      calls.push({ token: headers.authorization })
      return json({ message: 'token expired' }, 401)
    })
    const { provider, accessToken } = make(fetchMock as unknown as typeof fetch)
    await expect(collect(provider.stream({ ...options, provider: 'raccoon' }, 'sn-glm-5-3-flash', undefined)))
      .rejects.toThrow('登录已失效')
    expect(calls.map(call => call.token)).toEqual(['Bearer token-1'])
    expect(accessToken).not.toHaveBeenCalledWith(true)
  })

  it('does not retry after output has already reached the caller', async () => {
    let calls = 0
    const fetchMock = vi.fn(async () => {
      calls++
      if (calls === 1) {
        return new Response([
          'data: {"choices":[{"delta":{"content":"half"}}]}',
          '',
          'data: {"error":{"message":"gateway died"}}',
          '',
        ].join('\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } })
      }
      return sse()
    })
    const { provider, accessToken } = make(fetchMock as unknown as typeof fetch)
    await expect(collect(provider.stream(options, 'sn-glm-5-3-flash', undefined))).rejects.toThrow('gateway died')
    expect(calls).toBe(1)
    expect(accessToken).not.toHaveBeenCalledWith(true)
  })

  it('keeps one session id across the turns of a conversation', async () => {
    const seen: (string | undefined)[] = []
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      seen.push((init.headers as Record<string, string>)['x-raccoon-session-id'])
      return sse()
    })
    const { provider } = make(fetchMock as unknown as typeof fetch, undefined, {
      raccoon: async () => ({ accessToken: raccoonToken('pu-account-a') }),
    })
    for (let i = 0; i < 3; i++) {
      await collect(provider.stream(options, 'sn-glm-5-3-flash', undefined))
    }
    expect(seen).toHaveLength(3)
    // One session for the conversation, in the shape the official client sends.
    expect(seen[0]).toMatch(/^sess-\d+-[0-9a-f]{8}$/)
    expect(new Set(seen).size).toBe(1)
  })

  it('separates accounts and models into different sessions', async () => {
    const seen: (string | undefined)[] = []
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      seen.push((init.headers as Record<string, string>)['x-raccoon-session-id'])
      return sse()
    })
    const { provider } = make(fetchMock as unknown as typeof fetch, undefined, {
      raccoon: async () => ({ accessToken: raccoonToken('pu-account-a') }),
    })
    await collect(provider.stream(options, 'sn-glm-5-3-flash', undefined))
    await collect(provider.stream(options, 'sn-kimi-k3', undefined))
    // Two models are two conversations, so they must not share a session.
    expect(seen[0]).not.toBe(seen[1])
  })

  it('never puts the account identity itself on the wire', async () => {
    const raw: string[] = []
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      raw.push(JSON.stringify(init.headers))
      return sse()
    })
    const { provider } = make(fetchMock as unknown as typeof fetch, undefined, {
      raccoon: async () => ({ accessToken: raccoonToken('pu-secret-principal') }),
    })
    await collect(provider.stream(options, 'sn-glm-5-3-flash', undefined))
    // The id is a digest of the principal, never the principal.
    expect(raw.join(' ')).not.toContain('pu-secret-principal')
  })

  it('derives the session id from the account, not from process state', () => {
    // A restart must not present a new session: the whole point of the id is
    // that one conversation keeps looking like one conversation. A per-process
    // counter would break exactly this, so the value is pinned here.
    expect(raccoonSessionId('pu-account-a', 'sn-glm-5-3-flash')).toBe('sess-0-743a3433')
    // Two accounts and two models are four different conversations.
    const ids = new Set([
      raccoonSessionId('pu-account-a', 'sn-glm-5-3-flash'),
      raccoonSessionId('pu-account-b', 'sn-glm-5-3-flash'),
      raccoonSessionId('pu-account-a', 'sn-kimi-k3'),
    ])
    expect(ids.size).toBe(3)
    expect(raccoonSessionId('pu-account-a', 'sn-glm-5-3-flash')).toMatch(/^sess-0-[0-9a-f]{8}$/)
  })

  it('leaves the session header off the business routes', async () => {
    const seen: Record<string, string>[] = []
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      seen.push(init.headers as Record<string, string>)
      if (String(url).includes('model_catalog')) return json({ code: 0, data: { categories: [] } })
      return json({ code: 0, data: {} })
    })
    const { provider } = make(fetchMock as unknown as typeof fetch, undefined, {
      raccoon: async () => ({ accessToken: raccoonToken('pu-account-a') }),
    })
    await provider.catalog.models().catch(() => undefined)
    expect(seen.length).toBeGreaterThan(0)
    for (const headers of seen) expect(headers['x-raccoon-session-id']).toBeUndefined()
  })

  it('explains the token-throughput wall instead of surfacing a bare 429', async () => {
    const fetchMock = vi.fn(async () => json({
      error: { code: 'user_model_rate_limited', message: '您的模型请求频率超限，请稍后重试', type: 'rate_limit_error' },
    }, 429))
    const { provider } = make(fetchMock as unknown as typeof fetch)
    const error = await collect(provider.stream(options, 'sn-glm-5-3-flash', undefined))
      .catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(Error)
    expect((error as { status?: number }).status).toBe(429)
    // The vendor wording is kept, and the cause is named: it is not a rate limit.
    expect((error as Error).message).toContain('您的模型请求频率超限')
    expect((error as Error).message).toContain('token 速率')
    expect((error as Error).message).not.toMatch(/^HTTP 429$/)
  })

  it('catches the same wall when it arrives inside a 200 stream', async () => {
    const fetchMock = vi.fn(async () => new Response([
      'data: {"error":{"code":"user_model_rate_limited","message":"您的模型请求频率超限，请稍后重试","type":"rate_limit_error"}}',
      '',
    ].join('\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } }))
    const { provider } = make(fetchMock as unknown as typeof fetch)
    const error = await collect(provider.stream(options, 'sn-glm-5-3-flash', undefined))
      .catch((caught: unknown) => caught)
    // Without the in-band hook this reads as a generic 502, i.e. a plugin bug.
    expect((error as { status?: number }).status).toBe(429)
    expect((error as Error).message).toContain('token 速率')
  })

  it('still reports an unrelated in-band error as a gateway failure', async () => {
    const fetchMock = vi.fn(async () => new Response([
      'data: {"error":{"message":"gateway died"}}',
      '',
    ].join('\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } }))
    const { provider } = make(fetchMock as unknown as typeof fetch)
    const error = await collect(provider.stream(options, 'sn-glm-5-3-flash', undefined))
      .catch((caught: unknown) => caught)
    expect((error as { status?: number }).status).toBe(502)
    expect((error as Error).message).toBe('gateway died')
  })
})
