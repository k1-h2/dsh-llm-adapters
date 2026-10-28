/**
 * Provider-neutral model rows plus the two upstream catalog parsers.
 *
 * The settings page needs more than `LlmModelInfo` (vision, context, multiplier,
 * labels), so adapters keep this shape internally and project it down to the
 * harness on `listModels`/`resolveModel`.
 *
 * Capability rules are shared by both providers: match the normalized name
 * against OpenRouter first, fall back to the upstream declaration, and expose
 * every effort/modality when neither source says anything. No model is
 * special-cased.
 *
 * @module dsh-llm-adapters/catalog
 */
import type { OpenRouterIndex } from './openrouter.ts';
export { priceFactorOf } from './model-name.ts';
export interface ProviderModel {
    id: string;
    name: string;
    description?: string;
    /** Non-price bracket contents from the upstream name (`限时免费`, …). */
    labels?: readonly string[];
    contextWindow: number;
    /** Widest window the upstream offers (Trae's Max tier), when it publishes one. */
    maxContextWindow?: number;
    maxTokens?: number;
    /**
     * The route can take image input. This is what the harness checks before it
     * hands pixels to the adapter, so a relayed capability counts here too.
     */
    vision: boolean;
    /**
     * Images arrive through a transcript produced by another model rather than
     * being read natively. Settings pages show the native tag only, and use this
     * flag for the explanatory hint.
     */
    visionRelay?: boolean;
    reasoning: boolean;
    reasoningEfforts?: readonly string[];
    defaultReasoningEffort?: string;
    priceFactor?: number;
    badge?: string;
    tags?: readonly string[];
}
/** Every level the shared fallback exposes when no source knows the model. */
export declare const ALL_REASONING_EFFORTS: readonly string[];
export declare const ALL_INPUT_MODALITIES: readonly string[];
/** Legacy two-state ids, kept so older saved selections still map on the wire. */
export declare const RACCOON_EFFORT_ON = "on";
export declare const RACCOON_EFFORT_OFF = "off";
export declare const DEFAULT_CONTEXT_WINDOW = 200000;
/** Display label for one effort id: `None`, `Low`, `High`, `Max`; `xhigh` stays as vendors spell it. */
export declare function effortLabel(effort: string): string;
/**
 * The default level: second strongest of the supported list.
 *
 * Starting one step below the top gives a useful reasoning budget whenever the
 * user switches models, without silently paying for the most expensive tier —
 * and without starting at `none`, which makes a reasoning model look broken.
 */
export declare function defaultEffortOf(efforts: readonly string[]): string | undefined;
export interface ResolvedCapabilities {
    efforts: readonly string[];
    defaultEffort?: string;
    modalities: readonly string[];
}
/**
 * Resolve one model's efforts and modalities from the two allowed sources.
 *
 * 1. Live OpenRouter metadata wins when it carries the field.
 * 2. Otherwise the upstream declaration (`reasoning_efforts`, `input_modalities`,
 *    `vision`, tags) is used.
 * 3. When neither says anything, every effort and both modalities are exposed.
 */
export declare function resolveCapabilities(input: {
    live?: {
        efforts?: readonly string[];
        inputModalities?: readonly string[];
    };
    upstreamEfforts?: readonly string[];
    upstreamReasoning?: boolean;
    upstreamModalities?: readonly string[];
}): ResolvedCapabilities;
/**
 * Parse Loomy's `/models` response.
 *
 * The upstream returns an OpenAI-style list but varies whether the array sits
 * at `data`, `models`, or `data.models`; the multiplier and promo text are
 * embedded in the display name rather than in structured fields.
 */
export declare function parseLoomyCatalog(payload: unknown, options?: {
    textOnly?: ReadonlySet<string>;
    forceVision?: ReadonlySet<string>;
    openRouter?: OpenRouterIndex;
}): ProviderModel[];
/**
 * Parse Raccoon's `model_catalog` response.
 *
 * Only `categories[type=chat]` is relevant. The catalogue's `name` is both the
 * model id and the value the completion endpoint accepts; the human label comes
 * from `description` (the product name), while `display_description` is a
 * workload sentence shown as the description.
 */
export declare function parseRaccoonCatalog(payload: unknown, options?: {
    textOnly?: ReadonlySet<string>;
    forceVision?: ReadonlySet<string>;
    /** Live OpenRouter index, matched by normalized name or id. */
    openRouter?: OpenRouterIndex;
}): ProviderModel[];
export interface CatalogSnapshot<T> {
    models: readonly T[];
    at: number;
}
/**
 * A small stale-while-error cache.
 *
 * A failed refresh keeps the last successful list and reports the failure
 * separately, so a transient network error does not make every model vanish
 * from the picker. `fresh` always bypasses the TTL.
 */
export declare class ModelCatalog {
    private readonly load;
    private readonly ttlMs;
    private snapshot;
    private lastError;
    private inflight;
    constructor(load: () => Promise<ProviderModel[]>, ttlMs: () => number);
    models(fresh?: boolean): Promise<readonly ProviderModel[]>;
    error(): string | undefined;
    invalidate(): void;
}
