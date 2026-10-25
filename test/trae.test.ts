import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { AccountStore } from '../src/account-store.ts'
import { TraeAuth } from '../src/auth.ts'
import { normalizeTraeRegion } from '../src/brand.ts'
import {
  TraeProvider, mergeTraeModels, normalizeEffort, openTraeStream, parseTraeCheckin, parseTraePlan,
  parseTraeRemoteModels, parseTraeUsage, parseTraeWireModels, traeMessages, traeTools,
} from '../src/trae.ts'
import { ProviderHttpError } from '../src/wire.ts'

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const chunk of stream) out.push(chunk)
  return out
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

function stream(frames: readonly string[]): ReadableStream<Uint8Array> {
  const body = frames.map(frame => `${frame}\n\n`).join('')
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body))
      controller.close()
    },
  })
}

const remotePayload = {
  data: {
    list: [
      {
        function: 'solo_agent',
        models: [
          {
            name: 'claude-4.5-sonnet',
            display_name: 'Claude 4.5 Sonnet',
            multimodal: true,
            context_window_tokens: { dev: 200_000, max: 1_000_000 },
            max_mode: true,
            features: JSON.stringify({ consumption_rate: { enable: true, data: { rate: 1.2 } } }),
            reasoning_effort_config: { options: ['light', 'medium', 'high', 'extra_high', 'max'] },
          },
          // A weaker duplicate inside an IDE-only group must not win.
          { name: 'gpt-5', display_name: 'GPT-5', context_window_tokens: { dev: 128_000 } },
        ],
      },
      {
        function: 'solo_work_remote',
        models: [
          {
            name: 'gpt-5',
            display_name: 'GPT-5',
            context_window_tokens: { dev: 272_000 },
            reasoning_effort_config: { options: ['low', 'medium', 'high', 'extra_high'] },
          },
          { name: 'kimi-k2', display_name: '-' },
        ],
      },
    ],
  },
}

const wirePayload = {
  config_info_list: [
    {
      config_name: 'gpt-5-2026',
      display_config: { display_name: 'GPT-5' },
      model_detail_list: [{ max_tokens: 64_000, prompt_max_tokens: 272_000, reasoning_effort_options: ['low', 'medium', 'high'] }],
      display_contact_config: JSON.stringify({ consumption_rate: { enable: true, data: { rate: 0.8 } } }),
    },
    {
      config_name: 'gemini-3-pro',
      display_config: { display_name: 'Gemini 3 Pro' },
      model_detail_list: [{ max_tokens: 32_000 }],
    },
    {
      // Same display name as a remote row: the dated snapshot is skipped.
      config_name: 'claude-4.5-sonnet-20260101',
      display_config: { display_name: 'Claude 4.5 Sonnet' },
      model_detail_list: [{ max_tokens: 8_000 }],
    },
  ],
}

