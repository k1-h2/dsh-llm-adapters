import { describe, expect, it, vi } from 'vitest'
import {
  ModelCatalog, parseLoomyCatalog, parseRaccoonCatalog, priceFactorOf,
} from '../src/catalog.ts'
import { buildOpenRouterIndex, type OpenRouterModel } from '../src/openrouter.ts'

describe('priceFactorOf', () => {
  it('reads x/× and 倍 multipliers', () => {
    expect(priceFactorOf('DeepSeek V4 (x3.0)')).toBe(3)
    expect(priceFactorOf('Spark × 0.1')).toBe(0.1)
    expect(priceFactorOf('Qwen 12倍')).toBe(12)
    expect(priceFactorOf('GLM-5.3')).toBeUndefined()
  })
})

describe('parseLoomyCatalog', () => {
  const payload = {
    data: [
      {
        id: 'spark-x',
        name: 'Spark X (x0.1)',
        context_length: 1_000_000,
        max_output_tokens: 32_000,
        capabilities: { reasoning: true, vision: true },
        reasoning_efforts: [{ value: 'low' }, 'high'],
      },
      {
        id: 'deepseek-v4-flash-0731',
        name: 'DeepSeek V4 Flash (x3.0)',
        context_length: 200_000,
        capabilities: { reasoning: false, vision: false },
      },
    ],
  }

  it('projects the OpenAI-style list and its multiplier', () => {
    const models = parseLoomyCatalog(payload)
    expect(models).toHaveLength(2)
    expect(models[0]).toMatchObject({
      id: 'spark-x',
      name: 'Spark X (x0.1)',
      contextWindow: 1_000_000,
      maxTokens: 32_000,
      vision: true,
      reasoning: true,
      reasoningEfforts: ['low', 'high'],
      priceFactor: 0.1,
    })
    expect(models[1]).toMatchObject({ vision: false, reasoning: false, priceFactor: 3 })
  })

  it('honours text-only over force-vision over the catalog tag', () => {
    const textOnly = parseLoomyCatalog(payload, {
      textOnly: new Set(['spark-x']),
      forceVision: new Set(['spark-x']),
    })
    expect(textOnly[0]!.vision).toBe(false)
    const forced = parseLoomyCatalog(payload, { forceVision: new Set(['deepseek-v4-flash-0731']) })
    expect(forced[1]!.vision).toBe(true)
  })

  it('accepts models/direct-array envelopes', () => {
    expect(parseLoomyCatalog([{ id: 'a' }])[0]!.id).toBe('a')
    expect(parseLoomyCatalog({ models: [{ id: 'b' }] })[0]!.id).toBe('b')
    expect(parseLoomyCatalog({ data: { models: [{ id: 'c' }] } })[0]!.id).toBe('c')
  })
})

