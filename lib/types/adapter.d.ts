/**
 * Harness adapter for the browser-signed-in providers.
 *
 * One instance owns one provider route and its catalog, credential reader and
 * user choices. The concrete subclasses differ only in which client they hold.
 *
 * @module dsh-llm-adapters/adapter
 */
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, PreparedAdapterCall, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { BrandId, TraeRegion } from './brand.ts';
import type { LoginStatus } from './login-page.ts';
import type { ProviderModel } from './catalog.ts';
import { CodeArtsProvider } from './codearts.ts';
import { LoomyProvider } from './loomy.ts';
import { RaccoonProvider } from './raccoon.ts';
import { TraeProvider } from './trae.ts';
import type { AuthStatus } from './auth.ts';
import type { CheckinStatus, ClientLoginStatus, ProviderStatus, QuotaSnapshot } from './types.ts';
import type { ReadImage } from './wire.ts';
export interface AdapterOptions {
    brand: BrandId;
    provider: string;
    displayName: () => string;
    disabledModels: () => readonly string[];
    modelContextWindows: () => Readonly<Record<string, number>>;
    modelAliases: () => Readonly<Record<string, string>>;
    defaultMaxTokens: () => number;
    readImage: ReadImage | undefined;
}
/**
 * What an adapter needs from a provider client.
 *
 * Declared as an interface rather than a union so a new provider only has to
 * implement the behaviour, not edit the adapter's type list. The optional
 * client-login and check-in methods exist only on Trae.
 */
export interface ProviderClient {
    status(): Promise<AuthStatus>;
    signedIn(): Promise<boolean>;
    models(fresh?: boolean): Promise<readonly ProviderModel[]>;
    /** The cached catalog, when one has been read; never starts a request. */
    peekModels?(): readonly ProviderModel[] | undefined;
    quota(fresh?: boolean): Promise<QuotaSnapshot>;
    catalogError(): string | undefined;
    stream(options: GenerateOptions, model: string, readImage: ReadImage | undefined, onInvalidate: () => void): AsyncGenerator<StreamChunk>;
    startBrowserLogin(region?: TraeRegion): Promise<LoginStatus>;
    browserLoginStatus(): LoginStatus;
    cancelBrowserLogin(): Promise<void>;
    logoutAccount(): Promise<void>;
    invalidateModels(): void;
    invalidateQuota(): void;
    close(): void;
    /** Trae only: the local desktop client's current sign-in state. */
    localClientLogin?(): Promise<ClientLoginStatus>;
    /** Trae only: copy that state into the plugin's own account store. */
    importClientLogin?(): Promise<void>;
    checkinStatus?(): Promise<CheckinStatus>;
    claimCheckin?(): Promise<CheckinStatus>;
}
export declare abstract class LocalAdapter extends LlmAdapter {
    protected readonly options: AdapterOptions;
    protected readonly client: ProviderClient;
    /**
     * Last verified image capability per model id.
     *
     * A missed catalog read used to fall back to text-only, and DSH then strips
     * the pixels before this adapter ever runs: a vision model silently lost the
     * image for that turn. Remembering the last answer keeps the declared
     * capability stable across a transient miss.
     */
    private readonly knownVision;
    constructor(options: AdapterOptions, client: ProviderClient);
    protected get brand(): BrandId;
    providerInfo(provider: string): LlmProviderInfo;
    /** The live catalog including switched-off models; the settings page shows those. */
    describeCatalog(): Promise<readonly ProviderModel[]>;
    isSignedIn(): Promise<boolean>;
    catalogError(): Promise<string | undefined>;
    logoutAccount(): Promise<void>;
    /**
     * Start the sign-in flow and return its first status.
     *
     * Loomy and Raccoon serve a local QR page (`url`), Trae opens its own browser
     * window; `region` only matters to Trae and is ignored by the others.
     */
    startBrowserLogin(region?: TraeRegion): Promise<LoginStatus>;
    browserLoginStatus(): LoginStatus;
    cancelBrowserLogin(): Promise<void>;
    /** Claim today's reward; providers without one reject it. */
    claimCheckin(): Promise<CheckinStatus>;
    /** Import a local client login and return the refreshed account reading. */
    importClientLogin(): Promise<ProviderStatus>;
    invalidateCatalog(): void;
    invalidateUsage(): void;
    /** Login state plus quota, shaped for the settings page. */
    usageInfo(fresh?: boolean): Promise<ProviderStatus>;
    isModelDisabled(id: string): boolean;
    contextWindowFor(id: string): number | undefined;
    /**
     * The catalogue row one harness-side id means.
     *
     * Exact id first. Then the folded comparison, because the picker may hand back
     * the display name (`DeepSeek-V4.1-Flash`) or a re-spelling the upstream changed
     * between rosters; a miss here silently dropped both the window and the
     * reasoning levels, so a model that costs 1M tokens ran as if it had 200K.
     */
    protected findModel(models: readonly ProviderModel[], id: string): ProviderModel | undefined;
    /**
     * The catalog without waiting for a refresh.
     *
     * DSH resolves a model on every switch and again when the thinking level
     * changes; awaiting a catalog read there made the picker freeze for as long
     * as the upstream took whenever the TTL had just expired. A cached list is
     * returned immediately and refreshed in the background. Only a first run,
     * where there is nothing to show, waits.
     */
    private cachedModels;
    listModels(provider: string): Promise<readonly LlmModelInfo[]>;
    resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo>;
    prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall>;
    stream(options: GenerateOptions): AsyncGenerator<StreamChunk>;
    close(): void;
}
/** Loomy route. */
export declare class LoomyAdapter extends LocalAdapter {
    constructor(options: AdapterOptions, loomy: LoomyProvider);
}
/** SenseTime Raccoon route. */
export declare class RaccoonAdapter extends LocalAdapter {
    constructor(options: AdapterOptions, raccoon: RaccoonProvider);
}
/** Trae route; one route serves both regions, chosen by the saved region. */
export declare class TraeAdapter extends LocalAdapter {
    constructor(options: AdapterOptions, trae: TraeProvider);
}
/** CodeArts route; signed requests instead of a bearer token. */
export declare class CodeArtsAdapter extends LocalAdapter {
    constructor(options: AdapterOptions, codearts: CodeArtsProvider);
}
/** Map a harness-side alias onto the upstream id. */
export declare function resolveModelId(model: string, aliases: Readonly<Record<string, string>>): string;
