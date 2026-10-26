/**
 * dsh-llm-adapters host half.
 *
 * Registers one provider route per brand on `ctx.llm` and mounts the settings
 * API. Credentials come only from the settings page's browser login, stored in
 * the plugin's own account store. Trae is a single route with two regions; the
 * region is a setting, so switching it reuses the same card and route.
 *
 * @module dsh-llm-adapters
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { CodeArtsAdapter, LoomyAdapter, RaccoonAdapter, TraeAdapter, resolveModelId } from './adapter.ts'
import type { AdapterOptions, LocalAdapter } from './adapter.ts'
import { AccountStore } from './account-store.ts'
import { API_PREFIX, handleApi } from './api.ts'
import { CodeArtsAuth, LoomyAuth, RaccoonAuth, TraeAuth } from './auth.ts'
import { BRANDS, CODEARTS_PROVIDER, LOOMY_PROVIDER, RACCOON_PROVIDER, TRAE_PROVIDER } from './brand.ts'
import type { BrandId } from './brand.ts'
import { Config as ConfigSchema, liveConfig } from './config.ts'
import type { ParsedConfig } from './config.ts'
import { CodeArtsProvider } from './codearts.ts'
import { LoomyProvider } from './loomy.ts'
import { OpenRouterCatalog } from './openrouter.ts'
import { RaccoonProvider } from './raccoon.ts'
import { TraeProvider } from './trae.ts'

interface WebServerService {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    webServer?: WebServerService
  }
  interface Events {
    'loader/volatile-update'(paths: readonly (readonly string[])[]): void
  }
}

export { CodeArtsAdapter, LoomyAdapter, RaccoonAdapter, TraeAdapter, LocalAdapter, resolveModelId } from './adapter.ts'
export { CodeArtsAuth, LoomyAuth, RaccoonAuth, TraeAuth, decodeJwtFacts } from './auth.ts'
export type { AuthStatus, LocalAccount } from './auth.ts'
export { AccountStore } from './account-store.ts'
export type {
  CodeArtsAccountRecord, LoomyAccountRecord, RaccoonAccountRecord, StoredAccounts, TraeAccountRecord,
} from './account-store.ts'
export { startLoginPage } from './login-page.ts'
export type {
  LoginBindingSpec, LoginPageHandle, LoginPageSpec, LoginPhase, LoginPoll, LoginStatus,
} from './login-page.ts'
export {
  LoomyQrLogin, LOOMY_ACCOUNT_BASE, LOOMY_WECHAT_APP_ID, LOOMY_WECHAT_REDIRECT_URI,
  buildLoomyWechatAuthUrl, extractWechatUuid, fetchLoomyWechatUuid,
} from './loomy-login.ts'
export type { LoomyLoginAccount, LoomyLoginOptions } from './loomy-login.ts'
export {
  RaccoonIamError, RaccoonQrLogin, RACCOON_IAM_BASE, RACCOON_QR_APP_NAME, RACCOON_QR_ORIGIN,
  createRaccoonQr, pollRaccoonQr, raccoonQrContent,
} from './raccoon-login.ts'
export type {
  RaccoonLoginAccount, RaccoonLoginOptions, RaccoonQrPoll, RaccoonQrSession,
} from './raccoon-login.ts'
export { buildQrMatrix, renderQrSvg } from './qr.ts'
export type { QrMatrix } from './qr.ts'
export {
  BRANDS, CODEARTS_BRAND, CODEARTS_PROVIDER, LOOMY_BRAND, LOOMY_PROVIDER, RACCOON_BRAND, RACCOON_PROVIDER,
  TRAE_BRAND, TRAE_PROVIDER, isBrandId, normalizeTraeRegion,
} from './brand.ts'
export type { BrandId, BrandProfile, TraeRegion } from './brand.ts'
export {
  ModelCatalog, defaultEffortOf, effortLabel, parseLoomyCatalog, parseRaccoonCatalog,
  priceFactorOf, resolveCapabilities,
} from './catalog.ts'
export type { ProviderModel, ResolvedCapabilities } from './catalog.ts'
export { parseModelName, modelKey } from './model-name.ts'
export type { ParsedModelName } from './model-name.ts'
export {
  OpenRouterCatalog, buildOpenRouterIndex, parseOpenRouterModels, EMPTY_OPENROUTER_INDEX,
} from './openrouter.ts'
export type {
  OpenRouterIndex, OpenRouterLookup, OpenRouterModel, OpenRouterStatus, OpenRouterSyncResult,
} from './openrouter.ts'
export { LoomyProvider, LOOMY_BASE, LOOMY_VERSION, loomyGatewaySessionValid } from './loomy.ts'
export {
  RaccoonProvider, RACCOON_BASE, RACCOON_CLIENT_VERSION, raccoonAccessTokenValid, raccoonRefreshCandidate,
} from './raccoon.ts'
export {
  TraeProvider, TRAE_CHAT_FUNCTIONS, TRAE_DIRECTORY_FUNCTIONS, checkinDeviceId, mergeTraeModels,
  normalizeEffort, openTraeStream, parseTraeCheckin, parseTraePlan, parseTraeRemoteModels,
  parseTraeUsage, parseTraeWireModels, traeMessages, traeTools,
} from './trae.ts'
export type {
  TraeCatalog, TraeModelMeta, TraeProviderOptions, TraeRemoteModel, TraeWireModel,
} from './trae.ts'
export { TRAE_APP_ID, TRAE_REGION_PROFILES, TRAE_SOLO_CHAT_PATH, TRAE_WEB_USER_AGENT } from './trae-endpoints.ts'
export type { TraeRegionProfile } from './trae-endpoints.ts'
export { TraeWebLogin, machineIdOf } from './trae-login.ts'
export type { TraeLoginAccount, TraeWebLoginOptions } from './trae-login.ts'
export {
  CodeArtsProvider, CODEARTS_DEFAULT_EFFORT, CODEARTS_EFFORTS, clampMaxTokens, normalizeCodeArtsModelId,
  parseCodeArtsPackage, parseCodeArtsRoster, pickActiveCredit, priceFactorOfLabel,
} from './codearts.ts'
export type {
  CodeArtsActivity, CodeArtsModelRow, CodeArtsPackageInfo, CodeArtsProviderOptions,
} from './codearts.ts'
export {
  CODEARTS_BENEFIT_FALLBACK, CODEARTS_CHAT_URL, CODEARTS_CONTEXT_WINDOWS, CODEARTS_FALLBACK_CONTEXT_WINDOW,
  CODEARTS_MAX_OUTPUT_TOKENS, CODEARTS_SNAP_BASE, CODEARTS_VISION_MODELS, codeartsContextWindow,
} from './codearts-endpoints.ts'
export { headersForFetch, signRequestHuawei } from './codearts-sign.ts'
export {
  RefreshTokenExpiredError, buildAuthorizeUrl, exchangeAuthorizationCode, exchangeRefreshToken,
  generateDpopKeyPair, generatePkcePair, readJwtExpiry, signDpopJws,
} from './codearts-oauth.ts'
export type { CodeArtsCredential, DpopKeyPair, DpopPrivateJwk, PkcePair } from './codearts-oauth.ts'
export { CodeArtsLogin } from './codearts-login.ts'
export type { CodeArtsLoginAccount, CodeArtsLoginOptions } from './codearts-login.ts'
export { ProviderHttpError, buildMessages, buildTools, consumeOpenAiStream, openAiStream, sseEvents } from './wire.ts'
export type { WireMessage } from './wire.ts'
export { API_PREFIX, buildRows } from './api.ts'
export { liveConfig, resolveConfig } from './config.ts'
export type { Config as ConfigShape, LiveConfig, ParsedConfig, ResolvedConfig } from './config.ts'
export type { CheckinStatus, ProviderStatus, QuotaPack, QuotaSnapshot } from './types.ts'

export const name = 'llm-adapters'
export const inject = ['llm']

const NS = 'llm-adapters'
const REQUEST_IMAGE_MAX_BYTES = 1_048_576

const STRUCTURAL_FIELDS: ReadonlySet<string> = new Set([
  'loomyEnabled', 'raccoonEnabled', 'traeEnabled', 'codeartsEnabled',
  'loomyDisplayName', 'raccoonDisplayName', 'traeDisplayName', 'codeartsDisplayName',
])

export const Config = ConfigSchema

export function apply(ctx: Context, config: ParsedConfig): void {
  const live = liveConfig(config)
  let attachments: AttachmentStore | undefined

  const readImage = async (ref: ImageAttachmentRef, signal?: AbortSignal) => {
    const store = attachments
    if (store === undefined) return undefined
    const image = await store.readImageRequest(ref, { width: ref.width, height: ref.height, maxBytes: REQUEST_IMAGE_MAX_BYTES }, signal)
    return { data: image.data, mediaType: image.mediaType }
  }

  const accounts = new AccountStore()
  // One snapshot serves every provider: the level/modality menu must agree
  // across Loomy, Raccoon and Trae, and a single schedule keeps it fresh.
  // The file lives beside accounts.json so an offline start still has it.
  const openRouter = new OpenRouterCatalog(fetch, {
    cacheFile: join(accounts.directory(), 'openrouter-models.json'),
  })
  const loomyAuth = new LoomyAuth(accounts)
  const raccoonAuth = new RaccoonAuth(accounts)
  const traeAuth = new TraeAuth(accounts, () => live.traeRegion())
  const codeartsAuth = new CodeArtsAuth(accounts)

  const loomyProvider = new LoomyProvider({
    auth: loomyAuth,
    store: accounts,
    ttlMs: live.modelCacheTtlMs,
    timeoutMs: live.catalogFetchTimeoutMs,
    textOnly: () => new Set(live.loomyTextOnlyModelIds()),
    forceVision: () => new Set(live.loomyVisionModelIds()),
    openRouter,
  })
  const raccoonProvider = new RaccoonProvider({
    auth: raccoonAuth,
    store: accounts,
    ttlMs: live.modelCacheTtlMs,
    timeoutMs: live.catalogFetchTimeoutMs,
    textOnly: () => new Set(live.raccoonTextOnlyModelIds()),
    forceVision: () => new Set(live.raccoonVisionModelIds()),
    openRouter,
  })
  const traeProvider = new TraeProvider({
    auth: traeAuth,
    store: accounts,
    region: () => live.traeRegion(),
    ttlMs: live.modelCacheTtlMs,
    timeoutMs: live.catalogFetchTimeoutMs,
    textOnly: () => new Set(live.traeTextOnlyModelIds()),
    forceVision: () => new Set(live.traeVisionModelIds()),
    openRouter,
    logger: message => ctx.logger?.warn(message),
  })
  const codeartsProvider = new CodeArtsProvider({
    auth: codeartsAuth,
    store: accounts,
    ttlMs: live.modelCacheTtlMs,
    timeoutMs: live.catalogFetchTimeoutMs,
    textOnly: () => new Set(live.codeartsTextOnlyModelIds()),
    forceVision: () => new Set(live.codeartsVisionModelIds()),
    logger: message => ctx.logger?.warn(message),
  })

  // The four per-brand choices are the same shape for every provider, so they
  // are kept in one table: adding a provider means adding a row, not a branch
  // in four different ternaries.
  const brandChoices: Record<BrandId, Pick<
    AdapterOptions, 'displayName' | 'disabledModels' | 'modelContextWindows' | 'modelAliases'
  >> = {
    loomy: {
      displayName: live.loomyDisplayName,
      disabledModels: live.loomyDisabledModels,
      modelContextWindows: live.loomyModelContextWindows,
      modelAliases: live.loomyModelAliases,
    },
    raccoon: {
      displayName: live.raccoonDisplayName,
      disabledModels: live.raccoonDisabledModels,
      modelContextWindows: live.raccoonModelContextWindows,
      modelAliases: live.raccoonModelAliases,
    },
    trae: {
      displayName: live.traeDisplayName,
      disabledModels: live.traeDisabledModels,
      modelContextWindows: live.traeModelContextWindows,
      modelAliases: live.traeModelAliases,
    },
    codearts: {
      displayName: live.codeartsDisplayName,
      disabledModels: live.codeartsDisabledModels,
      modelContextWindows: live.codeartsModelContextWindows,
      modelAliases: live.codeartsModelAliases,
    },
  }

  const makeOptions = (brand: BrandId, provider: string): AdapterOptions => ({
    brand,
    provider,
    ...brandChoices[brand],
    defaultMaxTokens: live.defaultMaxTokens,
    readImage,
  })

  const adapters: Record<BrandId, LocalAdapter> = {
    loomy: new LoomyAdapter(makeOptions('loomy', LOOMY_PROVIDER), loomyProvider),
    raccoon: new RaccoonAdapter(makeOptions('raccoon', RACCOON_PROVIDER), raccoonProvider),
    trae: new TraeAdapter(makeOptions('trae', TRAE_PROVIDER), traeProvider),
    codearts: new CodeArtsAdapter(makeOptions('codearts', CODEARTS_PROVIDER), codeartsProvider),
  }

  // Sync ticks cheaply: the configured interval is read live, so changing it in
  // the settings page takes effect without a restart. A sync in flight is
  // shared, and a failed one leaves the persisted snapshot untouched.
  const syncOpenRouter = (): void => {
    const minutes = live.openRouterSyncMinutes()
    if (minutes <= 0) return
    const status = openRouter.status()
    if (status.syncing) return
    if (status.at !== undefined && Date.now() - status.at < minutes * 60_000) return
    void openRouter.sync().then(result => {
      if (!result.ok) ctx.logger?.warn(`llm-adapters: OpenRouter 同步失败：${result.error ?? '未知错误'}`)
    })
  }
  const syncTimer = setInterval(syncOpenRouter, 30_000)
  syncTimer.unref?.()
  ctx.effect(() => () => clearInterval(syncTimer), 'llm-adapters: openrouter sync')

  ctx.inject(['attachments'], (scope) => {
    attachments = scope.attachments
    scope.effect(() => () => { attachments = undefined }, 'llm-adapters.attachments')
  })

  const routes: Partial<Record<BrandId, () => void>> = {}
  let directory: ReturnType<typeof ctx.llm.registerConfigurableProviders> | undefined

  const enabled = (id: BrandId): boolean => id === 'loomy'
    ? live.loomyEnabled()
    : id === 'raccoon' ? live.raccoonEnabled()
      : id === 'trae' ? live.traeEnabled() : live.codeartsEnabled()
  const directoryFor = () => BRANDS
    .filter(brand => enabled(brand.id))
    .map(brand => ({
      provider: brand.provider,
      displayName: brandChoices[brand.id].displayName(),
      settingsNs: NS,
      settingsPath: [],
    }))

  const syncRegistration = (): void => {
    for (const brand of BRANDS) {
      const current = routes[brand.id]
      if (enabled(brand.id) && current === undefined) {
        routes[brand.id] = ctx.llm.registerAdapter([brand.provider], adapters[brand.id])
      } else if (!enabled(brand.id) && current !== undefined) {
        current()
        delete routes[brand.id]
      }
    }
    const entries = directoryFor()
    if (entries.length === 0) {
      directory?.()
      directory = undefined
    } else if (directory === undefined) {
      directory = ctx.llm.registerConfigurableProviders(entries)
    } else {
      directory.replace(entries)
    }
  }

  syncRegistration()

  ctx.on('loader/volatile-update', (paths: readonly (readonly string[])[]) => {
    if (!paths.some(path => STRUCTURAL_FIELDS.has(String(path[0])))) return
    try {
      syncRegistration()
    } catch (error) {
      ctx.logger?.warn(`llm-adapters: 重新发布模型分组失败：${String(error)}`)
    }
  })

  ctx.effect(() => () => {
    adapters.loomy.close()
    adapters.raccoon.close()
    adapters.trae.close()
    adapters.codearts.close()
  }, 'llm-adapters.dispose')

  ctx.inject(['webServer'], (scope) => {
    const server = scope.webServer
    if (server === undefined) return
    scope.effect(
      () => server.register({
        kind: 'prefix',
        path: API_PREFIX,
        handler: (req: IncomingMessage, res: ServerResponse) => { void handleApi(req, res, adapters, openRouter) },
      }),
      'llm-adapters: settings api',
    )
    ctx.logger?.info(`llm-adapters: 设置接口已挂载于 ${API_PREFIX}`)
  })
}
