import { describe, expect, it, vi } from 'vitest'
import {
  OpenRouterCatalog, buildOpenRouterIndex, modelKey, parseOpenRouterModels, EMPTY_OPENROUTER_INDEX,
} from '../src/openrouter.ts'

describe('parseOpenRouterModels', () => {
  it('reads the reasoning and modality fields', () => {
    const models = parseOpenRouterModels({
      data: [
        {
          id: 'moonshotai/kimi-k3',
          name: 'MoonshotAI: Kimi K3',
          architecture: { input_modalities: ['text', 'image', 'video'] },
          reasoning: {
            mandatory: false,
            default_enabled: true,
            supported_efforts: ['max', 'high', 'low', 'none'],
            default_effort: 'max',
          },
        },
        {
          id: 'z-ai/glm-5.3',
          name: 'Z.ai: GLM 5.3',
          architecture: { input_modalities: ['text'] },
          reasoning: {
            mandatory: true,
            default_enabled: true,
            supported_efforts: ['max', 'high', 'low'],
            default_effort: 'max',
          },
        },
        { id: 'deepseek/deepseek-v4.1-flash', name: 'DeepSeek: DeepSeek V4.1 Flash', reasoning: { mandatory: false } },
      ],
    })
    expect(models[0]).toMatchObject({
      id: 'moonshotai/kimi-k3',
      inputModalities: ['text', 'image', 'video'],
      efforts: ['max', 'high', 'low', 'none'],
      defaultEffort: 'max',
      mandatory: false,
    })
    expect(models[1]!.mandatory).toBe(true)
    // A mandatory model still exposes `max` as a level; `none` is simply absent.
    expect(models[1]!.efforts).toEqual(['max', 'high', 'low'])
    expect(models[2]!.efforts).toBeUndefined()
    expect(models[2]!.mandatory).toBe(false)
  })

  it('ignores malformed entries', () => {
    expect(parseOpenRouterModels({ data: [{ name: 'no id' }] })).toEqual([])
    expect(parseOpenRouterModels({ data: 'nope' })).toEqual([])
    expect(parseOpenRouterModels(null)).toEqual([])
  })
})

describe('modelKey', () => {
  it('strips separators, vendor prefixes and case', () => {
    expect(modelKey('sn-GLM-5.3-Flash')).toBe('glm53flash')
    expect(modelKey('DeepSeek V4.1 Flash 1017')).toBe('deepseekv41flash1017')
    expect(modelKey('Kimi-K3')).toBe('kimik3')
  })
})

describe('buildOpenRouterIndex', () => {
  const kimi = {
    id: 'moonshotai/kimi-k3', name: 'MoonshotAI: Kimi K3',
    inputModalities: ['text', 'image'], efforts: ['max', 'low', 'none'], mandatory: false,
  }
  const kimiBatch = {
    id: 'moonshotai/kimi-k3:batch', name: 'MoonshotAI: Kimi K3 (batch)',
    inputModalities: ['text'], efforts: ['max'], mandatory: false,
  }
  const kimiLatest = {
    id: '~moonshotai/kimi-latest', name: 'MoonshotAI: Kimi Latest',
    inputModalities: ['text', 'video'], efforts: ['max'], mandatory: false,
  }
  const glm = {
    id: 'z-ai/glm-5.3', name: 'Z.ai: GLM 5.3',
    inputModalities: ['text'], efforts: ['max', 'low'], mandatory: true,
  }

  it('matches an upstream id with or without the sn- prefix', () => {
    const index = buildOpenRouterIndex([kimi, glm])
    expect(index.match('sn-kimi-k3')?.id).toBe('moonshotai/kimi-k3')
    expect(index.match('kimi-k3')?.id).toBe('moonshotai/kimi-k3')
  })

  it('falls back to the model name tail when the id does not match', () => {
    const index = buildOpenRouterIndex([kimi, glm])
    expect(index.match('custom-front', 'Kimi K3')?.id).toBe('moonshotai/kimi-k3')
    expect(index.match('unknown-id', 'Z.ai: GLM 5.3')?.id).toBe('z-ai/glm-5.3')
    expect(index.match('unknown-id')).toBeUndefined()
  })

  it('prefers a canonical entry over batch and latest aliases', () => {
    const index = buildOpenRouterIndex([kimiBatch, kimi, kimiLatest])
    expect(index.match('sn-kimi-k3')?.id).toBe('moonshotai/kimi-k3')
  })

  it('returns nothing for an empty index', () => {
    expect(EMPTY_OPENROUTER_INDEX.match('sn-kimi-k3')).toBeUndefined()
  })
})

describe('OpenRouterCatalog', () => {
  const url = 'https://openrouter.ai/api/v1/models'

  function json(value: unknown): Response {
    return new Response(JSON.stringify(value), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  it('caches the fetched index and bypasses it on fresh', async () => {
    const fetchImpl = vi.fn(async () => json({ data: [{ id: 'z-ai/glm-5.3', name: 'Z.ai: GLM 5.3', architecture: { input_modalities: ['text'] } }] }))
    const catalog = new OpenRouterCatalog(fetchImpl as unknown as typeof fetch, 60_000)
    await catalog.models()
    await catalog.models()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    await catalog.models(true)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('keeps the last snapshot when the refresh fails', async () => {
    const responses = [
      json({ data: [{ id: 'z-ai/glm-5.3', name: 'Z.ai: GLM 5.3', architecture: { input_modalities: ['text', 'image'] } }] }),
      new Response('upstream down', { status: 500 }),
    ]
    let index = 0
    const fetchImpl = vi.fn(async () => responses[index++]!)
    const catalog = new OpenRouterCatalog(fetchImpl as unknown as typeof fetch, () => 0)
    const first = await catalog.models()
    const second = await catalog.models(true)
    expect(second).toBe(first)
  })

  it('starts empty when the first fetch fails', async () => {
    const fetchImpl = vi.fn(async () => new Response('bad', { status: 500 }))
    const catalog = new OpenRouterCatalog(fetchImpl as unknown as typeof fetch, () => 0)
    expect(await catalog.models()).toBe(EMPTY_OPENROUTER_INDEX)
    expect(await catalog.models(true)).toBe(EMPTY_OPENROUTER_INDEX)
  })

  it('invalidate forces the next read to refetch', async () => {
    const fetchImpl = vi.fn(async () => json({ data: [] }))
    const catalog = new OpenRouterCatalog(fetchImpl as unknown as typeof fetch, () => 60_000)
    await catalog.models()
    catalog.invalidate()
    await catalog.models()
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
})
