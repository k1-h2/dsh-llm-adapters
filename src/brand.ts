/**
 * Identity of the two providers this plugin serves.
 *
 * Both speak OpenAI Chat Completions over HTTP and both reuse a locally signed
 * in desktop application, so they differ in endpoints, credential files and
 * catalog shapes rather than in transport.
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
  /** Desktop application whose local login is reused. */
  appName: string
}

export const LOOMY_PROVIDER = 'loomy'
export const RACCOON_PROVIDER = 'raccoon'

export const LOOMY_BRAND: BrandProfile = {
  id: 'loomy',
  provider: LOOMY_PROVIDER,
  defaultDisplayName: 'Loomy',
  enabledKey: 'loomyEnabled',
  appName: 'Loomy',
}

export const RACCOON_BRAND: BrandProfile = {
  id: 'raccoon',
  provider: RACCOON_PROVIDER,
  defaultDisplayName: '商汤小浣熊',
  enabledKey: 'raccoonEnabled',
  appName: '商汤小浣熊',
}

export const BRANDS: readonly BrandProfile[] = [LOOMY_BRAND, RACCOON_BRAND]

export function isBrandId(value: unknown): value is BrandId {
  return value === 'loomy' || value === 'raccoon'
}
