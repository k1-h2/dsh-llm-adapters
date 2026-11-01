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
import { ProviderHttpError } from './wire.ts';
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
    /** Injectable session-id bookkeeping for tests; defaults to the real one. */
    sessionIds?: RaccoonSessionIds;
}
/**
 * The upstream code for the account's token-throughput wall.
 *
 * It reads like a request-rate complaint (`您的模型请求频率超限`) and is not
 * one: measured on a live account, ten large requests in ten seconds hit it
 * while fifty small ones did not, and the window refills by throughput rather
 * than by request count. The gateway sends no `Retry-After` and no
 * `x-ratelimit-*` header, so nothing here can compute a wait either.
 */
export declare const RACCOON_RATE_LIMIT_CODE = "user_model_rate_limited";
/**
 * Whether a rejection is the token wall rather than a generic failure.
 *
 * Matched on the status, the code and the wording, because the same condition
 * arrives as an HTTP 429 and as an error frame inside a 200 stream.
 */
export declare function isRaccoonRateLimited(status: number | undefined, text: string): boolean;
/**
 * The wall, as an error the caller can tell apart from a generic 429.
 *
 * A subclass rather than a flag: the in-band path and the HTTP path would
 * otherwise both be caught by the same handler, and the second pass would wrap
 * the message the first pass had already rewritten.
 */
export declare class RaccoonRateLimitedError extends ProviderHttpError {
    constructor(message: string);
}
/**
 * One conversation's session id, stable across the turns of that conversation.
 *
 * The official client never opens a session per request — measured on its own
 * logs, 125 calls over 26 minutes all carried one `sess-0-53927d74` — while an
 * implementation that mints a fresh id per request tells the gateway that one
 * account opened hundreds of sessions within minutes.
 *
 * The id is a pure function of (account, model) rather than a random value, so a
 * restarted or hot-reloaded process continues the same conversation instead of
 * presenting a new session, and two models stay two conversations. The principal
 * itself never leaves the process — only a truncated digest of it does.
 */
export declare class RaccoonSessionIds {
    private readonly principal;
    /**
     * @param principal - a value that is stable for one account and identifies it
     *   without being the token itself (the JWT's `sub`).
     */
    constructor(principal: () => Promise<string | undefined>);
    for(model: string): Promise<string | undefined>;
}
/**
 * `sess-<sequence>-<8 hex>`, the shape the official client sends.
 *
 * The sequence is the official client's process-local counter and is pinned to 0
 * here on purpose: an incrementing value would make one conversation look like a
 * different session after a restart, which is the one thing this id exists to
 * prevent. Identity lives in the digest, which is truncated on purpose — the id
 * must separate accounts without naming them on the wire.
 */
export declare function raccoonSessionId(principal: string, model: string): string;
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
    private readonly sessionIds;
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
    /**
     * The chat headers, including the session id the gateway counts sessions by.
     *
     * Only chat carries it: the catalogue, quota and check-in routes are plain
     * business calls the official client sends outside any session, so leaving
     * them alone keeps this change to the one route it was measured on.
     */
    private chatHeaders;
    /** Run one JSON call; a rejected token means this login needs a new scan. */
    private authorizedJson;
    private fetchModels;
    models(fresh?: boolean): Promise<readonly ProviderModel[]>;
    /** The last successful catalogue, without waiting for a refresh. */
    peekModels(): readonly ProviderModel[] | undefined;
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
