/**
 * Harness adapter for the browser-signed-in providers.
 *
 * One instance owns one provider route and its catalog, credential reader and
 * user choices. The concrete subclasses differ only in which client they hold.
 *
 * @module dsh-llm-adapters/adapter
 */

import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo,
  PreparedAdapterCall, StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { BrandId, TraeRegion } from './brand.ts'
import type { LoginStatus } from './login-page.ts'
import type { ProviderModel } from './catalog.ts'
import { effortLabel } from './catalog.ts'
import { LoomyProvider } from './loomy.ts'
import { RaccoonProvider } from './raccoon.ts'
import { TraeProvider } from './trae.ts'
import type { AuthStatus } from './auth.ts'
import type { CheckinStatus, ProviderStatus, QuotaSnapshot } from './types.ts'
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

/**
 * What an adapter needs from a provider client.
 *
 * Declared as an interface rather than a union so a new provider only has to
 * implement the behaviour, not edit the adapter's type list. The optional
 * check-in methods exist only on Trae.
 */
export interface ProviderClient {
  status(): Promise<AuthStatus>
  signedIn(): Promise<boolean>
  models(fresh?: boolean): Promise<readonly ProviderModel[]>
  quota(fresh?: boolean): Promise<QuotaSnapshot>
  catalogError(): string | undefined
  stream(
    options: GenerateOptions,
    model: string,
    readImage: ReadImage | undefined,
    onInvalidate: () => void,
  ): AsyncGenerator<StreamChunk>
  startBrowserLogin(region?: TraeRegion): Promise<LoginStatus>
  browserLoginStatus(): LoginStatus
  cancelBrowserLogin(): Promise<void>
  logoutAccount(): Promise<void>
  invalidateModels(): void
  invalidateQuota(): void
  close(): void
  checkinStatus?(): Promise<CheckinStatus>
  claimCheckin?(): Promise<CheckinStatus>
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
    protected readonly client: ProviderClient,
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
      return status.error ?? '尚未登录。请在设置页点「打开扫码登录」。'
    }
    return this.client.catalogError()
  }

  async logoutAccount(): Promise<void> {
    await this.client.logoutAccount()
  }

  /**
   * Start the sign-in flow and return its first status.
   *
   * Loomy and Raccoon serve a local QR page (`url`), Trae opens its own browser
   * window; `region` only matters to Trae and is ignored by the others.
   */
  startBrowserLogin(region?: TraeRegion): Promise<LoginStatus> {
    return this.client.startBrowserLogin(region)
  }

  browserLoginStatus(): LoginStatus {
    return this.client.browserLoginStatus()
  }

  cancelBrowserLogin(): Promise<void> {
    return this.client.cancelBrowserLogin()
  }

  /** Claim today's Trae reward; providers without one reject it. */
  async claimCheckin(): Promise<CheckinStatus> {
    if (this.client.claimCheckin === undefined) throw new Error('该供应商没有签到活动')
    const result = await this.client.claimCheckin()
    this.invalidateUsage()
    return result
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
    // Trae's check-in state is part of the account reading; the other two
    // providers do not implement it, so this costs them nothing.
    const checkin = this.client.checkinStatus === undefined
      ? undefined
      : await this.client.checkinStatus().catch(() => undefined)
    const withCheckin: ProviderStatus = checkin === undefined ? base : { ...base, checkin }
    if (!auth.signedIn) return withCheckin
    try {
      return { ...withCheckin, quota: await this.client.quota(fresh) }
    } catch (error) {
      return { ...withCheckin, quotaError: error instanceof Error ? error.message : String(error) }
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
    // DSH rejects a provider whose rows repeat an id, so a catalog bug must not
    // take the whole route down: the first row for an id wins.
    const seen = new Set<string>()
    const out: LlmModelInfo[] = []
    for (const model of models) {
      const key = model.id.toLowerCase()
      if (seen.has(key) || disabled.has(model.id)) continue
      seen.add(key)
      out.push(modelInfo(provider, model))
    }
    return out
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
              efforts: live.reasoningEfforts.map(effort => ({
                id: effort as never,
                // The id stays raw (`low`, `high`, `max`); only the label is
                // capitalized, and `xhigh` keeps its vendor spelling.
                name: effortLabel(effort),
              })),
              ...live.defaultReasoningEffort === undefined
                ? {}
                : { defaultEffort: live.defaultReasoningEffort as never },
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
      throw new Error(status.error ?? '尚未登录。请在设置页点「打开扫码登录」。')
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
    this.client.close()
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

/** Trae route; one route serves both regions, chosen by the saved region. */
export class TraeAdapter extends LocalAdapter {
  constructor(options: AdapterOptions, trae: TraeProvider) {
    super(options, trae)
  }
}

/** Map a harness-side alias onto the upstream id. */
export function resolveModelId(model: string, aliases: Readonly<Record<string, string>>): string {
  const configured = aliases[model] ?? aliases[model.toLowerCase()]
  if (configured !== undefined && configured.length > 0) return configured
  return model
}
