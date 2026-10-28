/**
 * Huawei CodeArts (码道) gateway client.
 *
 * Three things separate it from the other routes:
 *
 * 1. **No bearer token.** Every call is signed (`SDK-HMAC-SHA256`) with the
 *    AK/SK/security-token triple from the OAuth exchange.
 * 2. **The catalogue is two rosters.** `opengw gateway/config` lists the
 *    free-allowance ("benefit") models and `/v1/model/builtin` the ordinary
 *    ones; a model is only callable on the roster that listed it.
 * 3. **No context window anywhere.** The upstream publishes none, so the value
 *    comes from the IDE's own provider configuration (see
 *    {@link codeartsContextWindow}).
 *
 * @module dsh-llm-adapters/codearts
 */
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { AccountStore } from './account-store.ts';
import { CodeArtsAuth } from './auth.ts';
import type { AuthStatus } from './auth.ts';
import type { ProviderModel } from './catalog.ts';
import { CodeArtsSessionWindow } from './codearts-window.ts';
import type { LoginStatus } from './login-page.ts';
import type { OpenRouterLookup } from './openrouter.ts';
import type { CheckinStatus, QuotaPack, QuotaSnapshot } from './types.ts';
import type { ReadImage } from './wire.ts';
/**
 * Levels the gateway accepts, plus the two-state switch this route started with.
 *
 * `reasoning_effort` is validated per model (deepseek accepts
 * `none|low|medium|high|xhigh|max`, glm-5.3 rejects `none` outright), and the
 * IDE's own client offers the levels, so they are forwarded as-is. Whether a
 * level changes the answer is up to the model: on a proof prompt
 * `deepseek-v4.1-flash` spent 388 reasoning tokens on `none`, 480 on `low`,
 * 515 on `max` and 595 with the field omitted. `off` (and a legacy `none`)
 * keeps using the one switch that definitely works, `thinking: disabled`;
 * `on` is the old default and sends neither field.
 */
export declare const CODEARTS_DEFAULT_EFFORT = "on";
/**
 * The level a model starts on: the strongest one it offers.
 *
 * Every provider starts on its top level; `off` / `on` carry no rank, so a
 * model the router only allows the two-state switch on still resolves to `on`.
 */
export declare function codeartsDefaultEffort(efforts: readonly string[]): string;
/**
 * The levels one model offers: `off` / `on` always, then the graded levels the
 * gateway validates and OpenRouter says the model accepts.
 *
 * The router's list is intersected with {@link CODEARTS_EFFORT_LEVELS} rather
 * than copied, so an editor-only level (`minimal`) never reaches a model that
 * answers 4xx for it. A model the router does not list, and a router with no
 * snapshot yet, keep every graded level: hiding controls the upstream does
 * accept is worse than offering one that has no measured effect.
 */
export declare function codeartsEfforts(live?: {
    efforts?: readonly string[];
}): string[];
/** Every level a CodeArts model can get: the fallback when the router is silent. */
export declare const CODEARTS_EFFORTS: readonly string[];
export interface CodeArtsProviderOptions {
    auth: CodeArtsAuth;
    store: AccountStore;
    ttlMs: () => number;
    timeoutMs: () => number;
    textOnly: () => ReadonlySet<string>;
    /** Kept for parity with the other providers; every CodeArts model now takes images. */
    forceVision: () => ReadonlySet<string>;
    fetchImpl?: typeof fetch;
    logger?: (message: string) => void;
    loginTimeoutMs?: number;
    /** Injectable OpenRouter lookup for tests; defaults to the live catalog. */
    openRouter?: OpenRouterLookup;
    /** Chat budget; defaults to the process-wide window (survives hot reloads). */
    window?: CodeArtsSessionWindow;
}
/** One roster entry before it becomes a model row. */
export interface CodeArtsModelRow {
    id: string;
    name: string;
    /** Display multiplier (`0.7x`) as the upstream spells it. */
    rateLabel?: string;
    /** `supports_images` from the builtin roster; the gateway roster never sets it. */
    images?: boolean;
}
/** `deepseek-v4-flash-0731` → `deepseek-v4-flash`; chat only knows the latter. */
export declare function normalizeCodeArtsModelId(id: string): string;
/**
 * Pick the credit entry that applies right now.
 *
 * `deepseek-v4.1-flash` carries two: 0.18x by default and 0.09x from 21:00 for
 * eleven hours. Showing `credit[0]` would advertise the wrong number for a third
 * of the day. Only the measured shape is understood (an hour-of-day start plus
 * an hour count); anything else falls back to the first entry, which is exactly
 * how the upstream behaves when a model has no slots at all.
 */
