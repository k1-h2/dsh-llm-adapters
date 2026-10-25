import { describe, expect, it, vi } from 'vitest'
import {
  ModelCatalog, parseLoomyCatalog, parseRaccoonCatalog, priceFactorOf,
} from '../src/catalog.ts'

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
              display_description: 'SenseNova-6.8-Flash-Lite',
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
              display_description: 'GLM-5-3',
              visible: true,
              tags: ['vision', 'reasoning'],
              params: { context_window: 1_000_000, max_tokens: 100_000 },
              billing_multiplier: 0.75,
            },
            {
              name: 'sn-glm-5-3-flash',
              display_description: 'GLM-5-3-Flash',
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
      contextWindow: 256_000,
      maxTokens: 63_999,
      priceFactor: 0,
      badge: '限免一个月',
    })
    expect(models[2]!.badge).toBe('折扣')
  })

  it('uses the measured vision table instead of unreliable tags', () => {
    const models = parseRaccoonCatalog(payload)
    const byId = Object.fromEntries(models.map(model => [model.id, model]))
    expect(byId['sn-glm-5-3']!.vision).toBe(false)
    expect(byId['sn-glm-5-3-flash']!.vision).toBe(true)
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
