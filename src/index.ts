/**
 * dsh-llm-adapters host half.
 *
 * Registers two provider routes on `ctx.llm` and mounts the settings API.
 * Credentials come only from the settings page's QR login, stored in the
 * plugin's own account store.
 *
 * @module dsh-llm-adapters
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { LoomyAdapter, RaccoonAdapter, resolveModelId } from './adapter.ts'
import type { AdapterOptions, LocalAdapter } from './adapter.ts'
import { AccountStore } from './account-store.ts'
import { API_PREFIX, handleApi } from './api.ts'
import { LoomyAuth, RaccoonAuth } from './auth.ts'
import { BRANDS, LOOMY_PROVIDER, RACCOON_PROVIDER } from './brand.ts'
import type { BrandId } from './brand.ts'
import { Config as ConfigSchema, liveConfig } from './config.ts'
import type { ParsedConfig } from './config.ts'
import { LoomyProvider } from './loomy.ts'
import { RaccoonProvider } from './raccoon.ts'

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

export { LoomyAdapter, RaccoonAdapter, LocalAdapter, resolveModelId } from './adapter.ts'
export { LoomyAuth, RaccoonAuth, decodeJwtFacts } from './auth.ts'
export type { AuthStatus, LocalAccount } from './auth.ts'
export { AccountStore } from './account-store.ts'
export type { LoomyAccountRecord, RaccoonAccountRecord, StoredAccounts } from './account-store.ts'
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
export { BRANDS, LOOMY_BRAND, RACCOON_BRAND, LOOMY_PROVIDER, RACCOON_PROVIDER, isBrandId } from './brand.ts'
export type { BrandId, BrandProfile } from './brand.ts'
export { ModelCatalog, parseLoomyCatalog, parseRaccoonCatalog, priceFactorOf, RACCOON_MEASURED_VISION } from './catalog.ts'
export type { ProviderModel } from './catalog.ts'
export { LoomyProvider, LOOMY_BASE, LOOMY_VERSION, loomyGatewaySessionValid } from './loomy.ts'
export {
  RaccoonProvider, RACCOON_BASE, RACCOON_CLIENT_VERSION, raccoonAccessTokenValid, raccoonRefreshCandidate,
} from './raccoon.ts'
export { ProviderHttpError, buildMessages, buildTools, openAiStream, sseEvents } from './wire.ts'
export type { WireMessage } from './wire.ts'
export { API_PREFIX, buildRows } from './api.ts'
export { liveConfig, resolveConfig } from './config.ts'
export type { Config as ConfigShape, LiveConfig, ParsedConfig, ResolvedConfig } from './config.ts'
export type { ProviderStatus, QuotaSnapshot } from './types.ts'

export const name = 'llm-adapters'
export const inject = ['llm']

const NS = 'llm-adapters'
const REQUEST_IMAGE_MAX_BYTES = 1_048_576

const STRUCTURAL_FIELDS: ReadonlySet<string> = new Set([
  'loomyEnabled', 'raccoonEnabled', 'loomyDisplayName', 'raccoonDisplayName',
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
  const loomyAuth = new LoomyAuth(accounts)
  const raccoonAuth = new RaccoonAuth(accounts)

  const loomyProvider = new LoomyProvider({
    auth: loomyAuth,
    store: accounts,
    ttlMs: live.modelCacheTtlMs,
    timeoutMs: live.catalogFetchTimeoutMs,
    textOnly: () => new Set(live.loomyTextOnlyModelIds()),
    forceVision: () => new Set(live.loomyVisionModelIds()),
  })
  const raccoonProvider = new RaccoonProvider({
    auth: raccoonAuth,
    store: accounts,
    ttlMs: live.modelCacheTtlMs,
    timeoutMs: live.catalogFetchTimeoutMs,
    textOnly: () => new Set(live.raccoonTextOnlyModelIds()),
    forceVision: () => new Set(live.raccoonVisionModelIds()),
  })

  const makeOptions = (brand: BrandId, provider: string): AdapterOptions => ({
    brand,
    provider,
    displayName: brand === 'loomy' ? live.loomyDisplayName : live.raccoonDisplayName,
    disabledModels: brand === 'loomy' ? live.loomyDisabledModels : live.raccoonDisabledModels,
    modelContextWindows: brand === 'loomy' ? live.loomyModelContextWindows : live.raccoonModelContextWindows,
    modelAliases: brand === 'loomy' ? live.loomyModelAliases : live.raccoonModelAliases,
    defaultMaxTokens: live.defaultMaxTokens,
    readImage,
  })

  const adapters: Record<BrandId, LocalAdapter> = {
    loomy: new LoomyAdapter(makeOptions('loomy', LOOMY_PROVIDER), loomyProvider),
    raccoon: new RaccoonAdapter(makeOptions('raccoon', RACCOON_PROVIDER), raccoonProvider),
  }

  ctx.inject(['attachments'], (scope) => {
    attachments = scope.attachments
    scope.effect(() => () => { attachments = undefined }, 'llm-adapters.attachments')
  })

  const routes: Partial<Record<BrandId, () => void>> = {}
  let directory: ReturnType<typeof ctx.llm.registerConfigurableProviders> | undefined

  const enabled = (id: BrandId): boolean => id === 'loomy' ? live.loomyEnabled() : live.raccoonEnabled()
  const directoryFor = () => BRANDS
    .filter(brand => enabled(brand.id))
    .map(brand => ({
      provider: brand.provider,
      displayName: brand.id === 'loomy' ? live.loomyDisplayName() : live.raccoonDisplayName(),
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
  }, 'llm-adapters.dispose')

  ctx.inject(['webServer'], (scope) => {
    const server = scope.webServer
    if (server === undefined) return
    scope.effect(
      () => server.register({
        kind: 'prefix',
        path: API_PREFIX,
        handler: (req: IncomingMessage, res: ServerResponse) => { void handleApi(req, res, adapters) },
      }),
      'llm-adapters: settings api',
    )
    ctx.logger?.info(`llm-adapters: 设置接口已挂载于 ${API_PREFIX}`)
  })
}
