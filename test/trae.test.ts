import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { AccountStore } from '../src/account-store.ts'
import { TraeAuth } from '../src/auth.ts'
import { normalizeTraeRegion } from '../src/brand.ts'
import { ALL_REASONING_EFFORTS } from '../src/catalog.ts'
import { EMPTY_OPENROUTER_INDEX, buildOpenRouterIndex } from '../src/openrouter.ts'
import {
  TraeProvider, mergeTraeModels, normalizeEffort, openTraeStream, parseTraeCheckin,
  parseTraeGlobalUsage, parseTraeRemoteModels, parseTraeUsage, parseTraeWireModels, traeMessages, traeTools,
} from '../src/trae.ts'
import type { TraeProviderOptions } from '../src/trae.ts'
import type { TraeClientDetection } from '../src/trae-client.ts'
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
          // A weaker duplicate inside a specialist group must not win.
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
          {
            name: 'claude-4.5-sonnet',
            display_name: 'Claude 4.5 Sonnet',
            multimodal: true,
            context_window_tokens: { dev: 200_000, max: 1_000_000 },
            max_mode: true,
            features: JSON.stringify({ consumption_rate: { enable: true, data: { rate: 1.2 } } }),
            reasoning_effort_config: { options: ['light', 'medium', 'high', 'extra_high', 'max'] },
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
      usage: 'chat_completion',
      config_source: 1,
      model_detail_list: [{ max_tokens: 64_000, prompt_max_tokens: 272_000, reasoning_effort_options: ['low', 'medium', 'high'] }],
      display_contact_config: JSON.stringify({ consumption_rate: { enable: true, data: { rate: 0.8 } } }),
    },
    {
      config_name: 'gemini-3-pro',
      display_config: { display_name: 'Gemini 3 Pro' },
      usage: 'chat_completion',
      config_source: 1,
      model_detail_list: [{ max_tokens: 32_000 }],
    },
    {
      // Same display name as a remote row: the dated snapshot is skipped.
      config_name: 'claude-4.5-sonnet-20260101',
      display_config: { display_name: 'Claude 4.5 Sonnet' },
      usage: 'chat_completion',
      config_source: 1,
      model_detail_list: [{ max_tokens: 8_000 }],
    },
  ],
}

