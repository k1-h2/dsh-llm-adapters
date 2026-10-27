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
import { modelKey } from './model-name.ts'
import { CodeArtsProvider } from './codearts.ts'
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
  /**
   * Last verified image capability per model id.
   *
   * A missed catalog read used to fall back to text-only, and DSH then strips
   * the pixels before this adapter ever runs: a vision model silently lost the
   * image for that turn. Remembering the last answer keeps the declared
   * capability stable across a transient miss.
   */
  private readonly knownVision = new Map<string, boolean>()

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
    const models = await this.client.models()
    for (const model of models) this.knownVision.set(model.id, model.vision)
    return models
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

  /** Claim today's reward; providers without one reject it. */
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
    const folded = modelKey(id)
    return this.options.disabledModels().some(entry => entry === id || modelKey(entry) === folded)
  }

  contextWindowFor(id: string): number | undefined {
    const table = this.options.modelContextWindows()
    const direct = table[id] ?? table[id.trim().toLowerCase()]
    if (direct !== undefined) return direct
    // The settings page stores the id the catalogue published, while a hand-typed
    // selection or a renamed row comes back with different punctuation, and every
    // miss read as "no override" — the model then ran on the fallback window.
    const folded = modelKey(id)
    if (folded.length === 0) return undefined
    for (const key of Object.keys(table)) {
      if (modelKey(key) === folded) return table[key]
    }
    return undefined
  }

  /**
   * The catalogue row one harness-side id means.
   *
   * Exact id first. Then the folded comparison, because the picker may hand back
   * the display name (`DeepSeek-V4.1-Flash`) or a re-spelling the upstream changed
   * between rosters; a miss here silently dropped both the window and the
   * reasoning levels, so a model that costs 1M tokens ran as if it had 200K.
   */
  protected findModel(models: readonly ProviderModel[], id: string): ProviderModel | undefined {
    const exact = models.find(entry => entry.id === id)
    if (exact !== undefined) return exact
    const folded = modelKey(id)
    if (folded.length === 0) return undefined
    return models.find(entry => modelKey(entry.id) === folded || modelKey(entry.name) === folded)
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    if (!(await this.client.signedIn())) return []
    const disabled = new Set(this.options.disabledModels())
    const models = await this.client.models()
    for (const model of models) this.knownVision.set(model.id, model.vision)
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
    const live = this.findModel(await this.client.models(), target)
    if (live !== undefined) this.knownVision.set(target, live.vision)
    // A missed catalog read must not turn a vision model into a text-only one:
    // DSH strips the pixels before this adapter runs when the declared
    // capability says text only.
    const vision = live === undefined ? this.knownVision.get(target) === true : live.vision
    const contextWindow = this.contextWindowFor(target) ?? live?.contextWindow ?? 200_000
    const maxTokens = live?.maxTokens ?? this.options.defaultMaxTokens()
    return {
      provider,
      id: model,
      name: live?.name ?? target,
      ...live?.description === undefined ? {} : { description: live.description },
      inputModalities: vision ? ['text', 'image'] : ['text'],
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
    const live = this.findModel(await this.client.models(), model)
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

/** CodeArts route; signed requests instead of a bearer token. */
export class CodeArtsAdapter extends LocalAdapter {
  constructor(options: AdapterOptions, codearts: CodeArtsProvider) {
    super(options, codearts)
  }
}

/** Map a harness-side alias onto the upstream id. */
export function resolveModelId(model: string, aliases: Readonly<Record<string, string>>): string {
  const configured = aliases[model] ?? aliases[model.toLowerCase()]
  if (configured !== undefined && configured.length > 0) return configured
  return model
}