describe('Trae catalog', () => {
  it('maps upstream effort names and drops the ones it does not know', () => {
    expect(normalizeEffort('light')).toBe('low')
    expect(normalizeEffort('extra_high')).toBe('xhigh')
    expect(normalizeEffort('max')).toBe('max')
    expect(normalizeEffort('none')).toBeUndefined()
    expect(normalizeEffort(42)).toBeUndefined()
  })

  it('reads the remote directory in chat-function order and keeps the stronger duplicate', () => {
    const models = parseTraeRemoteModels(remotePayload)
    expect(models.map(model => model.id)).toEqual(['gpt-5', 'kimi-k2', 'claude-4.5-sonnet'])
    const gpt = models.find(model => model.id === 'gpt-5')!
    expect(gpt).toMatchObject({ name: 'GPT-5', contextWindow: 272_000, function: 'solo_work_remote' })
    // `max` is appended even though the directory omits it: the gateway accepts it.
    expect(gpt.efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    const claude = models.find(model => model.id === 'claude-4.5-sonnet')!
    expect(claude).toMatchObject({
      multimodal: true, contextWindow: 200_000, maxContextWindow: 1_000_000, creditMultiplier: 1.2,
    })
    // Only IDE-only groups listed it, so it carries no chat function.
    expect(claude.function).toBeUndefined()
    // A missing display name falls back to the id instead of showing "-".
    expect(models.find(model => model.id === 'kimi-k2')?.name).toBe('kimi-k2')
  })

  it('reads the wire roster, including the post-discount multiplier', () => {
    const models = parseTraeWireModels(wirePayload, 'solo_work_remote')
    expect(models).toHaveLength(3)
    expect(models[0]).toMatchObject({
      configName: 'gpt-5-2026',
      name: 'GPT-5',
      maxTokens: 64_000,
      contextWindow: 272_000,
      creditMultiplier: 0.8,
      efforts: ['low', 'medium', 'high'],
      function: 'solo_work_remote',
    })
  })

  it('merges the two sources without duplicating a model under one name', () => {
    const remote = parseTraeRemoteModels(remotePayload)
    const wire = parseTraeWireModels(wirePayload, 'solo_work_remote')
    const { models, meta } = mergeTraeModels(remote, wire)

    expect(models.map(model => model.id)).toEqual(['gpt-5', 'kimi-k2', 'claude-4.5-sonnet', 'gemini-3-pro'])
    const gpt = models[0]!
    // Remote owns the display name and the window; wire owns the config name,
    // the output cap and the multiplier.
    expect(gpt).toMatchObject({
      // The shared name normalizer turns the vendor's `GPT-5` into `GPT 5`.
      name: 'GPT 5',
      contextWindow: 272_000,
      maxTokens: 64_000,
      priceFactor: 0.8,
      reasoning: true,
      reasoningEfforts: ['low', 'medium', 'high', 'max'],
      defaultReasoningEffort: 'high',
    })
    expect(meta.get('gpt-5')).toEqual({
      configName: 'gpt-5-2026',
      function: 'solo_work_remote',
      wireEfforts: { low: 'light', medium: 'medium', high: 'high', max: 'max' },
    })

    const claude = models.find(model => model.id === 'claude-4.5-sonnet')!
    expect(claude).toMatchObject({
      vision: true,
      priceFactor: 1.2,
      reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      // Second strongest, not the strongest.
      defaultReasoningEffort: 'xhigh',
    })
    // Matched by display name, so the callable config name is the dated one
    // Trae actually lists — not the directory id, which may not be accepted.
    expect(meta.get('claude-4.5-sonnet')).toMatchObject({
      configName: 'claude-4.5-sonnet-20260101',
      // The wire roster owns the call function; `solo_agent` rejected it live.
      function: 'solo_work_remote',
    })

    const gemini = models.find(model => model.id === 'gemini-3-pro')!
    expect(gemini).toMatchObject({ name: 'Gemini 3 Pro', maxTokens: 32_000, vision: false })
    expect(meta.get('gemini-3-pro')).toMatchObject({ configName: 'gemini-3-pro' })
  })

  it('never emits two rows with one id', () => {
    // Live case: the gateway lists `custom_model_gemini` under several functions
    // with different display names, and spells ids in both cases. DSH rejects
    // the whole provider when an id repeats.
    const remote = parseTraeRemoteModels({
      data: {
        list: [
          { function: 'solo_work_remote', models: [{ name: 'custom_model_gemini', display_name: 'Gemini 3.1 Pro Preview' }] },
          { function: 'chat_v3', models: [{ name: 'Custom_Model_Gemini', display_name: 'Gemini 3 Pro Preview' }] },
        ],
      },
    })
    expect(remote).toHaveLength(1)
    expect(remote[0]!.function).toBe('solo_work_remote')

    const wire = [
      { configName: 'custom_model_gemini', name: 'Gemini 3.1 Pro Preview', function: 'solo_work_remote', efforts: [] },
      { configName: 'custom_model_gemini', name: 'Gemini 3 Pro Preview', function: 'chat_v3', efforts: [] },
    ]
    const merged = mergeTraeModels(remote, wire)
    expect(merged.models).toHaveLength(1)
    expect(merged.models[0]).toMatchObject({ id: 'custom_model_gemini', name: 'Gemini 3.1 Pro Preview' })

    // The same config only in the wire roster must still collapse to one row,
    // keeping the function the priority order prefers.
    const wireOnly = mergeTraeModels([], wire)
    expect(wireOnly.models).toHaveLength(1)
    expect(wireOnly.meta.get('custom_model_gemini')).toMatchObject({ function: 'solo_work_remote' })
  })

  it('keeps a wire-only model out of the list when its name already exists', () => {
    const remote = parseTraeRemoteModels(remotePayload)
    const wire = parseTraeWireModels(wirePayload, 'solo_work_remote')
    const { models } = mergeTraeModels(remote, wire)
    expect(models.filter(model => model.name === 'Claude 4.5 Sonnet')).toHaveLength(1)
  })
})

describe('Trae request shape', () => {
  it('turns string content into text blocks and assistant tool calls into function_call', () => {
    const messages = traeMessages([
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"p":1}' } }],
      },
      { role: 'tool', content: 'ok', tool_call_id: 'call_1' },
    ])
    expect(messages[0]).toEqual({ role: 'user', content: [{ type: 'text', text: 'hi' }] })
    expect(messages[1].tool_calls).toEqual([
      { id: 'call_1', type: 'function', function_call: { name: 'read', arguments: '{"p":1}' } },
    ])
    expect(messages[2]).toMatchObject({ role: 'tool', tool_call_id: 'call_1' })
  })

  it('sends tool parameters as a JSON string and promotes per-property required flags', () => {
    const tools = traeTools([{
      name: 'read',
      description: 'read a file',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', required: true },
          limit: { type: 'number' },
        },
        required: true,
      },
    }]) as { function: { parameters: string } }[]
    expect(tools).toHaveLength(1)
    const parameters = JSON.parse(tools[0]!.function.parameters) as Record<string, unknown>
    expect(parameters.required).toEqual(['path'])
    expect((parameters.properties as Record<string, Record<string, unknown>>).path?.required).toBeUndefined()
    expect(traeTools([])).toBeUndefined()
  })
})

