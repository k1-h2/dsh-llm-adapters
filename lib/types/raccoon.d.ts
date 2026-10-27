/**
 * SenseTime Raccoon (小浣熊) gateway client.
 *
 * The gateway is OpenAI-compatible and authenticates with an OAuth access
 * token. Tokens rotate on refresh; {@link RaccoonAuth} writes the rotated pair
 * back to whichever store supplied them.
 *
 * @module dsh-llm-adapters/raccoon
 */
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { AccountStore } from './account-store.ts';
import { RaccoonAuth } from './auth.ts';
import type { LoginStatus } from './login-page.ts';
import { ModelCatalog } from './catalog.ts';
import type { ProviderModel } from './catalog.ts';
import type { OpenRouterLookup } from './openrouter.ts';
import type { CheckinStatus, QuotaSnapshot } from './types.ts';
import type { ReadImage } from './wire.ts';
export declare const RACCOON_BASE = "https://xiaohuanxiong.com/api/web";
export declare const RACCOON_CLIENT_VERSION = "v1.0.35";
/** The page whose first authenticated load carries the daily-points grant. */
export declare const RACCOON_CHECKIN_URL = "https://xiaohuanxiong.com/work/home";
export interface RaccoonProviderOptions {
    auth: RaccoonAuth;
    store: AccountStore;
    ttlMs: () => number;
    timeoutMs: () => number;
    textOnly: () => ReadonlySet<string>;
    forceVision: () => ReadonlySet<string>;
    fetchImpl?: typeof fetch;
    /** Injectable OpenRouter lookup for tests; defaults to the live catalog. */
    openRouter?: OpenRouterLookup;
}
/** Whether the gateway accepts a token harvested from the browser. */
export declare function raccoonAccessTokenValid(token: string, fetchImpl?: typeof fetch): Promise<boolean>;
/**
 * Among the tokens a browser login leaves behind, the refresh token is the
 * other JWT with the furthest expiry; the access token itself is excluded.
 */
export declare function raccoonRefreshCandidate(tokens: readonly string[], accessToken: string): string | undefined;
export declare class RaccoonProvider {
    private readonly options;
    readonly catalog: ModelCatalog;
    private quotaCache;
    private quotaInflight;
    private checkinInflight;
    private loginFlow;
    private readonly openRouter;
    constructor(options: RaccoonProviderOptions);
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
    private headers;
    /** Run one JSON call; a rejected token means this login needs a new scan. */
    private authorizedJson;
    private fetchModels;
    models(fresh?: boolean): Promise<readonly ProviderModel[]>;
    catalogError(): string | undefined;
    invalidateModels(): void;
    quota(fresh?: boolean): Promise<QuotaSnapshot>;
    invalidateQuota(): void;
    /**
     * Today's daily-points bill, when the website has already granted it.
     *
     * Raccoon has no standalone check-in endpoint. The daily points are issued
     * by the server on the first authenticated web visit and announced through
     * `point_grant_popups` on `setting_info`; the bills list is the durable proof.
     */
    private dailyGrant;
    checkinStatus(): Promise<CheckinStatus>;
    claimCheckin(): Promise<CheckinStatus>;
    /**
     * One automatic check-in pass: report today's grant, or ask the website path
     * to issue it. Shared so overlapping timers cannot spend two call slots.
     */
    ensureDailyCheckin(): Promise<CheckinStatus>;
    stream(options: GenerateOptions, model: string, readImage: ReadImage | undefined, onUnauthorized?: () => void): AsyncGenerator<StreamChunk>;
}