describe('parseRaccoonCatalog', () => {
  const payload = {
    code: 0,
    data: {
      categories: [
        { type: 'image', models: [{ name: 'ignored' }] },
        {
          type: 'chat',
          default_model: 'sn-sensenova-6-8-flash-lite',
          models: [
            {
              name: 'sn-sensenova-6-8-flash-lite',
              description: 'SenseNova-6.8-Flash-Lite',
              display_description: '适合简单问答和摘要等轻量任务',
              context_window: 1,
              visible: true,
              tags: ['vision'],
              params: { context_window: 256_000, max_tokens: 63_999 },
              billing_multiplier: 0.5,
              billing_effective_multiplier: 0,
              billing_status: 'limited_free',
              billing_status_note: '限免一个月',
            },
            {
              name: 'sn-glm-5-3',
              description: 'GLM-5-3',
              display_description: '适合复杂办公任务和代码开发',
              visible: true,
              tags: ['vision', 'reasoning'],
              params: { context_window: 1_000_000, max_tokens: 100_000 },
              billing_multiplier: 0.75,
            },
            {
              name: 'sn-glm-5-3-flash',
              description: 'GLM-5-3-Flash',
              display_description: '适合通用对话和轻量代码',
              visible: true,
              tags: ['fast'],
              params: { context_window: 1_000_000, max_tokens: 100_000 },
              billing_multiplier: 0.1,
              billing_status: 'discount',
            },
            { name: 'raccoon-work', visible: true },
            { name: 'hidden-model', visible: false },
          ],
        },
      ],
    },
  }

  it('reads the chat category, labels, prices and badges', () => {
    const models = parseRaccoonCatalog(payload)
    expect(models.map(model => model.id)).toEqual([
      'sn-sensenova-6-8-flash-lite', 'sn-glm-5-3', 'sn-glm-5-3-flash',
    ])
    expect(models[0]).toMatchObject({
      name: 'SenseNova-6.8-Flash-Lite',
      description: '适合简单问答和摘要等轻量任务',
      contextWindow: 256_000,
      maxTokens: 63_999,
      priceFactor: 0,
      badge: '限免一个月',
      reasoning: true,
      reasoningEfforts: ['on', 'off'],
      defaultReasoningEffort: 'off',
      reasoningEffortNames: { on: '开启思考', off: '关闭思考' },
    })
    expect(models[2]!.badge).toBe('折扣')
  })

  it('reads vision from upstream tags when no OpenRouter entry is given', () => {
    const models = parseRaccoonCatalog(payload)
    const byId = Object.fromEntries(models.map(model => [model.id, model]))
    // Without live metadata the parser trusts the catalog tag; the OpenRouter
    // tests below cover the correction path.
    expect(byId['sn-glm-5-3']!.vision).toBe(true)
    expect(byId['sn-glm-5-3-flash']!.vision).toBe(false)
  })

  it('lets explicit overrides win', () => {
    const models = parseRaccoonCatalog(payload, {
      textOnly: new Set(['sn-glm-5-3-flash']),
      forceVision: new Set(['sn-glm-5-3']),
    })
    const byId = Object.fromEntries(models.map(model => [model.id, model]))
    expect(byId['sn-glm-5-3-flash']!.vision).toBe(false)
    expect(byId['sn-glm-5-3']!.vision).toBe(true)
  })

  it('adopts effort levels and modalities from the live OpenRouter metadata', () => {
    const openRouter = buildOpenRouterIndex([
      {
        id: 'moonshotai/kimi-k3', name: 'MoonshotAI: Kimi K3',
        inputModalities: ['text', 'image', 'video'],
        efforts: ['max', 'high', 'low', 'none'], defaultEffort: 'max', mandatory: false,
      },
      {
        id: 'z-ai/glm-5.3', name: 'Z.ai: GLM 5.3',
        inputModalities: ['text'],
        efforts: ['max', 'high', 'low'], defaultEffort: 'max', mandatory: true,
      },
      {
        id: 'z-ai/glm-5.3-flash', name: 'Z.ai: GLM 5.3 Flash',
        inputModalities: ['text', 'image', 'video'],
        efforts: ['max', 'high', 'low'], defaultEffort: 'max', mandatory: true,
      },
      {
        id: 'deepseek/deepseek-v4.1-flash-1017', name: 'DeepSeek: DeepSeek V4.1 Flash 1017',
        inputModalities: ['text', 'image'],
        efforts: ['max', 'high', 'low', 'none'], defaultEffort: 'high', mandatory: false,
      },
    ])
    const models = parseRaccoonCatalog({
      data: {
        categories: [{
          type: 'chat',
          models: [
            { name: 'sn-deepseek-v4-1-flash-1017', description: 'DeepSeek-V4.1-Flash-1017', visible: true, tags: ['code'], params: { context_window: 1_000_000, max_tokens: 100_000 } },
            { name: 'sn-glm-5-3', description: 'GLM-5-3', visible: true, tags: ['vision', 'reasoning'], params: { context_window: 1_000_000, max_tokens: 100_000 } },
            { name: 'sn-glm-5-3-flash', description: 'GLM-5-3-Flash', visible: true, tags: ['fast'], params: { context_window: 1_000_000, max_tokens: 100_000 } },
            { name: 'sn-kimi-k3', description: 'Kimi-K3', visible: true, tags: ['vision'], params: { context_window: 1_000_000, max_tokens: 100_000 } },
          ],
        }],
      },
    }, { openRouter })
    // OpenRouter says: 1017 has image, GLM-5.3 is text-only, Flash has image, Kimi has image.
    const byId = Object.fromEntries(models.map(model => [model.id, model]))
    expect(byId['sn-deepseek-v4-1-flash-1017']!.vision).toBe(true)
    expect(byId['sn-glm-5-3']!.vision).toBe(false)
    expect(byId['sn-glm-5-3-flash']!.vision).toBe(true)
    expect(byId['sn-kimi-k3']!.vision).toBe(true)
    // Effort lists come from OpenRouter, not from upstream (which has none).
    expect(byId['sn-deepseek-v4-1-flash-1017']!.reasoningEfforts).toEqual(['max', 'high', 'low', 'none'])
    expect(byId['sn-glm-5-3']!.reasoningEfforts).toEqual(['max', 'high', 'low'])
    expect(byId['sn-kimi-k3']!.reasoningEfforts).toEqual(['max', 'high', 'low', 'none'])
    // Default is the cheapest available level, not OpenRouter's `max`.
    expect(byId['sn-deepseek-v4-1-flash-1017']!.defaultReasoningEffort).toBe('none')
    expect(byId['sn-glm-5-3']!.defaultReasoningEffort).toBe('low')
  })

  it('keeps the two-state switch for models that have no OpenRouter entry', () => {
    const openRouter = buildOpenRouterIndex([
      { id: 'other/model', name: 'Other Model', inputModalities: ['text'], efforts: ['none'], mandatory: false },
    ])
    const models = parseRaccoonCatalog({
      data: {
        categories: [{
          type: 'chat',
          models: [
            { name: 'sn-sensenova-6-8-flash-lite', description: 'SenseNova-6.8-Flash-Lite', visible: true, tags: ['vision'], params: { context_window: 256_000, max_tokens: 63_999 } },
          ],
        }],
      },
    }, { openRouter })
    expect(models[0]).toMatchObject({
      vision: true,
      reasoningEfforts: ['on', 'off'],
      defaultReasoningEffort: 'off',
    })
  })

  it('lets explicit overrides win over OpenRouter modalities', () => {
    const openRouter = buildOpenRouterIndex([
      { id: 'z-ai/glm-5.3', name: 'Z.ai: GLM 5.3', inputModalities: ['text', 'image'], efforts: ['none'], mandatory: false },
    ])
    const models = parseRaccoonCatalog({
      data: {
        categories: [{
          type: 'chat',
          models: [
            { name: 'sn-glm-5-3', description: 'GLM-5-3', visible: true, tags: ['vision'], params: { context_window: 1_000_000, max_tokens: 100_000 } },
          ],
        }],
      },
    }, { openRouter, textOnly: new Set(['sn-glm-5-3']), forceVision: new Set(['sn-glm-5-3']) })
    expect(models[0]!.vision).toBe(false)
  })
})

describe('ModelCatalog', () => {
  it('caches, bypasses on fresh, and retains the last list after failure', async () => {
    let calls = 0
    const load = vi.fn(async () => {
      calls++
      if (calls === 3) throw new Error('offline')
      return [{ id: `m${calls}`, name: 'm', contextWindow: 1, vision: false, reasoning: false }]
    })
    const catalog = new ModelCatalog(load, () => 60_000)
    expect((await catalog.models())[0]!.id).toBe('m1')
    expect((await catalog.models())[0]!.id).toBe('m1')
    expect(load).toHaveBeenCalledTimes(1)
    expect((await catalog.models(true))[0]!.id).toBe('m2')
    expect((await catalog.models(true))[0]!.id).toBe('m2')
    expect(catalog.error()).toBe('offline')
  })
})