describe('Trae stream', () => {
  it('bridges text, reasoning, tool calls and usage into harness chunks', async () => {
    const chunks = await collect(openTraeStream(stream([
      'event: reasoning\ndata: {"reasoning_content":"think"}',
      'event: output\ndata: {"response":"he"}',
      'event: output\ndata: {"response":"llo"}',
      'event: output\ndata: {"tool_calls":[{"index":0,"id":"call_9","function_call":{"name":"read","arguments":"{\\"p\\":"}}]}',
      'event: output\ndata: {"tool_calls":[{"index":0,"function_call":{"arguments":"1}"}}]}',
      'event: token_usage\ndata: {"prompt_tokens":100,"completion_tokens":20,"cache_read_input_tokens":40,"reasoning_tokens":5}',
      'event: done\ndata: {"finish_reason":"tool_calls"}',
    ]), 'gpt-5'))

    expect(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => (chunk as { text: string }).text))
      .toEqual(['he', 'llo'])
    expect(chunks.filter(chunk => chunk.type === 'reasoning-delta')).toHaveLength(1)
    const tool = chunks.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
    expect(tool).toMatchObject({ block: { id: 'call_9', name: 'read', arguments: '{"p":1}' } })
    const usage = chunks.find(chunk => chunk.type === 'usage')
    expect(usage).toMatchObject({
      usage: { inputTokens: 60, outputTokens: 20, totalTokens: 120, cacheReadTokens: 40, reasoningTokens: 5 },
    })
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
  })

  it('maps a plan gate to 402 and a quota error to 429', async () => {
    const gated = openTraeStream(stream(['event: error\ndata: {"code":1005,"message":"no plan"}']), 'x')
    await expect(collect(gated)).rejects.toMatchObject({ status: 402 })

    const quota = openTraeStream(stream(['event: error\ndata: {"code":4008,"message":"quota"}']), 'x')
    await expect(collect(quota)).rejects.toMatchObject({ status: 429 })

    const rejected = openTraeStream(stream(['event: error\ndata: {"code":4001}']), 'x')
    await expect(collect(rejected)).rejects.toBeInstanceOf(ProviderHttpError)
  })

  it('reports an empty stream as a length stop instead of an empty answer', async () => {
    const chunks = await collect(openTraeStream(stream(['event: output\ndata: {}']), 'x'))
    expect(chunks).toEqual([{ type: 'finish', reason: { kind: 'max-tokens' } }])
  })
})

