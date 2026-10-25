/**
 * Identity of the providers this plugin serves.
 *
 * All three speak HTTP against the provider's own gateway and sign in through a
 * browser flow, so they differ in endpoints, login protocol and catalog shapes
 * rather than in transport. Trae has two independent regions (mainland and
 * international) behind one provider route; the region is a setting, not a
 * second brand, so its account and model choices stay on one settings page.
 *
 * @module dsh-llm-adapters/brand
 */

export type BrandId = 'loomy' | 'raccoon' | 'trae'
export type TraeRegion = 'cn' | 'global'

export interface BrandProfile {
  id: BrandId
  /** LLM provider route registered on the harness. */
  provider: string
  defaultDisplayName: string
  /** Config field that switches this provider on or off. */
  enabledKey: 'loomyEnabled' | 'raccoonEnabled' | 'traeEnabled'
}

export const LOOMY_PROVIDER = 'loomy'
export const RACCOON_PROVIDER = 'raccoon'
export const TRAE_PROVIDER = 'trae'

export const LOOMY_BRAND: BrandProfile = {
  id: 'loomy',
  provider: LOOMY_PROVIDER,
  defaultDisplayName: 'Loomy',
  enabledKey: 'loomyEnabled',
}

export const RACCOON_BRAND: BrandProfile = {
  id: 'raccoon',
  provider: RACCOON_PROVIDER,
  defaultDisplayName: '商汤小浣熊',
  enabledKey: 'raccoonEnabled',
}

export const TRAE_BRAND: BrandProfile = {
  id: 'trae',
  provider: TRAE_PROVIDER,
  defaultDisplayName: 'Trae',
  enabledKey: 'traeEnabled',
}

export const BRANDS: readonly BrandProfile[] = [LOOMY_BRAND, RACCOON_BRAND, TRAE_BRAND]

export function isBrandId(value: unknown): value is BrandId {
  return value === 'loomy' || value === 'raccoon' || value === 'trae'
}

/** Normalize any stored spelling to one of the two Trae regions. */
export function normalizeTraeRegion(value: unknown): TraeRegion {
  return value === 'global' ? 'global' : 'cn'
}
