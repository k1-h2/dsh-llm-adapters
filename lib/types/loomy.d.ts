/**
 * Loomy (iFlytek) gateway client.
 *
 * The gateway is OpenAI-compatible but requires client tracing headers on every
 * call; without `traceparent` it accepts the connection and then never
 * answers. The session comes from the plugin's QR login and cannot be
 * refreshed, so an expired session is a user-visible login action.
 *
 * @module dsh-llm-adapters/loomy
 */
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { AccountStore } from './account-store.ts';
import { LoomyAuth } from './auth.ts';
import type { LoginStatus } from './login-page.ts';
import { ModelCatalog } from './catalog.ts';
import type { ProviderModel } from './catalog.ts';
import type { OpenRouterLookup } from './openrouter.ts';
import type { QuotaSnapshot } from './types.ts';
import type { ReadImage } from './wire.ts';
export declare const LOOMY_BASE = "https://loomyad.xunfei.cn/api/v1";
export declare const LOOMY_VERSION = "0.9.38";
/** Session lifetime the Loomy client itself requests (14 days). */
export declare const LOOMY_SESSION_TTL_MS: number;
export interface LoomyProviderOptions {
    auth: LoomyAuth;
    store: AccountStore;
    ttlMs: () => number;
    timeoutMs: () => number;
    textOnly: () => ReadonlySet<string>;
    forceVision: () => ReadonlySet<string>;
    fetchImpl?: typeof fetch;
    /** Injectable OpenRouter lookup for tests; defaults to the live catalog. */
    openRouter?: OpenRouterLookup;
}
/**
 * Whether the model gateway accepts a browser-obtained session.
 *
 * A web login can yield a session cookie that the web app itself uses; this
 * probe is what decides whether that same value also works as a gateway
 * credential. The gateway answers 200 with a JSON error code for a bad token,
 * so HTTP status alone is not enough.
 */
export declare function loomyGatewaySessionValid(session: string, fetchImpl?: typeof fetch): Promise<boolean>;
export declare class LoomyProvider {
    private readonly options;
    readonly catalog: ModelCatalog;
    private quotaCache;
    private quotaInflight;
    private loginFlow;
    private readonly openRouter;
    constructor(options: LoomyProviderOptions);
    status(): Promise<import("./auth.ts").AuthStatus>;
    signedIn(): Promise<boolean>;
    /** Start the local WeChat QR page; the settings page opens the returned URL. */
    startBrowserLogin(): Promise<LoginStatus>;
    browserLoginStatus(): LoginStatus;
    cancelBrowserLogin(): Promise<void>;
    /** Stop a login page that outlived the plugin. */
    close(): void;
    private login;
    logoutAccount(): Promise<void>;
    session(): Promise<string>;
    private fetchModels;
    models(fresh?: boolean): Promise<readonly ProviderModel[]>;
    /** The last successful catalogue, without waiting for a refresh. */
    peekModels(): readonly ProviderModel[] | undefined;
    catalogError(): string | undefined;
    invalidateModels(): void;
    quota(fresh?: boolean): Promise<QuotaSnapshot>;
    invalidateQuota(): void;
    stream(options: GenerateOptions, model: string, readImage: ReadImage | undefined, onUnauthorized?: () => void): AsyncGenerator<StreamChunk>;
}
