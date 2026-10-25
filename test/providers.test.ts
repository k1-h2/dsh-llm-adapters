import { describe, expect, it, vi } from 'vitest'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { LoomyProvider } from '../src/loomy.ts'
import { RaccoonProvider } from '../src/raccoon.ts'

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
  function make(fetchImpl: typeof fetch) {
    const accessToken = vi.fn(async (force?: boolean) => force === true ? 'token-2' : 'token-1')
    const auth = {
      status: async () => ({ signedIn: true }),
      accessToken,
    }
    const store = {
      saveRaccoon: vi.fn(async () => undefined),
      saveLoomy: vi.fn(async () => undefined),
      loomyDeviceId: vi.fn(async () => 'web-test'),
    }
    const provider = new RaccoonProvider({
      auth: auth as never,
      store: store as never,
      ttlMs: () => 1000,
      timeoutMs: () => 1000,
      textOnly: () => new Set(),
      forceVision: () => new Set(),
      fetchImpl,
    })
    return { provider, accessToken, store }
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

  it('maps the thinking switch onto extra_body.thinking', async () => {
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
      { ...options, provider: 'raccoon' },
      'sn-kimi-k3',
      undefined,
    ))
    expect(bodies[0]!.extra_body).toEqual({ thinking: { type: 'disabled' } })
    expect(bodies[1]!.extra_body).toEqual({ thinking: { type: 'enabled' } })
    expect(bodies[2]!.extra_body).toEqual({ thinking: { type: 'disabled' } })
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
})
