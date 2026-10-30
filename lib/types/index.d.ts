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
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Context } from '@deepseek-ai/cordis';
import type { ParsedConfig } from './config.ts';
interface WebServerService {
    register(route: {
        kind: 'exact' | 'prefix';
        path: string;
        handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
    }): () => void;
}
/**
 * The mounted filesystem provider, used only to translate a host path into the
 * execution world the host tools run in. Declared minimally so this plugin
 * keeps only the peer dependencies it actually needs.
 */
interface FileSystemService {
    processPathFromHostPath?(hostPath: string): string | undefined;
}
declare module '@deepseek-ai/cordis' {
    interface Context {
        webServer?: WebServerService;
        /** Present when a filesystem provider is mounted; reached by inject. */
        fs?: FileSystemService;
    }
    interface Events {
        'loader/volatile-update'(paths: readonly (readonly string[])[]): void;
    }
}
export { CodeArtsAdapter, LoomyAdapter, RaccoonAdapter, TraeAdapter, LocalAdapter, resolveModelId } from './adapter.ts';
export { CodeArtsAuth, LoomyAuth, RaccoonAuth, TraeAuth, decodeJwtFacts } from './auth.ts';
export type { AuthStatus, LocalAccount } from './auth.ts';
export { AccountStore } from './account-store.ts';
export type { CodeArtsAccountRecord, LoomyAccountRecord, RaccoonAccountRecord, StoredAccounts, TraeAccountRecord, } from './account-store.ts';
export { startLoginPage } from './login-page.ts';
export type { LoginBindingSpec, LoginPageHandle, LoginPageSpec, LoginPhase, LoginPoll, LoginStatus, } from './login-page.ts';
export { LoomyQrLogin, LOOMY_ACCOUNT_BASE, LOOMY_WECHAT_APP_ID, LOOMY_WECHAT_REDIRECT_URI, buildLoomyWechatAuthUrl, extractWechatUuid, fetchLoomyWechatUuid, } from './loomy-login.ts';
export type { LoomyLoginAccount, LoomyLoginOptions } from './loomy-login.ts';
export { RaccoonIamError, RaccoonQrLogin, RACCOON_IAM_BASE, RACCOON_QR_APP_NAME, RACCOON_QR_ORIGIN, createRaccoonQr, pollRaccoonQr, raccoonQrContent, } from './raccoon-login.ts';
export type { RaccoonLoginAccount, RaccoonLoginOptions, RaccoonQrPoll, RaccoonQrSession, } from './raccoon-login.ts';
export { buildQrMatrix, renderQrSvg } from './qr.ts';
export type { QrMatrix } from './qr.ts';
export { BRANDS, CODEARTS_BRAND, CODEARTS_PROVIDER, LOOMY_BRAND, LOOMY_PROVIDER, RACCOON_BRAND, RACCOON_PROVIDER, TRAE_BRAND, TRAE_PROVIDER, isBrandId, normalizeTraeRegion, } from './brand.ts';
export type { BrandId, BrandProfile, TraeRegion } from './brand.ts';
export { ModelCatalog, defaultEffortOf, effortLabel, parseLoomyCatalog, parseRaccoonCatalog, priceFactorOf, resolveCapabilities, } from './catalog.ts';
export type { ProviderModel, ResolvedCapabilities } from './catalog.ts';
export { parseModelName, modelKey } from './model-name.ts';
export type { ParsedModelName } from './model-name.ts';
export { OpenRouterCatalog, buildOpenRouterIndex, parseOpenRouterModels, readOpenRouter, EMPTY_OPENROUTER_INDEX, } from './openrouter.ts';
export type { OpenRouterIndex, OpenRouterLookup, OpenRouterModel, OpenRouterStatus, OpenRouterSyncResult, } from './openrouter.ts';
export { LoomyProvider, LOOMY_BASE, LOOMY_VERSION, loomyGatewaySessionValid } from './loomy.ts';
export { RaccoonProvider, RACCOON_BASE, RACCOON_CLIENT_VERSION, raccoonAccessTokenValid, raccoonRefreshCandidate, } from './raccoon.ts';
export { TraeProvider, TRAE_CHAT_FUNCTIONS, TRAE_DIRECTORY_FUNCTIONS, mergeTraeModels, normalizeEffort, openTraeStream, parseTraeGlobalUsage, parseTraeRemoteModels, parseTraeUsage, parseTraeWireModels, traeMessages, traeTools, } from './trae.ts';
export type { TraeCatalog, TraeModelMeta, TraeProviderOptions, TraeRemoteModel, TraeWireModel, } from './trae.ts';
export { TRAE_APP_ID, TRAE_REGION_PROFILES, TRAE_SOLO_CHAT_PATH, TRAE_WEB_USER_AGENT } from './trae-endpoints.ts';
export type { TraeRegionProfile } from './trae-endpoints.ts';
export { TraeWebLogin, machineIdOf } from './trae-login.ts';
export type { TraeLoginAccount, TraeWebLoginOptions } from './trae-login.ts';
export { CodeArtsProvider, CODEARTS_DEFAULT_EFFORT, CODEARTS_EFFORTS, clampMaxTokens, codeartsEfforts, normalizeCodeArtsModelId, parseCodeArtsPackage, parseCodeArtsRoster, pickActiveCredit, priceFactorOfLabel, } from './codearts.ts';
export type { CodeArtsActivity, CodeArtsModelRow, CodeArtsPackageInfo, CodeArtsProviderOptions, } from './codearts.ts';
export { CODEARTS_BENEFIT_FALLBACK, CODEARTS_CHAT_URL, CODEARTS_CONTEXT_WINDOWS, CODEARTS_EFFORT_LEVELS, CODEARTS_FALLBACK_CONTEXT_WINDOW, CODEARTS_MAX_OUTPUT_TOKENS, CODEARTS_SNAP_BASE, CODEARTS_VISION_MODELS, codeartsContextWindow, } from './codearts-endpoints.ts';
export { headersForFetch, signRequestHuawei } from './codearts-sign.ts';
export { RefreshTokenExpiredError, buildAuthorizeUrl, exchangeAuthorizationCode, exchangeRefreshToken, generateDpopKeyPair, generatePkcePair, readJwtExpiry, signDpopJws, } from './codearts-oauth.ts';
export type { CodeArtsCredential, DpopKeyPair, DpopPrivateJwk, PkcePair } from './codearts-oauth.ts';
export { CodeArtsLogin } from './codearts-login.ts';
export type { CodeArtsLoginAccount, CodeArtsLoginOptions } from './codearts-login.ts';
export { CODEARTS_SESSION_LIMIT, CODEARTS_SESSION_WINDOW_MS, CodeArtsSessionWindow, sharedSessionWindow, } from './codearts-window.ts';
export { ProviderHttpError, buildMessages, buildTools, consumeOpenAiStream, openAiStream, sseEvents } from './wire.ts';
export type { WireMessage } from './wire.ts';
export { API_PREFIX, buildRows } from './api.ts';
export { liveConfig, resolveConfig } from './config.ts';
export type { Config as ConfigShape, LiveConfig, ParsedConfig, ResolvedConfig } from './config.ts';
export type { CheckinStatus, ProviderStatus, QuotaPack, QuotaSnapshot } from './types.ts';
export declare const name = "llm-adapters";
export declare const inject: string[];
export declare const Config: import("@deepseek-ai/schemastery").default<Schemastery.ObjectS<NoInfer<{
    loomyEnabled: import("@deepseek-ai/schemastery").default<boolean, boolean, "volatile-defined">;
    raccoonEnabled: import("@deepseek-ai/schemastery").default<boolean, boolean, "volatile-defined">;
    traeEnabled: import("@deepseek-ai/schemastery").default<boolean, boolean, "volatile-defined">;
    traeRegion: import("@deepseek-ai/schemastery").default<string, string, "volatile-defined">;
    codeartsEnabled: import("@deepseek-ai/schemastery").default<boolean, boolean, "volatile-defined">;
    loomyDisplayName: import("@deepseek-ai/schemastery").default<string, string, "volatile-defined">;
    raccoonDisplayName: import("@deepseek-ai/schemastery").default<string, string, "volatile-defined">;
    traeDisplayName: import("@deepseek-ai/schemastery").default<string, string, "volatile-defined">;
    codeartsDisplayName: import("@deepseek-ai/schemastery").default<string, string, "volatile-defined">;
    loomyDisabledModels: import("@deepseek-ai/schemastery").default<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    raccoonDisabledModels: import("@deepseek-ai/schemastery").default<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    traeDisabledModels: import("@deepseek-ai/schemastery").default<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    codeartsDisabledModels: import("@deepseek-ai/schemastery").default<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    loomyModelContextWindows: import("@deepseek-ai/schemastery").default<NoInfer<import("@deepseek-ai/cosmokit").Dict<number, string>>, NoInfer<import("@deepseek-ai/cosmokit").Dict<number, string>>, "volatile-defined">;
    raccoonModelContextWindows: import("@deepseek-ai/schemastery").default<NoInfer<import("@deepseek-ai/cosmokit").Dict<number, string>>, NoInfer<import("@deepseek-ai/cosmokit").Dict<number, string>>, "volatile-defined">;
    traeModelContextWindows: import("@deepseek-ai/schemastery").default<NoInfer<import("@deepseek-ai/cosmokit").Dict<number, string>>, NoInfer<import("@deepseek-ai/cosmokit").Dict<number, string>>, "volatile-defined">;
    codeartsModelContextWindows: import("@deepseek-ai/schemastery").default<NoInfer<import("@deepseek-ai/cosmokit").Dict<number, string>>, NoInfer<import("@deepseek-ai/cosmokit").Dict<number, string>>, "volatile-defined">;
    loomyModelAliases: import("@deepseek-ai/schemastery").default<NoInfer<import("@deepseek-ai/cosmokit").Dict<string, string>>, NoInfer<import("@deepseek-ai/cosmokit").Dict<string, string>>, "volatile-defined">;
    raccoonModelAliases: import("@deepseek-ai/schemastery").default<NoInfer<import("@deepseek-ai/cosmokit").Dict<string, string>>, NoInfer<import("@deepseek-ai/cosmokit").Dict<string, string>>, "volatile-defined">;
    traeModelAliases: import("@deepseek-ai/schemastery").default<NoInfer<import("@deepseek-ai/cosmokit").Dict<string, string>>, NoInfer<import("@deepseek-ai/cosmokit").Dict<string, string>>, "volatile-defined">;
    codeartsModelAliases: import("@deepseek-ai/schemastery").default<NoInfer<import("@deepseek-ai/cosmokit").Dict<string, string>>, NoInfer<import("@deepseek-ai/cosmokit").Dict<string, string>>, "volatile-defined">;
    loomyVisionModelIds: import("@deepseek-ai/schemastery").default<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    loomyTextOnlyModelIds: import("@deepseek-ai/schemastery").default<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    raccoonVisionModelIds: import("@deepseek-ai/schemastery").default<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    raccoonTextOnlyModelIds: import("@deepseek-ai/schemastery").default<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    traeVisionModelIds: import("@deepseek-ai/schemastery").default<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    traeTextOnlyModelIds: import("@deepseek-ai/schemastery").default<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    codeartsVisionModelIds: import("@deepseek-ai/schemastery").default<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    codeartsTextOnlyModelIds: import("@deepseek-ai/schemastery").default<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    defaultMaxTokens: import("@deepseek-ai/schemastery").default<number, number, "volatile-defined">;
    modelCacheTtlSeconds: import("@deepseek-ai/schemastery").default<number, number, "volatile-defined">;
    catalogFetchTimeoutSeconds: import("@deepseek-ai/schemastery").default<number, number, "volatile-defined">;
    openRouterSyncMinutes: import("@deepseek-ai/schemastery").default<number, number, "volatile-defined">;
    raccoonCheckinMinutes: import("@deepseek-ai/schemastery").default<number, number, "volatile-defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    loomyEnabled: import("@deepseek-ai/schemastery").default<boolean, boolean, "volatile-defined">;
    raccoonEnabled: import("@deepseek-ai/schemastery").default<boolean, boolean, "volatile-defined">;
    traeEnabled: import("@deepseek-ai/schemastery").default<boolean, boolean, "volatile-defined">;
    traeRegion: import("@deepseek-ai/schemastery").default<string, string, "volatile-defined">;
    codeartsEnabled: import("@deepseek-ai/schemastery").default<boolean, boolean, "volatile-defined">;
    loomyDisplayName: import("@deepseek-ai/schemastery").default<string, string, "volatile-defined">;
    raccoonDisplayName: import("@deepseek-ai/schemastery").default<string, string, "volatile-defined">;
    traeDisplayName: import("@deepseek-ai/schemastery").default<string, string, "volatile-defined">;
    codeartsDisplayName: import("@deepseek-ai/schemastery").default<string, string, "volatile-defined">;
    loomyDisabledModels: import("@deepseek-ai/schemastery").default<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    raccoonDisabledModels: import("@deepseek-ai/schemastery").default<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    traeDisabledModels: import("@deepseek-ai/schemastery").default<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    codeartsDisabledModels: import("@deepseek-ai/schemastery").default<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    loomyModelContextWindows: import("@deepseek-ai/schemastery").default<NoInfer<import("@deepseek-ai/cosmokit").Dict<number, string>>, NoInfer<import("@deepseek-ai/cosmokit").Dict<number, string>>, "volatile-defined">;
    raccoonModelContextWindows: import("@deepseek-ai/schemastery").default<NoInfer<import("@deepseek-ai/cosmokit").Dict<number, string>>, NoInfer<import("@deepseek-ai/cosmokit").Dict<number, string>>, "volatile-defined">;
    traeModelContextWindows: import("@deepseek-ai/schemastery").default<NoInfer<import("@deepseek-ai/cosmokit").Dict<number, string>>, NoInfer<import("@deepseek-ai/cosmokit").Dict<number, string>>, "volatile-defined">;
    codeartsModelContextWindows: import("@deepseek-ai/schemastery").default<NoInfer<import("@deepseek-ai/cosmokit").Dict<number, string>>, NoInfer<import("@deepseek-ai/cosmokit").Dict<number, string>>, "volatile-defined">;
    loomyModelAliases: import("@deepseek-ai/schemastery").default<NoInfer<import("@deepseek-ai/cosmokit").Dict<string, string>>, NoInfer<import("@deepseek-ai/cosmokit").Dict<string, string>>, "volatile-defined">;
    raccoonModelAliases: import("@deepseek-ai/schemastery").default<NoInfer<import("@deepseek-ai/cosmokit").Dict<string, string>>, NoInfer<import("@deepseek-ai/cosmokit").Dict<string, string>>, "volatile-defined">;
    traeModelAliases: import("@deepseek-ai/schemastery").default<NoInfer<import("@deepseek-ai/cosmokit").Dict<string, string>>, NoInfer<import("@deepseek-ai/cosmokit").Dict<string, string>>, "volatile-defined">;
    codeartsModelAliases: import("@deepseek-ai/schemastery").default<NoInfer<import("@deepseek-ai/cosmokit").Dict<string, string>>, NoInfer<import("@deepseek-ai/cosmokit").Dict<string, string>>, "volatile-defined">;
    loomyVisionModelIds: import("@deepseek-ai/schemastery").default<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    loomyTextOnlyModelIds: import("@deepseek-ai/schemastery").default<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    raccoonVisionModelIds: import("@deepseek-ai/schemastery").default<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    raccoonTextOnlyModelIds: import("@deepseek-ai/schemastery").default<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    traeVisionModelIds: import("@deepseek-ai/schemastery").default<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    traeTextOnlyModelIds: import("@deepseek-ai/schemastery").default<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    codeartsVisionModelIds: import("@deepseek-ai/schemastery").default<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    codeartsTextOnlyModelIds: import("@deepseek-ai/schemastery").default<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    defaultMaxTokens: import("@deepseek-ai/schemastery").default<number, number, "volatile-defined">;
    modelCacheTtlSeconds: import("@deepseek-ai/schemastery").default<number, number, "volatile-defined">;
    catalogFetchTimeoutSeconds: import("@deepseek-ai/schemastery").default<number, number, "volatile-defined">;
    openRouterSyncMinutes: import("@deepseek-ai/schemastery").default<number, number, "volatile-defined">;
    raccoonCheckinMinutes: import("@deepseek-ai/schemastery").default<number, number, "volatile-defined">;
}>>, "plain">;
export declare function apply(ctx: Context, config: ParsedConfig): void;