describe('Trae catalog', () => {
  it('maps upstream effort names and drops the ones it does not know', () => {
    expect(normalizeEffort('light')).toBe('low')
    expect(normalizeEffort('extra_high')).toBe('xhigh')
    expect(normalizeEffort('max')).toBe('max')
    expect(normalizeEffort('none')).toBe('none')
    expect(normalizeEffort('minimal')).toBe('minimal')
    expect(normalizeEffort(42)).toBeUndefined()
  })

  it('reads the remote directory in chat-function order and keeps the stronger duplicate', () => {
    const models = parseTraeRemoteModels(remotePayload)
    expect(models.map(model => model.id)).toEqual(['gpt-5', 'claude-4.5-sonnet', 'kimi-k2'])
    const gpt = models.find(model => model.id === 'gpt-5')!
    expect(gpt).toMatchObject({
      name: 'GPT-5', contextWindow: 272_000, function: 'solo_work_remote', primary: true,
    })
    // Exactly what the directory advertises; `max` is not invented here.
    expect(gpt.efforts).toEqual(['low', 'medium', 'high', 'xhigh'])
    const claude = models.find(model => model.id === 'claude-4.5-sonnet')!
    expect(claude).toMatchObject({
      multimodal: true, contextWindow: 200_000, maxContextWindow: 1_000_000, creditMultiplier: 1.2,
      primary: true,
    })
    // A missing display name falls back to the id instead of showing "-".
    expect(models.find(model => model.id === 'kimi-k2')?.name).toBe('kimi-k2')
    // A row that only a specialist roster lists is not a primary model.
    const specialist = parseTraeRemoteModels({
      data: { list: [{ function: 'solo_coder', models: [{ name: 'glm-4.6', display_name: 'GLM-4.6' }] }] },
    })
    expect(specialist[0]?.primary).toBe(false)
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
      usage: 'chat_completion',
      configSource: 1,
      function: 'solo_work_remote',
    })
  })

  it('merges the two sources without duplicating a model under one name', () => {
    const remote = parseTraeRemoteModels(remotePayload)
    const wire = parseTraeWireModels(wirePayload, 'solo_work_remote')
    const { models, meta } = mergeTraeModels(remote, wire)

    // `kimi-k2` has no config in any chat roster in this fixture, and
    // `gemini-3-pro` exists only in the wire roster; neither is a model the
    // client's picker offers, so both are absent.
    expect(models.map(model => model.id)).toEqual(['gpt-5', 'claude-4.5-sonnet'])
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
      reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
      defaultReasoningEffort: 'xhigh',
    })
    expect(meta.get('gpt-5')).toEqual({
      configName: 'gpt-5-2026',
      function: 'solo_work_remote',
      wireEfforts: { low: 'light', medium: 'medium', high: 'high', xhigh: 'extra_high' },
    })

    const claude = models.find(model => model.id === 'claude-4.5-sonnet')!
    expect(claude).toMatchObject({
      vision: true,
      priceFactor: 1.2,
      reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      // The strongest level the model publishes.
      defaultReasoningEffort: 'max',
    })
    // Matched by display name, so the callable config name is the dated one
    // Trae actually lists — not the directory id, which may not be accepted.
    expect(meta.get('claude-4.5-sonnet')).toMatchObject({
      configName: 'claude-4.5-sonnet-20260101',
      // The wire roster owns the call function; `solo_agent` rejected it live.
      function: 'solo_work_remote',
    })

    expect(meta.has('gemini-3-pro')).toBe(false)
  })

  it('never emits two rows with one id', () => {
    // The gateway can spell one config in both cases across groups, and DSH
    // rejects the whole provider when an id repeats.
    const remote = parseTraeRemoteModels({
      data: {
        list: [
          {
            function: 'solo_work_remote',
            models: [{ name: 'glm-5.3', display_name: 'GLM-5.3' }],
          },
          {
            function: 'solo_work_lite',
            models: [{ name: 'GLM-5.3', display_name: 'GLM-5.3' }],
          },
        ],
      },
    })
    expect(remote).toHaveLength(1)

    const wire = [{
      configName: 'glm-5.3', name: 'GLM-5.3',
      usage: 'chat_completion', configSource: 1, function: 'solo_work_remote', efforts: [],
    }]
    const merged = mergeTraeModels(remote, wire)
    expect(merged.models).toHaveLength(1)
    expect(merged.models[0]).toMatchObject({ id: 'glm-5.3', name: 'GLM 5.3' })
  })

  it('unions efforts from every group for one model', () => {
    // Live case: solo_work_lite reports `options: null` while chat_v3 publishes
    // light/high for the same id and the wider Max tier.
    const remote = parseTraeRemoteModels({
      data: {
        list: [
          {
            function: 'solo_work_lite',
            models: [{
              name: 'deepseek-v4.1-flash',
              display_name: 'DeepSeek-V4.1-Flash',
              context_window_tokens: { dev: 200_000, max: 0 },
              max_mode: false,
              reasoning_effort_config: { options: null },
            }],
          },
          {
            function: 'chat_v3',
            models: [{
              name: 'deepseek-v4.1-flash',
              display_name: 'DeepSeek-V4.1-Flash',
              context_window_tokens: { dev: 116_000, max: 1_000_000 },
              max_mode: true,
              multimodal: true,
              reasoning_effort_config: { options: ['light', 'high', 'extra_high'] },
            }],
          },
        ],
      },
    })
    expect(remote).toHaveLength(1)
    expect(remote[0]).toMatchObject({
      contextWindow: 116_000,
      maxContextWindow: 1_000_000,
      multimodal: true,
      efforts: ['low', 'high', 'xhigh'],
    })
  })

  it('collapses two rows with one display name to the wider one', () => {
    // Live case: the plain and `-Official` variants both normalize to
    // `DeepSeek V4 Flash`. The picker prints the name once, so the wider row
    // wins and no id is appended to the name.
    const remote = parseTraeRemoteModels({
      data: {
        list: [{
          function: 'solo_work_remote',
          models: [
            { name: 'DeepSeek-V4-Flash-Official', display_name: 'DeepSeek-V4-Flash', context_window_tokens: { dev: 200_000 } },
            { name: 'DeepSeek-V4-Flash', display_name: 'DeepSeek-V4-Flash', context_window_tokens: { dev: 116_000 } },
          ],
        }],
      },
    })
    const wire = [
      {
        configName: 'DeepSeek-V4-Flash-Official', name: 'DeepSeek-V4-Flash',
        usage: 'chat_completion', configSource: 1, function: 'solo_work_remote', efforts: [],
      },
      {
        configName: 'DeepSeek-V4-Flash', name: 'DeepSeek-V4-Flash',
        usage: 'chat_completion', configSource: 1, function: 'solo_work_remote', efforts: [],
      },
    ]
    const { models } = mergeTraeModels(remote, wire)
    expect(models).toHaveLength(1)
    expect(models[0]).toMatchObject({
      name: 'DeepSeek V4 Flash',
      contextWindow: 200_000,
    })
    // The shared naming rule never synthesizes brackets of its own.
    expect(models[0]!.name).not.toContain('(')
  })

  it('never promotes a model that only the wire roster lists', () => {
    const remote = parseTraeRemoteModels(remotePayload)
    const wire = parseTraeWireModels(wirePayload, 'solo_work_remote')
    const { models } = mergeTraeModels(remote, wire)
    // `gemini-3-pro` has a config but no directory row on a primary channel;
    // promoting it would resurface the legacy entries the client retired.
    expect(models.map(model => model.id)).not.toContain('gemini-3-pro')
  })

  it('hides a directory model with no callable config', () => {
    // Qwen3.8-Flash and Kimi-K2.8-Preview are listed by the directory but no
    // chat roster returns a config for them; selecting one can only answer 4001.
    const remote = [{
      id: 'qwen3.8-flash', name: 'Qwen3.8-Flash', contextWindow: 200_000,
      maxContextWindow: 1_000_000, multimodal: true, efforts: ['low', 'high', 'xhigh'],
    }]
    const { models } = mergeTraeModels(remote, [])
    expect(models).toEqual([])
  })

  it('never promotes internal wire configurations', () => {
    const wire = [
      {
        configName: 'custom_model_gpt-5', name: 'custom_model_gpt 5',
        usage: 'custom_model', configSource: 1, function: 'solo_work_remote', efforts: [],
      },
      {
        configName: 'summary', name: 'summary',
        usage: 'summary', configSource: 1, function: 'solo_work_remote', efforts: [],
      },
      {
        configName: 'computer_use_subagent', name: 'computer_use_subagent',
        usage: 'chat_completion', configSource: 1, function: 'solo_work_lite', efforts: [],
      },
      {
        configName: 'glm-5.3', name: 'GLM 5.3',
        usage: 'chat_completion', configSource: 1, function: 'solo_work_remote', efforts: ['low', 'high'],
      },
    ]
    const { models } = mergeTraeModels([], wire)
    // Without a primary directory row nothing is promoted, internal or not.
    expect(models).toEqual([])
  })

  it('keeps exactly the levels Trae publishes', () => {
    // Live directory for DeepSeek-V4.1-Flash: light/high/extra_high. The SOLO
    // endpoint answers 200 for `banana` too, so no level outside this list can
    // be claimed — there is no inferred `none` and no inferred `max`.
    const remote = [{
      id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash', contextWindow: 200_000,
      multimodal: true, efforts: ['low', 'high', 'xhigh'], primary: true,
    }]
    const wire = [{
      configName: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash', contextWindow: 200_000,
      usage: 'chat_completion', configSource: 1, function: 'solo_work_remote', efforts: [],
    }]
    const { models, meta } = mergeTraeModels(remote, wire)
    expect(models[0]).toMatchObject({
      vision: true,
      reasoningEfforts: ['low', 'high', 'xhigh'],
      defaultReasoningEffort: 'xhigh',
    })
    // Only advertised levels get a wire spelling.
    expect(meta.get('deepseek-v4.1-flash')?.wireEfforts).toEqual({
      low: 'light',
      high: 'high',
      xhigh: 'extra_high',
    })
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

  it('never sends an empty tool content array', () => {
    // An empty array is rejected as an invalid parameter; an empty text block
    // is the shape the gateway accepts when a tool produced no text.
    const messages = traeMessages([{ role: 'tool', content: [], tool_call_id: 'call_1' }])
    expect(messages[0]).toEqual({
      role: 'tool',
      tool_call_id: 'call_1',
      content: [{ type: 'text', text: '' }],
    })
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
      // Live shape: argument fragments repeat the index with `id: ""`.
      'event: output\ndata: {"tool_calls":[{"index":0,"id":"","type":"","function_call":{"name":"","arguments":"1}"}}]}',
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

  it('keeps one call per index with unique non-empty ids', async () => {
    const chunks = await collect(openTraeStream(stream([
      'event: output\ndata: {"tool_calls":[{"index":0,"id":"call_a","function_call":{"name":"read","arguments":"{}"}},{"index":1,"id":"call_b","function_call":{"name":"list","arguments":"{}"}}]}',
      'event: output\ndata: {"tool_calls":[{"index":0,"id":"","function_call":{"name":"","arguments":""}},{"index":1,"id":"","function_call":{"arguments":""}}]}',
      'event: done\ndata: {"finish_reason":"stop"}',
    ]), 'x'))
    const blocks = chunks
      .filter(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
      .map(chunk => chunk.block)
    expect(blocks.map(block => [block.id, block.name])).toEqual([
      ['call_a', 'read'],
      ['call_b', 'list'],
    ])
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
  })

  it('never emits an empty or duplicate call id', async () => {
    const chunks = await collect(openTraeStream(stream([
      'event: output\ndata: {"tool_calls":[{"index":0,"function_call":{"name":"read","arguments":"{}"}},{"index":1,"id":"call_same","function_call":{"name":"list","arguments":"{}"}},{"index":2,"id":"call_same","function_call":{"name":"list2","arguments":"{}"}}]}',
    ]), 'x'))
    const ids = chunks
      .filter(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
      .map(chunk => chunk.block.id)
    expect(ids).toHaveLength(3)
    for (const id of ids) expect(String(id).length).toBeGreaterThan(0)
    expect(new Set(ids).size).toBe(3)
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

  it('reads the international dollar usage and its reset date', () => {
    const payload = {
      is_dollar_usage_billing: true,
      trial_status: { is_in_trial: false, trial_end_time: 1_793_231_149 },
      user_entitlement_pack_list: [{
        display_desc: 'Free plan',
        entitlement_base_info: {
          end_time: 1_793_491_199,
          product_extra: { subscription_extra: { quota: { basic_usage_limit: 1, credits_limit: 0 } } },
          quota: { basic_usage_limit: 1, credits_limit: 0 },
        },
        usage: { basic_usage_amount: 0, credits_amount: 0 },
      }],
    }
    expect(parseTraeGlobalUsage(payload)).toMatchObject({
      plan: 'Free plan',
      unit: 'usd',
      total: 1,
      used: 0,
      // The site's "Reset at 2026/11/01 08:00" (end_time is the last second).
      resetAt: 1_793_491_200_000,
      trialEndsAt: 1_793_231_149_000,
    })
  })

  it('reads a paid dollar allowance and ignores hidden packs', () => {
    const payload = {
      is_dollar_usage_billing: true,
      user_entitlement_pack_list: [
        { display_desc: 'Hidden', is_hide: true, entitlement_base_info: { end_time: 1 } },
        {
          display_desc: 'Pro plan',
          entitlement_base_info: {
            end_time: 1_800_000_000,
            product_extra: { subscription_extra: { quota: { basic_usage_limit: 20 } } },
          },
          usage: { basic_usage_amount: 3.5 },
        },
      ],
    }
    expect(parseTraeGlobalUsage(payload)).toMatchObject({
      plan: 'Pro plan',
      unit: 'usd',
      total: 20,
      used: 3.5,
      resetAt: 1_800_000_001_000,
    })
  })

  it('keeps credits when the international account is not dollar billed', () => {
    expect(parseTraeGlobalUsage({
      is_dollar_usage_billing: false,
      user_entitlement_pack_list: [{
        display_desc: 'Pro plan',
        entitlement_base_info: { end_time: 1_800_000_000, quota: { credits_limit: 5000 } },
        usage: { credits_amount: 1200 },
      }],
    })).toMatchObject({ plan: 'Pro plan', total: 5000, used: 1200 })
  })

  it('reads the client check-in state and ignores campaign extras', () => {
    expect(parseTraeCheckin({
      enable: true,
      checked_in: false,
      did_checked_in: true,
      credits: 100,
      extra_credits: 100,
      message: 'success',
    })).toEqual({
      available: true,
      claimed: false,
      deviceClaimed: true,
      reward: 100,
      message: 'success',
    })
    expect(parseTraeCheckin({ enable: false })).toMatchObject({
      available: false,
      claimed: false,
      deviceClaimed: false,
    })
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

  function token(expiresAt: number): string {
    const body = Buffer.from(JSON.stringify({ exp: Math.floor(expiresAt / 1000) })).toString('base64url')
    return `header.${body}.signature`
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

  it('uses the JWT expiry when an older record stored the website-session expiry', async () => {
    const { store } = make('cn')
    const jwtExpiresAt = Math.floor((Date.now() + 3600_000) / 1000) * 1000
    const auth = new TraeAuth(store, () => 'cn')
    await store.saveTrae({
      ...record,
      accessToken: token(jwtExpiresAt),
      // The previous implementation wrote the 14-day session expiry here.
      expiresAt: Date.now() + 14 * 24 * 3600_000,
    })
    const status = await auth.status()
    expect(status).toMatchObject({ signedIn: true, expiresAt: jwtExpiresAt })
  })

  it('renews the short-lived token with the stored website cookies', async () => {
    const { store } = make('cn')
    const fresh = token(Date.now() + 8 * 3600_000)
    const sessionExpiresAt = Date.now() + 14 * 24 * 3600_000
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toContain('/cloudide/api/v3/common/GetUserToken')
      expect((init?.headers as Record<string, string>).cookie).toBe('sid=abc')
      return json({ Result: { Token: fresh, ExpiredAt: Math.floor(sessionExpiresAt / 1000) } })
    })
    const auth = new TraeAuth(store, () => 'cn', fetchImpl as unknown as typeof fetch)
    await store.saveTrae({
      ...record,
      accessToken: token(Date.now() - 1000),
      expiresAt: Date.now() - 1000,
      cookies: 'sid=abc',
      sessionExpiresAt,
    })
    expect(await auth.status()).toMatchObject({ signedIn: true, expiresAt: sessionExpiresAt })
    await expect(auth.accessToken()).resolves.toBe(fresh)
    expect(await store.trae('cn')).toMatchObject({ accessToken: fresh, cookies: 'sid=abc' })
  })

  it('asks for a new sign-in when the website session is gone', async () => {
    const { store } = make('cn')
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 401 }))
    const auth = new TraeAuth(store, () => 'cn', fetchImpl as unknown as typeof fetch)
    await store.saveTrae({
      ...record,
      accessToken: token(Date.now() - 1000),
      expiresAt: Date.now() - 1000,
      cookies: 'sid=old',
      sessionExpiresAt: Date.now() + 24 * 3600_000,
    })
    await expect(auth.accessToken()).rejects.toThrow('网页会话已失效')
  })

  it('keeps a client token until its own expiry and never uses the cookie refresh', async () => {
    const { store } = make('cn')
    const fetchImpl = vi.fn()
    const auth = new TraeAuth(store, () => 'cn', fetchImpl as unknown as typeof fetch)
    // The JWT carries whole seconds, and that expiry wins over the stored one.
    const expiresAt = Math.floor((Date.now() + 24 * 3600_000) / 1000) * 1000
    await store.saveTrae({
      ...record,
      source: 'client',
      accessToken: token(expiresAt),
      expiresAt,
    })
    expect(await auth.status()).toMatchObject({
      signedIn: true,
      loginSource: 'client',
      expiresAt,
    })
    await expect(auth.accessToken()).resolves.toBe(token(expiresAt))
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('asks for a fresh client import when the client token expires', async () => {
    const { store } = make('cn')
    const auth = new TraeAuth(store, () => 'cn')
    const expired = Date.now() - 1_000
    await store.saveTrae({
      ...record,
      source: 'client',
      accessToken: token(expired),
      expiresAt: expired,
      cookies: 'sid=should-not-be-used',
    })
    expect(await auth.status()).toMatchObject({
      signedIn: false,
      loginSource: 'client',
      possiblyExpired: true,
    })
    await expect(auth.accessToken()).rejects.toThrow('客户端')
    await expect(auth.accessToken()).rejects.toThrow('复用客户端登录态')
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
  function make(
    region: 'cn' | 'global',
    fetchImpl: typeof fetch,
    router: { models(): Promise<typeof EMPTY_OPENROUTER_INDEX>, invalidate(): void } = {
      models: async () => EMPTY_OPENROUTER_INDEX,
      invalidate: () => undefined,
    },
    authOverrides: Record<string, unknown> = {},
    extra: Partial<TraeProviderOptions> = {},
  ) {
    const auth = {
      status: async () => ({ signedIn: true }),
      accessToken: async () => 'tok',
      identity: async () => ({ deviceId: 'dev-1', machineId: 'mach-1', userId: 'u-1' }),
      logout: async () => undefined,
      ...authOverrides,
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
      openRouter: router,
      fetchImpl,
      ...extra,
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

  it('takes levels and modalities from the shared OpenRouter matcher', async () => {
    const index = buildOpenRouterIndex([{
      id: 'openai/gpt-5',
      name: 'OpenAI: GPT-5',
      inputModalities: ['text'],
      efforts: ['max', 'high', 'low'],
      mandatory: false,
    }])
    const { provider } = make('cn', catalogFetch(), {
      models: async () => index,
      invalidate: () => undefined,
    })
    const models = await provider.models()
    // `gpt-5` in the fixture declares no multimodal flag; OpenRouter says text
    // only, so the live modality list wins. The directory's `low/high/xhigh`
    // is replaced by OpenRouter's three levels.
    expect(models.find(model => model.id === 'gpt-5')).toMatchObject({
      vision: false,
      reasoningEfforts: ['max', 'high', 'low'],
      defaultReasoningEffort: 'max',
    })
  })

  it('exposes every level when neither source names one', () => {
    // The shared rule: no OpenRouter match and an empty directory declaration
    // falls back to all levels, with the strongest as the default.
    const { models } = mergeTraeModels(
      [{ id: 'x-model', name: 'X Model', multimodal: false, efforts: [], primary: true }],
      [{
        configName: 'x-model',
        name: 'X Model',
        usage: 'chat_completion',
        configSource: 1,
        function: 'solo_work_remote',
        efforts: [],
      }],
    )
    expect(models[0]).toMatchObject({
      vision: false,
      reasoningEfforts: ALL_REASONING_EFFORTS,
      defaultReasoningEffort: 'max',
    })
  })

  it('merges the directory and the wire roster behind one catalog', async () => {
    const { provider } = make('cn', catalogFetch())
    const models = await provider.models()
    expect(models.map(model => model.id)).toEqual(['gpt-5', 'claude-4.5-sonnet'])
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
      return new Response(
        stream(['event: output\ndata: {"response":"ok"}', 'event: done\ndata: {"finish_reason":"stop"}']),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    })
    const { provider } = make('cn', fetchMock as unknown as typeof fetch)
    const chunks = await collect(provider.stream(
      { ...options, reasoningEffort: 'high' as never, maxTokens: 4096 },
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
      max_tokens: 4096,
      stream: true,
    })
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('applies forced vision and text-only IDs', async () => {
    const provider = new TraeProvider({
      auth: {
        status: async () => ({ signedIn: true }),
        accessToken: async () => 'tok',
        identity: async () => ({ deviceId: 'dev-1', machineId: 'mach-1' }),
        logout: async () => undefined,
      } as never,
      store: { saveTrae: vi.fn() } as never,
      region: () => 'cn',
      ttlMs: () => 1000,
      timeoutMs: () => 1000,
      textOnly: () => new Set(['claude-4.5-sonnet']),
      forceVision: () => new Set(['gpt-5']),
      fetchImpl: catalogFetch(),
    })
    const models = await provider.models()
    expect(models.find(model => model.id === 'claude-4.5-sonnet')?.vision).toBe(false)
    expect(models.find(model => model.id === 'gpt-5')?.vision).toBe(true)
  })

  it('reads the mainland quota', async () => {
    const seen: string[] = []
    const fetchMock = vi.fn(async (url: string) => {
      seen.push(url)
      if (url.endsWith('/web_user_ent_usage')) {
        return json({ data: { usage_summary: { total_amount: 10, consumed_amount: 2, consumption_ratio: 20 } } })
      }
      throw new Error(`unexpected ${url}`)
    })
    const { provider } = make('cn', fetchMock as unknown as typeof fetch)
    expect(await provider.quota(true)).toMatchObject({ total: 10, used: 2, ratio: 20 })
    expect(seen[0]).toBe('https://api.trae.cn/trae/api/v2/pay/web_user_ent_usage')
  })

  it('reads the international dollar quota from the v1 roster', async () => {
    const seen: string[] = []
    const fetchMock = vi.fn(async (url: string) => {
      seen.push(url)
      if (url.endsWith('/web_user_ent_usage')) {
        return json({
          is_dollar_usage_billing: true,
          user_entitlement_pack_list: [{
            display_desc: 'Pro plan',
            entitlement_base_info: {
              end_time: 1_800_000_000,
              product_extra: { subscription_extra: { quota: { basic_usage_limit: 20 } } },
            },
            usage: { basic_usage_amount: 1.25 },
          }],
        })
      }
      throw new Error(`unexpected ${url}`)
    })
    const { provider } = make('global', fetchMock as unknown as typeof fetch)
    expect(await provider.quota(true)).toMatchObject({
      plan: 'Pro plan', unit: 'usd', total: 20, used: 1.25,
    })
    // The international edition uses the v1 roster; v2 is mainland-only.
    expect(seen[0]).toBe('https://growsg-normal.trae.ai/trae/api/v1/pay/web_user_ent_usage')
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
      if (url.includes('/get_detail_param')) {
        return json({
          config_info_list: [{
            config_name: region === 'cn' ? 'cn-model' : 'global-model',
            display_config: { display_name: region === 'cn' ? 'CN' : 'Global' },
            usage: 'chat_completion',
            config_source: 1,
            model_detail_list: [{}],
          }],
        })
      }
      if (url.endsWith('/web_user_ent_usage')) {
        return json(region === 'cn'
          ? { data: { usage_summary: { total_amount: 1 } } }
          : {
              is_dollar_usage_billing: true,
              user_entitlement_pack_list: [{
                display_desc: 'Free plan',
                entitlement_base_info: {
                  end_time: 1_800_000_000,
                  product_extra: { subscription_extra: { quota: { basic_usage_limit: 1 } } },
                },
                usage: { basic_usage_amount: 0 },
              }],
            })
      }
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

    region = 'global'
    // The other deployment has its own directory and quota shape.
    expect((await provider.models()).map(model => model.id)).toEqual(['global-model'])
    expect(await provider.quota()).toMatchObject({ plan: 'Free plan', unit: 'usd', total: 1, used: 0 })
  })

  it('reports a clear error for a model outside the catalog', async () => {
    const { provider } = make('cn', catalogFetch())
    await provider.models()
    await expect(collect(provider.stream(options, 'qwen3.8-flash', undefined, () => undefined)))
      .rejects.toThrow('只存在于 Trae 客户端通道')
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

  it('keeps the cached catalogue after a normal turn', async () => {
    const onInvalidate = vi.fn()
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/api/remote/v1/models')) return json(remotePayload)
      if (url.includes('/get_detail_param')) return json(wirePayload)
      return new Response(
        stream(['event: output\ndata: {"response":"ok"}', 'event: done\ndata: {"finish_reason":"stop"}']),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    })
    const { provider } = make('cn', fetchMock as unknown as typeof fetch)
    await collect(provider.stream(options, 'gpt-5', undefined, onInvalidate))
    // Dropping the catalogue after every turn made the next model switch wait
    // for a full directory read; only a lost login may invalidate now.
    expect(onInvalidate).not.toHaveBeenCalled()
  })

  it('invalidates when the login cannot be renewed', async () => {
    const onInvalidate = vi.fn()
    const auth = {
      status: async () => ({ signedIn: true }),
      accessToken: async (force = false) => {
        if (force) throw new Error('Trae 国内版网页会话已失效，请重新登录。')
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
    await expect(collect(provider.stream(options, 'gpt-5', undefined, onInvalidate)))
      .rejects.toThrow('网页会话已失效')
    expect(onInvalidate).toHaveBeenCalledOnce()
  })

  it('offers check-in only for a login imported from the local client', async () => {
    const fetchMock = vi.fn()
    const { provider } = make('cn', fetchMock as unknown as typeof fetch, undefined, {
      status: async () => ({ signedIn: true, loginSource: 'web' }),
    })
    expect(await provider.checkinStatus()).toMatchObject({ available: false })
    await expect(provider.claimCheckin()).rejects.toThrow('仅在复用本机 Trae 客户端登录时可用')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('uses the client device id and machine id for the check-in status', async () => {
    const calls: { url: string, init?: RequestInit }[] = []
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      return json({ enable: true, checked_in: false, did_checked_in: false, credits: 100 })
    })
    const { provider } = make(
      'cn',
      fetchMock as unknown as typeof fetch,
      undefined,
      {
        status: async () => ({ signedIn: true, loginSource: 'client' }),
        accessToken: async () => 'client-token',
        identity: async () => ({ deviceId: '2715142696215459', machineId: 'client-machine' }),
      },
    )
    expect(await provider.checkinStatus()).toMatchObject({
      available: true, claimed: false, deviceClaimed: false, reward: 100,
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toContain('/trae/api/v2/ug/checkin_credits/status')
    const headers = calls[0]!.init?.headers as Record<string, string>
    // The old derived id was rejected with 9074; the client's own id is used.
    expect(headers['x-device-id']).toBe('2715142696215459')
    expect(headers['x-machine-id']).toBe('client-machine')
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ req_source: 1 })
  })

  it('claims the client check-in and reports its reward', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toContain('/trae/api/v2/ug/checkin_credits/claim')
      return json({ code: 0, credits: 100, message: 'success' })
    })
    const { provider } = make(
      'cn',
      fetchMock as unknown as typeof fetch,
      undefined,
      {
        status: async () => ({ signedIn: true, loginSource: 'client' }),
        identity: async () => ({ deviceId: '2715142696215459', machineId: 'client-machine' }),
      },
    )
    expect(await provider.claimCheckin()).toMatchObject({
      available: true, claimed: true, deviceClaimed: false, reward: 100,
    })
  })

  it('reports the device-level claim separately', async () => {
    const { provider } = make(
      'cn',
      vi.fn(async () => json({ code: 9095, message: '本机今日已签到' })) as unknown as typeof fetch,
      undefined,
      {
        status: async () => ({ signedIn: true, loginSource: 'client' }),
        identity: async () => ({ deviceId: '2715142696215459', machineId: 'client-machine' }),
      },
    )
    expect(await provider.claimCheckin()).toMatchObject({
      available: true, claimed: false, deviceClaimed: true,
    })
  })

  it('has no check-in on the international deployment', async () => {
    const { provider } = make('global', vi.fn() as unknown as typeof fetch, undefined, {
      status: async () => ({ signedIn: true, loginSource: 'client' }),
    })
    expect(await provider.checkinStatus()).toMatchObject({
      available: false,
      message: expect.stringContaining('国际版'),
    })
  })

  it('imports the local client login into the account store', async () => {
    const detection: TraeClientDetection = {
      status: { available: true, signedIn: true, name: '星喵', userId: 'u-client', expiresAt: 123 },
      state: {
        region: 'cn',
        token: 'client-token',
        deviceId: '2715142696215459',
        machineId: 'client-machine',
        userId: 'u-client',
        name: '星喵',
        expiresAt: 123,
      },
    }
    const { provider, store } = make(
      'cn',
      vi.fn() as unknown as typeof fetch,
      undefined,
      {},
      { clientLogin: () => detection },
    )
    await provider.importClientLogin()
    expect(store.saveTrae).toHaveBeenCalledWith({
      accessToken: 'client-token',
      region: 'cn',
      source: 'client',
      deviceId: '2715142696215459',
      machineId: 'client-machine',
      loginAt: expect.any(Number),
      userId: 'u-client',
      name: '星喵',
      expiresAt: 123,
    })
  })

  it('refuses to import when the local client is not signed in', async () => {
    const { provider } = make(
      'cn',
      vi.fn() as unknown as typeof fetch,
      undefined,
      {},
      {
        clientLogin: () => ({
          status: { available: true, signedIn: false, error: '本机 Trae 客户端尚未登录。' },
        }),
      },
    )
    await expect(provider.importClientLogin()).rejects.toThrow('尚未登录')
  })
})