describe('Trae quota and check-in parsing', () => {
  it('reads the mainland entitlement document', () => {
    const quota = parseTraeUsage({
      data: {
        usage_summary: { total_amount: 2000, consumed_amount: 500, consumption_ratio: 0.25 },
        user_entitlement_pack_list: [
          {
            display_desc: '月度包',
            entitlement_base_info: { end_time: 1_800_000_000, quota: { credits_limit: 1500 } },
            usage: { credits_amount: 300 },
          },
          {
            display_desc: '试用包',
            entitlement_base_info: {
              end_time: 1_700_000_000,
              product_extra: { package_extra: { quota: { credits_limit: 500 } } },
            },
          },
        ],
      },
    })
    expect(quota).toMatchObject({ total: 2000, used: 500, ratio: 25 })
    // Soonest expiry first, so the card shows the pack that runs out next.
    expect(quota.packs?.map(pack => pack.label)).toEqual(['试用包', '月度包'])
    expect(quota.packs?.[1]).toMatchObject({ total: 1500, used: 300, expiresAt: 1_800_000_000_000 })
  })

  it('reads the international subscription document', () => {
    expect(parseTraePlan({ user_pay_identity_str: 'Pro', has_package: true }))
      .toMatchObject({ plan: 'Pro' })
    expect(parseTraePlan({ in_trial: true, trial_status: { trial_end_time: 1_800_000_000 } }))
      .toMatchObject({ plan: '试用', trialEndsAt: 1_800_000_000_000 })
    expect(parseTraePlan({ has_package: false })).toMatchObject({ plan: '免费' })
  })

  it('keeps the account and device flags apart', () => {
    expect(parseTraeCheckin({ enable: true, checked_in: false, did_checked_in: true, credits: 10, extra_credits: 5 }))
      .toEqual({ available: true, claimed: false, deviceClaimed: true, reward: 15 })
    expect(parseTraeCheckin({ enable: false, checked_in: true }))
      .toMatchObject({ available: false, claimed: true, deviceClaimed: false })
  })
})

describe('TraeAuth', () => {
  function make(region: 'cn' | 'global') {
    const root = mkdtempSync(path.join(tmpdir(), 'trae-auth-'))
    const store = new AccountStore(() => root)
    return { store, auth: new TraeAuth(store, () => region) }
  }

  const record = {
    accessToken: 'tok-cn',
    region: 'cn' as const,
    deviceId: 'dev-cn',
    machineId: 'mach-cn',
    loginAt: 1,
  }

  it('keeps one account per region and names the missing one', async () => {
    const { store, auth } = make('cn')
    await store.saveTrae(record)
    expect(await auth.status()).toMatchObject({ signedIn: true })
    expect(await auth.identity()).toEqual({ deviceId: 'dev-cn', machineId: 'mach-cn' })

    const other = new TraeAuth(store, () => 'global')
    expect(await other.status()).toMatchObject({ signedIn: false })
    expect((await other.status()).error).toContain('国际版')
  })

  it('reports an expired token instead of using it', async () => {
    const { store, auth } = make('cn')
    await store.saveTrae({ ...record, expiresAt: Date.now() - 1000 })
    expect(await auth.status()).toMatchObject({ signedIn: false, possiblyExpired: true })
    await expect(auth.accessToken()).rejects.toThrow('登录已过期')
  })

  it('signs out only the current region', async () => {
    const { store, auth } = make('cn')
    await store.saveTrae(record)
    await store.saveTrae({ ...record, accessToken: 'tok-global', region: 'global', deviceId: 'dev-global' })
    await auth.logout()
    expect(await store.trae('cn')).toBeUndefined()
    expect(await store.trae('global')).toMatchObject({ accessToken: 'tok-global' })
  })

  it('normalizes an unknown region to the mainland deployment', () => {
    expect(normalizeTraeRegion('global')).toBe('global')
    expect(normalizeTraeRegion('mars')).toBe('cn')
    expect(normalizeTraeRegion(undefined)).toBe('cn')
  })
})

