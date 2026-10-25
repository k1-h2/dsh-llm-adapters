/**
 * Identity of the two providers this plugin serves.
 *
 * Both speak OpenAI Chat Completions over HTTP and both sign in through a
 * WeChat QR flow, so they differ in endpoints, login protocol and catalog
 * shapes rather than in transport.
 *
 * @module dsh-llm-adapters/brand
 */

export type BrandId = 'loomy' | 'raccoon'

export interface BrandProfile {
  id: BrandId
  /** LLM provider route registered on the harness. */
  provider: string
  defaultDisplayName: string
  /** Config field that switches this provider on or off. */
  enabledKey: 'loomyEnabled' | 'raccoonEnabled'
}

export const LOOMY_PROVIDER = 'loomy'
export const RACCOON_PROVIDER = 'raccoon'

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

export const BRANDS: readonly BrandProfile[] = [LOOMY_BRAND, RACCOON_BRAND]

export function isBrandId(value: unknown): value is BrandId {
  return value === 'loomy' || value === 'raccoon'
}
