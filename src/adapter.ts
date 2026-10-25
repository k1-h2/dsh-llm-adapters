/**
 * Harness adapter for the two OpenAI-compatible local providers.
 *
 * One instance owns one provider route and its catalog, credential reader and
 * user choices. The two concrete subclasses differ only in which client they
 * hold and which `/models`-style parser that client uses.
 *
 * @module dsh-llm-adapters/adapter
 */

import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo,
  PreparedAdapterCall, StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { BrandId } from './brand.ts'
import type { ProviderModel } from './catalog.ts'
import { LoomyProvider } from './loomy.ts'
import { RaccoonProvider } from './raccoon.ts'
import type { ProviderStatus } from './types.ts'
import type { ReadImage } from './wire.ts'

export interface AdapterOptions {
  brand: BrandId
  provider: string
  displayName: () => string
  disabledModels: () => readonly string[]
  modelContextWindows: () => Readonly<Record<string, number>>
  modelAliases: () => Readonly<Record<string, string>>
  defaultMaxTokens: () => number
  readImage: ReadImage | undefined
}

function modelInfo(provider: string, model: ProviderModel): LlmModelInfo {
  return {
    provider,
    id: model.id,
    name: model.name,
    ...model.description === undefined ? {} : { description: model.description },
    inputModalities: model.vision ? ['text', 'image'] : ['text'],
  }
}

export abstract class LocalAdapter extends LlmAdapter {
  constructor(
    protected readonly options: AdapterOptions,
    protected readonly client: LoomyProvider | RaccoonProvider,
  ) {
    super()
  }

  protected get brand(): BrandId {
    return this.options.brand
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: this.options.displayName() }
  }

  /** The live catalog including switched-off models; the settings page shows those. */
  async describeCatalog(): Promise<readonly ProviderModel[]> {
    if (!(await this.client.signedIn())) return []
    return this.client.models()
  }

  async isSignedIn(): Promise<boolean> {
    return this.client.signedIn()
  }

  async catalogError(): Promise<string | undefined> {
    if (!(await this.client.signedIn())) {
      const status = await this.client.status()
      return status.error ?? '尚未登录。请先打开对应桌面应用完成登录。'
    }
    return this.client.catalogError()
  }

  invalidateCatalog(): void {
    this.client.invalidateModels()
  }

  invalidateUsage(): void {
    this.client.invalidateQuota()
  }

  /** Login state plus quota, shaped for the settings page. */
  async usageInfo(fresh = false): Promise<ProviderStatus> {
    const auth = await this.client.status()
    const base: ProviderStatus = { brand: this.brand, ...auth }
    if (!auth.signedIn) return base
    try {
      return { ...base, quota: await this.client.quota(fresh) }
    } catch (error) {
      return { ...base, quotaError: error instanceof Error ? error.message : String(error) }
    }
  }

  isModelDisabled(id: string): boolean {
    return this.options.disabledModels().includes(id)
  }

  contextWindowFor(id: string): number | undefined {
    return this.options.modelContextWindows()[id]
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    if (!(await this.client.signedIn())) return []
    const disabled = new Set(this.options.disabledModels())
    const models = await this.client.models()
    return models.filter(model => !disabled.has(model.id)).map(model => modelInfo(provider, model))
  }

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const target = resolveModelId(model, this.options.modelAliases())
    const live = (await this.client.models()).find(entry => entry.id === target)
    const contextWindow = this.contextWindowFor(target) ?? live?.contextWindow ?? 200_000
    const maxTokens = live?.maxTokens ?? this.options.defaultMaxTokens()
    return {
      provider,
      id: model,
      name: live?.name ?? target,
      ...live?.description === undefined ? {} : { description: live.description },
      inputModalities: live?.vision === true ? ['text', 'image'] : ['text'],
      context: { contextWindow },
      defaultMaxTokens: Math.max(1, Math.floor(maxTokens)),
      ...live?.reasoningEfforts === undefined || live.reasoningEfforts.length === 0
        ? {}
        : {
            reasoning: {
              efforts: live.reasoningEfforts.map(effort => ({ id: effort as never, name: effort })),
            },
          },
    }
  }

  override async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    void signal
    const info = await this.resolveModel(provider, model)
    return { model: info, stream: options => this.stream(options) }
  }

  async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    if (!(await this.client.signedIn())) {
      const status = await this.client.status()
      throw new Error(status.error ?? '尚未登录。请先打开对应桌面应用完成登录。')
    }
    const model = resolveModelId(options.model, this.options.modelAliases())
    const live = (await this.client.models()).find(entry => entry.id === model)
    const maxTokens = options.maxTokens
      ?? live?.maxTokens
      ?? this.options.defaultMaxTokens()
    const request: GenerateOptions = {
      ...options,
      maxTokens: Math.max(1, Math.floor(maxTokens)),
    }
    yield* this.client.stream(request, model, this.options.readImage, () => {
      this.invalidateCatalog()
      this.invalidateUsage()
    })
  }

  close(): void {
    /* Both clients are stateless HTTP; nothing to release. */
  }
}

/** Loomy route. */
export class LoomyAdapter extends LocalAdapter {
  constructor(options: AdapterOptions, loomy: LoomyProvider) {
    super(options, loomy)
  }
}

/** SenseTime Raccoon route. */
export class RaccoonAdapter extends LocalAdapter {
  constructor(options: AdapterOptions, raccoon: RaccoonProvider) {
    super(options, raccoon)
  }
}

/** Map a harness-side alias onto the upstream id. */
export function resolveModelId(model: string, aliases: Readonly<Record<string, string>>): string {
  const configured = aliases[model] ?? aliases[model.toLowerCase()]
  if (configured !== undefined && configured.length > 0) return configured
  return model
}
