/**
 * Shared model-name rules for every provider.
 *
 * Upstream catalogs are inconsistent: Loomy embeds the multiplier and promo
 * text in parentheses, Raccoon writes `GLM-5-3` where the product is `GLM 5.3`,
 * and both mix full-width and half-width punctuation. The settings page wants a
 * clean product name, a price badge and a few labels, and OpenRouter matching
 * wants a stable comparison key — so all of that is derived here instead of
 * being special-cased per provider.
 *
 * @module dsh-llm-adapters/model-name
 */
/** `x3.0`, `× 0.1`, `3倍`, optionally inside parentheses or after a space. */
export declare function priceFactorOf(text: string): number | undefined;
export interface ParsedModelName {
    /** Clean product name with brackets and version hyphens removed. */
    name: string;
    /** Non-price bracket contents, in upstream order. */
    labels: string[];
    /** Multiplier found in a bracket, if any. */
    priceFactor?: number;
}
/**
 * Normalize one upstream display name.
 *
 * - `(x0.0)` / `（x0.8）` is the price, so it is removed from the name instead
 *   of being repeated there; the settings page renders it after the labels.
 * - Any other bracket content becomes a label (`(限时免费)` → `限时免费`), so it
 *   can sit next to the 读图 / 思考 tags.
 * - Hyphens between digits become dots (`GLM-5-3` → `GLM 5.3`); other hyphens
 *   become spaces (`Kimi-K3` → `Kimi K3`).
 */
export declare function parseModelName(raw: string): ParsedModelName;
/** Comparison key shared by upstream names, upstream ids and OpenRouter. */
export declare function modelKey(value: string): string;