describe('TraeProvider', () => {
  function make(region: 'cn' | 'global', fetchImpl: typeof fetch) {
    const auth = {
      status: async () => ({ signedIn: true }),
      accessToken: async () => 'tok',
      identity: async () => ({ deviceId: 'dev-1', machineId: 'mach-1', userId: 'u-1' }),
      logout: async () => undefined,
    }
    const store = { saveTrae: vi.fn(async () => undefined) }
    const provider = new TraeProvider({
      auth: auth as never,
      store: store as never,
      region: () => region,
      ttlMs: () => 1000,
      timeoutMs: () => 1000,
      textOnly: () => new Set(),
      forceVision: () => new Set(),
      fetchImpl,
    })
    return { provider, auth, store }
  }

  function catalogFetch(): typeof fetch {
    return vi.fn(async (url: string) => {
      if (url.includes('/api/remote/v1/models')) return json(remotePayload)
      if (url.includes('/get_detail_param')) return json(wirePayload)
      throw new Error(`unexpected ${url}`)
    }) as unknown as typeof fetch
  }

  const options: GenerateOptions = {
    provider: 'trae',
    model: 'gpt-5',
    messages: [{
      role: 'user',
      id: 'u' as never,
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'hi' }],
    }],
  }

  it('merges the directory and the wire roster behind one catalog', async () => {
    const { provider } = make('cn', catalogFetch())
    const models = await provider.models()
    expect(models.map(model => model.id)).toEqual(['gpt-5', 'kimi-k2', 'claude-4.5-sonnet', 'gemini-3-pro'])
    expect(provider.catalogError()).toBeUndefined()
  })

  it('streams with the web fingerprints and the mapped effort', async () => {
    const seen: { url?: string, headers?: Record<string, string>, body?: Record<string, unknown> } = {}
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      if (url.includes('/api/remote/v1/models')) return json(remotePayload)
      if (url.includes('/get_detail_param')) return json(wirePayload)
      seen.url = url
      seen.headers = init.headers as Record<string, string>
      seen.body = JSON.parse(String(init.body)) as Record<string, unknown>
      return new Response(stream(['event: output\ndata: {"response":"ok"}', 'event: done\ndata: {"finish_reason":"stop"}']).getReader()
        ? stream(['event: output\ndata: {"response":"ok"}', 'event: done\ndata: {"finish_reason":"stop"}'])
        : null, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    })
    const { provider } = make('cn', fetchMock as unknown as typeof fetch)
    const chunks = await collect(provider.stream(
      { ...options, reasoningEffort: 'high' as never },
      'gpt-5',
      undefined,
      () => undefined,
    ))
    expect(seen.url).toBe('https://trae-api-cn.mchost.guru/api/agent/v3/llm_utils_chat')
    expect(seen.headers).toMatchObject({
      authorization: 'Cloud-IDE-JWT tok',
      'x-device-id': 'dev-1',
      'x-machine-id': 'mach-1',
      'x-uid': 'u-1',
      'x-trae-client-type': 'web',
      // The gateway binds this as a number and answers 4001 when it is absent.
      'x-app-version-code': '20260716',
      'x-ide-version-code': '20260716',
    })
    expect(seen.body).toMatchObject({
      model: 'gpt-5-2026',
      config_name: 'gpt-5-2026',
      function: 'solo_work_remote',
      reasoning_effort: 'high',
      stream: true,
    })
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('reads the mainland quota and the check-in state', async () => {
    const seen: string[] = []
    const fetchMock = vi.fn(async (url: string) => {
      seen.push(url)
      if (url.endsWith('/web_user_ent_usage')) {
        return json({ data: { usage_summary: { total_amount: 10, consumed_amount: 2, consumption_ratio: 20 } } })
      }
      if (url.endsWith('/checkin_credits/status')) {
        return json({ enable: true, checked_in: false, did_checked_in: false, credits: 20 })
      }
      throw new Error(`unexpected ${url}`)
    })
    const { provider } = make('cn', fetchMock as unknown as typeof fetch)
    expect(await provider.quota(true)).toMatchObject({ total: 10, used: 2, ratio: 20 })
    expect(await provider.checkinStatus()).toEqual({
      available: true, claimed: false, deviceClaimed: false, reward: 20,
    })
    expect(seen[0]).toBe('https://api.trae.cn/trae/api/v2/pay/web_user_ent_usage')
  })

  it('claims once, then reports the device as already claimed', async () => {
    let call = 0
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/checkin_credits/claim')) {
        call++
        return json(call === 1 ? { code: 0 } : { code: 9095, message: 'already' })
      }
      throw new Error(`unexpected ${url}`)
    })
    const { provider } = make('cn', fetchMock as unknown as typeof fetch)
    expect(await provider.claimCheckin()).toEqual({ available: true, claimed: true, deviceClaimed: false })
    expect(await provider.claimCheckin()).toMatchObject({ claimed: false, deviceClaimed: true })
  })

  it('has no check-in on the international deployment', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/ide_user_pay_status')) return json({ user_pay_identity_str: 'Pro' })
      throw new Error(`unexpected ${url}`)
    })
    const { provider } = make('global', fetchMock as unknown as typeof fetch)
    expect(await provider.quota(true)).toMatchObject({ plan: 'Pro' })
    expect(await provider.checkinStatus()).toEqual({ available: false, claimed: false, deviceClaimed: false })
    await expect(provider.claimCheckin()).rejects.toThrow('没有签到活动')
  })

  it('drops the catalog and the quota when the region changes', async () => {
    let region: 'cn' | 'global' = 'cn'
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/api/remote/v1/models')) {
        return json({
          data: {
            list: [{
              function: 'solo_work_remote',
              models: [{ name: region === 'cn' ? 'cn-model' : 'global-model', display_name: region === 'cn' ? 'CN' : 'Global' }],
            }],
          },
        })
      }
      if (url.includes('/get_detail_param')) return json({ config_info_list: [] })
      if (url.endsWith('/web_user_ent_usage')) return json({ data: { usage_summary: { total_amount: 1 } } })
      if (url.endsWith('/ide_user_pay_status')) return json({ user_pay_identity_str: 'Pro' })
      if (url.endsWith('/checkin_credits/status')) return json({ enable: true, checked_in: false })
      throw new Error(`unexpected ${url}`)
    })
    const provider = new TraeProvider({
      auth: {
        status: async () => ({ signedIn: true }),
        accessToken: async () => 'tok',
        identity: async () => ({ deviceId: 'dev-1', machineId: 'mach-1' }),
        logout: async () => undefined,
      } as never,
      store: { saveTrae: vi.fn() } as never,
      region: () => region,
      ttlMs: () => 60_000,
      timeoutMs: () => 1000,
      textOnly: () => new Set(),
      forceVision: () => new Set(),
      fetchImpl: fetchMock as unknown as typeof fetch,
    })

    expect((await provider.models()).map(model => model.id)).toEqual(['cn-model'])
    expect(await provider.quota()).toMatchObject({ total: 1 })
    expect(await provider.checkinStatus()).toMatchObject({ available: true })

    region = 'global'
    // The other deployment has its own directory, quota and (no) check-in.
    expect((await provider.models()).map(model => model.id)).toEqual(['global-model'])
    expect(await provider.quota()).toMatchObject({ plan: 'Pro' })
    expect(await provider.checkinStatus()).toMatchObject({ available: false })
  })

  it('refreshes the token once when the gateway rejects it', async () => {
    const forced: boolean[] = []
    const auth = {
      status: async () => ({ signedIn: true }),
      accessToken: async (force = false) => {
        if (force) forced.push(true)
        return 'tok'
      },
      identity: async () => ({ deviceId: 'dev-1', machineId: 'mach-1' }),
      logout: async () => undefined,
    }
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/api/remote/v1/models')) return json(remotePayload)
      if (url.includes('/get_detail_param')) return json(wirePayload)
      return json({ error: { message: 'unauthorized' } }, 401)
    })
    const provider = new TraeProvider({
      auth: auth as never,
      store: { saveTrae: vi.fn() } as never,
      region: () => 'cn',
      ttlMs: () => 1000,
      timeoutMs: () => 1000,
      textOnly: () => new Set(),
      forceVision: () => new Set(),
      fetchImpl: fetchMock as unknown as typeof fetch,
    })
    await expect(collect(provider.stream(options, 'gpt-5', undefined, () => undefined)))
      .rejects.toBeInstanceOf(ProviderHttpError)
    expect(forced).toEqual([true])
  })
})
