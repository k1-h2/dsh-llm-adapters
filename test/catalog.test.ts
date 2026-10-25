import { describe, expect, it, vi } from 'vitest'
import {
  ALL_REASONING_EFFORTS, ModelCatalog, parseLoomyCatalog, parseRaccoonCatalog, priceFactorOf,
} from '../src/catalog.ts'
import { buildOpenRouterIndex } from '../src/openrouter.ts'
import { modelKey, parseModelName } from '../src/model-name.ts'

describe('parseModelName', () => {
  it('removes price brackets and turns other bracket contents into labels', () => {
    expect(parseModelName('Spark-X2.6 正式版(限时免费)(x0.0)')).toEqual({
      name: 'Spark X2.6 正式版',
      labels: ['限时免费'],
      priceFactor: 0,
    })
    expect(parseModelName('qwen 3.8 flash（x0.8）')).toEqual({
      name: 'qwen 3.8 flash',
      labels: [],
      priceFactor: 0.8,
    })
    expect(parseModelName('GLM 5.3 Flash (Soon)')).toEqual({
      name: 'GLM 5.3 Flash',
      labels: ['Soon'],
    })
  })

  it('normalizes version hyphens and keeps a clean product name', () => {
    expect(parseModelName('GLM-5-3').name).toBe('GLM 5.3')
    expect(parseModelName('GLM-5-3-Flash').name).toBe('GLM 5.3 Flash')
    expect(parseModelName('DeepSeek-V4.1-Flash-1017').name).toBe('DeepSeek V4.1 Flash 1017')
    expect(parseModelName('Kimi-K3').name).toBe('Kimi K3')
  })

  it('builds a comparison key that ignores separators and the sn- prefix', () => {
    expect(modelKey('sn-GLM-5.3-Flash')).toBe('glm53flash')
    expect(modelKey('DeepSeek V4.1 Flash 1017')).toBe('deepseekv41flash1017')
    expect(modelKey('Kimi-K3')).toBe('kimik3')
  })
})

describe('priceFactorOf', () => {
  it('reads bracketed or separated multipliers', () => {
    expect(priceFactorOf('DeepSeek V4 (x3.0)')).toBe(3)
    expect(priceFactorOf('Spark × 0.1')).toBe(0.1)
    expect(priceFactorOf('Qwen 12倍')).toBe(12)
  })

  it('does not mistake a model name like Spark-X2.6 for a multiplier', () => {
    expect(priceFactorOf('Spark-X2.6')).toBeUndefined()
    expect(priceFactorOf('GLM-5.3')).toBeUndefined()
  })
})

