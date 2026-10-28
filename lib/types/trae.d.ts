/**
 * Trae provider: model directory, SOLO chat, quota and daily check-in.
 *
 * Trae's website login yields the same `Cloud-IDE-JWT` its own clients use, so
 * the plugin talks to the same gateways they do. Two catalog sources are merged:
 *
 *  - the Remote directory (`/api/remote/v1/models`) is the model skeleton —
 *    display name, context window, multiplier, reasoning options, multimodal;
 *  - `get_detail_param` supplies the `config_name` the chat endpoint accepts and
 *    the output cap. A directory row with no callable config is NOT offered:
 *    Trae lists some client-only models (Qwen3.8-Flash, Kimi-K2.8-Preview) that
 *    the SOLO chat endpoint rejects with `4001`, and an entry that can only
 *    fail is worse than an absent one.
 *
 * Levels and modalities go through the same `resolveCapabilities` rule as
 * Loomy and Raccoon: OpenRouter's live metadata first, Trae's own declaration
 * second, every level/modality when neither source says anything. The SOLO
 * endpoint does not validate `reasoning_effort`, so the router's table cannot
 * make a call fail; the shared index is cached on disk and refreshed on a
 * schedule, which keeps the menu stable while offline.
 *
 * @module dsh-llm-adapters/trae
 */
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { AccountStore } from './account-store.ts';
import { TraeAuth } from './auth.ts';
import type { TraeRegion } from './brand.ts';
import { ModelCatalog } from './catalog.ts';
import type { ProviderModel } from './catalog.ts';
import type { LoginStatus } from './login-page.ts';
import type { OpenRouterIndex, OpenRouterLookup } from './openrouter.ts';
import type { CheckinStatus, QuotaSnapshot } from './types.ts';
import type { ReadImage, WireMessage } from './wire.ts';
/** Chat functions, in the order Trae itself prefers them. */
export declare const TRAE_CHAT_FUNCTIONS: readonly string[];
/**
 * Directory functions. The first five are the chat routes above; the rest are
 * IDE-only rosters that still list real models, so they are read for the union
 * and their attribution is dropped when the chat route cannot use it.
 */
export declare const TRAE_DIRECTORY_FUNCTIONS: readonly string[];
export declare const TRAE_DEFAULT_FUNCTION = "solo_work_lite";
/**
 * The channels Trae's own chat picker draws from.
 *
 * `solo_coder`, `chat_v3`, `inline_chat` and `solo_agent*` still answer with
 * configs, but they also carry retired models (GLM 4.6/4.7, MiniMax M2,
 * Kimi K2.0905, Qwen3 Coder, the plain DeepSeek-V4-Flash/Pro). Those rows are
 * not in the client's list, so a wire config alone does not make a model
 * current. Restricting the catalog to the two work functions reproduces the
 * client's picker (21 models on a live CN account).
 */
export declare const TRAE_PRIMARY_FUNCTIONS: readonly string[];
export interface TraeRemoteModel {
    id: string;
    name: string;
    contextWindow?: number;
    maxContextWindow?: number;
    creditMultiplier?: number;
    multimodal: boolean;
    efforts: string[];
    function?: string;
    /**
     * Listed by the normal chat channels (`solo_work_remote` / `solo_work_lite`).
     * The specialist rosters also carry legacy entries the Trae client no longer
     * offers, so only these rows may become models.
     */
    primary: boolean;
}
export interface TraeWireModel {
    configName: string;
    name: string;
    maxTokens?: number;
    contextWindow?: number;
    creditMultiplier?: number;
    multimodal?: boolean;
    /** Upstream usage kind; only `chat_completion` rows are user-facing models. */
    usage?: string;
    /** Upstream config source; 1 marks a first-party chat config. */
    configSource?: number;
    efforts: string[];
    function: string;
}
export interface TraeModelMeta {
    configName: string;
    function: string;
    wireEfforts: Readonly<Record<string, string>>;
}
export interface TraeCatalog {
    models: ProviderModel[];
    meta: Map<string, TraeModelMeta>;
}
export interface TraeProviderOptions {
    auth: TraeAuth;
    store: AccountStore;
    region: () => TraeRegion;
    ttlMs: () => number;
    timeoutMs: () => number;
    textOnly: () => ReadonlySet<string>;
    forceVision: () => ReadonlySet<string>;
    fetchImpl?: typeof fetch;
    loginTimeoutMs?: number;
    logger?: (message: string) => void;
    /** The shared OpenRouter snapshot; a private one is created when omitted. */
    openRouter?: OpenRouterLookup;
}
/**
 * The device id Trae's check-in API expects.
 *
 * The endpoint only accepts a 16-digit decimal device id; a UUID (what the web
 * session's `__msuuid__` looks like) is rejected with `9074` even though every
 * other Trae call accepts it. Live matrix (same account, same minute):
 * UUID -> `9074`, 16-digit number -> `code: 0`. The number is derived from the
 * web session's device id, so it still comes from this login and not from a
 * desktop install, and it stays stable for that session.
 *
 * The desktop client's ids look like `2715142696215459`: 16 digits starting
 * with 1–8. The 9-prefixed value derived for the current login was answered
 * with `9074`, so the derived range stays inside the client's range.
 */
