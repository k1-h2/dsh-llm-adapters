/**
 * Identity of the providers this plugin serves.
 *
 * All four speak HTTP against the provider's own gateway and sign in through a
 * browser flow, so they differ in endpoints, login protocol and catalog shapes
 * rather than in transport. Trae has two independent regions (mainland and
 * international) behind one provider route; the region is a setting, not a
 * second brand, so its account and model choices stay on one settings page.
 *
 * CodeArts is the one provider that does not use a bearer token: its gateway
 * verifies an `SDK-HMAC-SHA256` signature, which the account record carries.
 *
 * @module dsh-llm-adapters/brand
 */
export type BrandId = 'loomy' | 'raccoon' | 'trae' | 'codearts';
export type TraeRegion = 'cn' | 'global';
export interface BrandProfile {
    id: BrandId;
    /** LLM provider route registered on the harness. */
    provider: string;
    defaultDisplayName: string;
    /** Config field that switches this provider on or off. */
    enabledKey: 'loomyEnabled' | 'raccoonEnabled' | 'traeEnabled' | 'codeartsEnabled';
}
export declare const LOOMY_PROVIDER = "loomy";
export declare const RACCOON_PROVIDER = "raccoon";
export declare const TRAE_PROVIDER = "trae";
export declare const CODEARTS_PROVIDER = "codearts";
export declare const LOOMY_BRAND: BrandProfile;
export declare const RACCOON_BRAND: BrandProfile;
export declare const TRAE_BRAND: BrandProfile;
export declare const CODEARTS_BRAND: BrandProfile;
export declare const BRANDS: readonly BrandProfile[];
export declare function isBrandId(value: unknown): value is BrandId;
/** Normalize any stored spelling to one of the two Trae regions. */
export declare function normalizeTraeRegion(value: unknown): TraeRegion;
