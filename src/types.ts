/** Shared display/status shapes for the settings API. @module dsh-llm-adapters/types */

import type { BrandId } from './brand.ts'
import type { AuthStatus, LocalAccount } from './auth.ts'

export interface QuotaSnapshot {
  /** Points/credits left when the upstream reports one figure. */
  total?: number
  /** Spendable now; Loomy only. */
  available?: number
  /** Permanent Loomy pool. */
  permanent?: number
  /** Daily resetting Loomy pool. */
  daily?: number
  /** Loomy's daily cycle label, when present. */
  cycle?: string
  at: number
}

export interface ProviderStatus extends AuthStatus {
  brand: BrandId
  /** Present only after a successful quota read. */
  quota?: QuotaSnapshot
  quotaError?: string
}

export type { LocalAccount }