export declare function checkinDeviceId(deviceId: string): string;
/**
 * The body every check-in POST carries.
 *
 * Matches the desktop client's own call: `req_source` is the numeric `1` for
 * the IDE (the client sends `2` for Trae Work). The plugin used to send `{}`;
 * status tolerated that, but claim answered `9074` (`当前参与用户太多`) for the
 * same account and device, so requests now carry the client's field.
 */
export declare const TRAE_CHECKIN_REQ_SOURCE = 1;
/**
 * The persistent browser profile used for one region.
 *
 * Reusing it keeps Trae's device fingerprint stable across sign-ins, so a
 * re-login does not look like a brand-new device to its risk checks.
 */
export declare function traeBrowserProfileDir(store: AccountStore, region: TraeRegion): string;
/** Map one upstream effort name to our id, dropping names we do not know. */
export declare function normalizeEffort(value: unknown): string | undefined;
export declare function effortsOf(value: unknown): string[];
/**
 * Parse the Remote directory.
 *
 * Groups are walked in {@link TRAE_CHAT_FUNCTIONS} order first so the chat
 * attribution prefers the same function the bridge calls, then the IDE-only
 * groups fill the union. Duplicate ids keep the stronger capacity row.
 */
export declare function parseTraeRemoteModels(payload: unknown): TraeRemoteModel[];
/** Parse one `get_detail_param` answer into wire rows. */
export declare function parseTraeWireModels(payload: unknown, functionName: string): TraeWireModel[];
/**
 * Merge the two sources into the rows DSH sees plus the call metadata.
 *
 * Only directory rows that the Trae client itself lists in its normal chat
 * picker (`solo_work_*`) are candidates, and each must resolve to a wire
 * `config_name` because that is the only id the chat endpoint accepts. Rows
 * that share a display name collapse to the wider one instead of being
 * decorated with their id: the shared naming rule keeps bracket contents as
 * labels, so synthesizing `(id)` in the name is not allowed.
 */
export declare function mergeTraeModels(remote: readonly TraeRemoteModel[], wire: readonly TraeWireModel[], openRouter?: OpenRouterIndex): TraeCatalog;
/** Trae tool schemas want `parameters` as a JSON string, without boolean `required`. */
export declare function normalizeTraeToolSchema(value: unknown): unknown;
/** Project the harness request onto Trae's message shape. */
export declare function traeMessages(messages: readonly WireMessage[]): Record<string, unknown>[];
export declare function traeTools(tools: GenerateOptions['tools']): Record<string, unknown>[] | undefined;
/** Convert Trae's stream into harness chunks. */
export declare function openTraeStream(body: ReadableStream<Uint8Array>, model: string): AsyncGenerator<StreamChunk>;
/** CN entitlement document → the card's quota shape. */
export declare function parseTraeUsage(payload: unknown): QuotaSnapshot;
/**
 * International entitlement document → the card's quota shape.
 *
 * The website's "Dollar Usage" panel reads `web_user_ent_usage`, not
 * `ide_user_pay_status`: the latter carries the plan name but no amounts. On a
 * dollar-billing account `basic_usage_limit` is the monthly allowance (1.00 on
 * the free plan) and `basic_usage_amount` is the spend, so those numbers are
 * dollars and must not be printed as credits.
 */
export declare function parseTraeGlobalUsage(payload: unknown): QuotaSnapshot;
export declare function parseTraeCheckin(payload: unknown): CheckinStatus;
export declare class TraeProvider {
    private readonly options;
    private catalogInstance;
    private catalogRegion;
    private meta;
    private quotaCache;
    private quotaInflight;
    private quotaInflightRegion;
    private loginFlow;
    private readonly fetchImpl;
    private readonly openRouter;
    constructor(options: TraeProviderOptions);
    /** The catalog the currently selected region sees. */
    get catalog(): ModelCatalog;
    /**
     * Keep every cache on the selected region.
     *
     * The two deployments share no model ids, config names or quota, so a switch
     * swaps the catalog instance (which also orphans any fetch still in flight for
     * the previous region) and drops the quota reading.
     */
    private ensureRegion;
    private profile;
    status(): Promise<{
        region: TraeRegion;
        signedIn: boolean;
        loginAt?: number;
        expiresAt?: number;
        possiblyExpired?: boolean;
        account?: import("./auth.ts").LocalAccount;
        error?: string;
    }>;
    signedIn(): Promise<boolean>;
    models(fresh?: boolean): Promise<readonly ProviderModel[]>;
    catalogError(): string | undefined;
    invalidateModels(): void;
    invalidateQuota(): void;
    private headers;
    private chatHeaders;
    private fetchRemote;
    private fetchWire;
    private fetchCatalog;
    quota(fresh?: boolean): Promise<QuotaSnapshot>;
    checkinStatus(): Promise<CheckinStatus>;
    /** Claim today's reward. The only state-changing call in this provider. */
    claimCheckin(): Promise<CheckinStatus>;
    stream(options: GenerateOptions, model: string, readImage: ReadImage | undefined, onInvalidate: () => void): AsyncGenerator<StreamChunk>;
    startBrowserLogin(region?: TraeRegion): Promise<LoginStatus>;
    browserLoginStatus(): LoginStatus;
    cancelBrowserLogin(): Promise<void>;
    logoutAccount(): Promise<void>;
    close(): void;
}