export declare function pickActiveCredit(credit: readonly unknown[], slots: unknown, nowMs?: number): Record<string, unknown> | undefined;
/** Read one roster into rows, dropping duplicates. */
export declare function parseCodeArtsRoster(items: unknown, nowMs?: number): CodeArtsModelRow[];
/** `0.7x` → `0.7`; anything else is left alone rather than guessed. */
export declare function priceFactorOfLabel(label: string | undefined): number | undefined;
export declare class CodeArtsProvider {
    private readonly options;
    private readonly catalog;
    private readonly login;
    private quotaSnapshot;
    private quotaInflight;
    private benefitModels;
    /** Models that answered `InferHub.4004.200`: no allowance pack to bill. */
    private readonly noBenefit;
    private noBenefitLoaded;
    private readonly window;
    private readonly openRouter;
    private readonly sessionId;
    /**
     * Models that read images themselves. Seeded from the measured list so the
     * answer is right before the first catalogue load, then widened by whatever
     * the roster marks `supports_images`.
     */
    private readonly nativeVision;
    /** Image transcripts, keyed by the hash of the data URL they were read from. */
    private imageCache;
    private imageCacheLoad;
    private imageCacheWrite;
    constructor(options: CodeArtsProviderOptions);
    private get fetcher();
    private credential;
    models(fresh?: boolean): Promise<readonly ProviderModel[]>;
    /** The last successful roster, without waiting for a refresh. */
    peekModels(): readonly ProviderModel[] | undefined;
    catalogError(): string | undefined;
    invalidateModels(): void;
    /** Signed GET returning the parsed body, or `undefined` on any failure. */
    private signedGet;
    private loadModels;
    /** Whether this model must be called with `maas_type: benefit`. */
    isBenefitModel(model: string): boolean;
    /** Load the persisted "no allowance pack" verdicts once. */
    private loadNoBenefit;
    private rememberNoBenefit;
    quota(fresh?: boolean): Promise<QuotaSnapshot>;
    invalidateQuota(): void;
    private readQuota;
    checkinStatus(): Promise<CheckinStatus>;
    claimCheckin(): Promise<CheckinStatus>;
    private signedPost;
    private accountInfo;
    private activities;
    private imageCacheFile;
    private imageTranscripts;
    private rememberTranscript;
    /**
     * Replace image parts with a transcript for models the gateway serves as text.
     *
     * `buildMessages` has already turned each attachment into a data URL, which is
     * both what the vision model needs and a stable identity for the cache: the
     * same picture in a later turn resolves to the same key and reuses the text,
     * so a conversation pays for the description once.
     */
    private relayImages;
    /** Ask the vision model to describe one image, within the same chat budget. */
    private describeImage;
    stream(options: GenerateOptions, model: string, readImage: ReadImage | undefined, onInvalidate: () => void): AsyncGenerator<StreamChunk>;
    private send;
    status(): Promise<AuthStatus>;
    signedIn(): Promise<boolean>;
    startBrowserLogin(): Promise<LoginStatus>;
    browserLoginStatus(): LoginStatus;
    cancelBrowserLogin(): Promise<void>;
    logoutAccount(): Promise<void>;
    close(): void;
}
/** Cap `max_tokens` at the gateway's limit; a larger value is a hard 4xx. */
export declare function clampMaxTokens(value: number | undefined): number;
export interface CodeArtsActivity {
    campaignId: string;
    type: string;
    claimable: boolean;
    status: string;
    amount: number;
}
export interface CodeArtsPackageInfo {
    isCreditPackage: boolean;
    packageName: string;
    packageStatus: string;
    credit: {
        /** Granted by the subscription (`package_credit_amount` on the summary row). */
        amount?: number;
        /** Already spent (`package_credit_used` on the summary row). */
        used?: number;
        /** Still spendable (`package_credit_remain` on the summary row). */
        remaining?: number;
        packs: QuotaPack[];
    };
}
/**
 * Parse `snap-manager/v1/statistics/plugin`.
 *
 * The total row is a summary of the three category rows, so it is never also
 * listed as a pack — summing both would double every credit. It is, however,
 * the only row that reports the allowance *and* the spend together, which is
 * what a used/total bar needs, so its three figures are kept as-is. Only the
 * basic pack gets a real expiry (the subscription's `end_date`); the bonus and
 * on-demand packs have no per-pack date, and borrowing the subscription date
 * for them would claim credits expire when they do not.
 */
export declare function parseCodeArtsPackage(payload: Record<string, unknown>): CodeArtsPackageInfo;