describe('parseLoomyCatalog', () => {
  const payload = {
    data: [
      {
        id: 'spark-x2.6',
        name: 'Spark-X2.6 正式版(限时免费)(x0.0)',
        context_length: 1_048_576,
        max_output_tokens: 32_000,
        capabilities: { reasoning: true, vision: false, input_modalities: ['text'] },
        reasoning_efforts: ['none', 'low', 'medium', 'high', 'xhigh'],
        default_reasoning_effort: 'low',
      },
      {
        id: 'deepseek-v4-flash-0731',
        name: 'DeepSeek-V4.1-Flash(x3.0)',
        context_length: 200_000,
        capabilities: { reasoning: false, vision: false },
      },
    ],
  }

  it('normalizes names, labels and prices', () => {
    const models = parseLoomyCatalog(payload)
    expect(models).toHaveLength(2)
    expect(models[0]).toMatchObject({
      id: 'spark-x2.6',
      name: 'Spark X2.6 正式版',
      labels: ['限时免费'],
      priceFactor: 0,
      contextWindow: 1_048_576,
      maxTokens: 32_000,
      vision: false,
      reasoning: true,
      defaultReasoningEffort: 'low',
    })
    expect(models[1]).toMatchObject({
      name: 'DeepSeek V4.1 Flash',
      priceFactor: 3,
      vision: false,
      reasoning: false,
    })
  })

  it('keeps every effort id raw instead of translating it', () => {
    const models = parseLoomyCatalog(payload)
    expect(models[0]!.reasoningEfforts).toEqual(['none', 'low', 'medium', 'high', 'xhigh'])
  })

  it('prefers live OpenRouter capabilities over the upstream declaration', () => {
    const openRouter = buildOpenRouterIndex([{
      id: 'deepseek/deepseek-v4.1-flash',
      name: 'DeepSeek: DeepSeek V4.1 Flash',
      inputModalities: ['text', 'image'],
      efforts: ['max', 'high', 'low', 'none'],
      mandatory: false,
    }])
    const models = parseLoomyCatalog(payload, { openRouter })
    expect(models[1]).toMatchObject({
      vision: true,
      reasoning: true,
      defaultReasoningEffort: 'none',
    })
    expect(models[1]!.reasoningEfforts).toEqual(['max', 'high', 'low', 'none'])
  })

  it('honours text-only over force-vision', () => {
    const textOnly = parseLoomyCatalog(payload, {
      textOnly: new Set(['spark-x2.6']),
      forceVision: new Set(['spark-x2.6']),
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

  it('opens every effort and modality when neither source knows the model', () => {
    const models = parseLoomyCatalog({ data: [{ id: 'mystery', name: 'Mystery-1' }] })
    expect(models[0]).toMatchObject({
      name: 'Mystery 1',
      vision: true,
      reasoning: true,
      reasoningEfforts: ALL_REASONING_EFFORTS,
      defaultReasoningEffort: 'none',
    })
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

  it('shows normalized product names, prices and badges', () => {
    const models = parseRaccoonCatalog(payload)
    expect(models.map(model => model.id)).toEqual([
      'sn-sensenova-6-8-flash-lite', 'sn-glm-5-3', 'sn-glm-5-3-flash',
    ])
    expect(models[0]).toMatchObject({
      name: 'SenseNova 6.8 Flash Lite',
      description: '适合简单问答和摘要等轻量任务',
      contextWindow: 256_000,
      maxTokens: 63_999,
      priceFactor: 0,
      badge: '限免一个月',
      reasoning: true,
      defaultReasoningEffort: 'none',
    })
    expect(models[1]!.name).toBe('GLM 5.3')
    expect(models[2]!.name).toBe('GLM 5.3 Flash')
    expect(models[2]!.badge).toBe('折扣')
  })

  it('falls back to upstream tags and opens all efforts when OpenRouter has no entry', () => {
    const models = parseRaccoonCatalog(payload)
    const byId = Object.fromEntries(models.map(model => [model.id, model]))
    expect(byId['sn-glm-5-3']!.vision).toBe(true)
    expect(byId['sn-glm-5-3-flash']!.vision).toBe(false)
    expect(byId['sn-sensenova-6-8-flash-lite']!.reasoningEfforts).toEqual(ALL_REASONING_EFFORTS)
  })

  it('opens both modalities when the upstream has no tags either', () => {
    const models = parseRaccoonCatalog({
      data: {
        categories: [{
          type: 'chat',
          models: [{ name: 'sn-mystery', description: 'Mystery-1', visible: true, params: { context_window: 1_000 } }],
        }],
      },
    })
    expect(models[0]).toMatchObject({
      name: 'Mystery 1',
      vision: true,
      reasoning: true,
      reasoningEfforts: ALL_REASONING_EFFORTS,
    })
  })

  it('adopts effort levels and modalities from the live OpenRouter metadata', () => {
    const openRouter = buildOpenRouterIndex([
      {
        id: 'moonshotai/kimi-k3', name: 'MoonshotAI: Kimi K3',
        inputModalities: ['text', 'image', 'video'],
        efforts: ['max', 'high', 'low', 'none'], mandatory: false,
      },
      {
        id: 'z-ai/glm-5.3', name: 'Z.ai: GLM 5.3',
        inputModalities: ['text'],
        efforts: ['max', 'high', 'low'], mandatory: true,
      },
      {
        id: 'z-ai/glm-5.3-flash', name: 'Z.ai: GLM 5.3 Flash',
        inputModalities: ['text', 'image', 'video'],
        efforts: ['max', 'high', 'low'], mandatory: true,
      },
      {
        id: 'deepseek/deepseek-v4.1-flash-1017', name: 'DeepSeek: DeepSeek V4.1 Flash 1017',
        inputModalities: ['text', 'image'],
        efforts: ['max', 'high', 'low', 'none'], mandatory: false,
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
    const byId = Object.fromEntries(models.map(model => [model.id, model]))
    expect(byId['sn-deepseek-v4-1-flash-1017']!.vision).toBe(true)
    expect(byId['sn-glm-5-3']!.vision).toBe(false)
    expect(byId['sn-glm-5-3-flash']!.vision).toBe(true)
    expect(byId['sn-kimi-k3']!.vision).toBe(true)
    expect(byId['sn-deepseek-v4-1-flash-1017']!.reasoningEfforts).toEqual(['max', 'high', 'low', 'none'])
    expect(byId['sn-glm-5-3']!.reasoningEfforts).toEqual(['max', 'high', 'low'])
    expect(byId['sn-kimi-k3']!.reasoningEfforts).toEqual(['max', 'high', 'low', 'none'])
    expect(byId['sn-deepseek-v4-1-flash-1017']!.defaultReasoningEffort).toBe('none')
    expect(byId['sn-glm-5-3']!.defaultReasoningEffort).toBe('low')
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
