/** Shared display/status shapes for the settings API. @module dsh-llm-adapters/types */

import type { BrandId, TraeRegion } from './brand.ts'
import type { AuthStatus, LocalAccount } from './auth.ts'

/** One Trae entitlement pack: what it grants, what is left, when it ends. */
export interface QuotaPack {
  label: string
  total?: number
  used?: number
  expiresAt?: number
}

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
  /** Trae: amount already consumed and the percentage it represents. */
  used?: number
  ratio?: number
  /** Trae CN: per-package breakdown, soonest expiry first. */
  packs?: readonly QuotaPack[]
  /** Trae international: subscription label (`Pro`, `Free`, `试用`…). */
  plan?: string
  trialEndsAt?: number
  at: number
}

/**
 * Daily check-in state.
 *
 * Trae grants one reward per account per day, and its `did_checked_in` flag is
 * per DEVICE: an account that has not claimed today can still be blocked
 * because this browser already claimed for another account. Those two facts are
 * reported separately so the button never calls the second one "已领取".
 */
export interface CheckinStatus {
  available: boolean
  claimed: boolean
  deviceClaimed: boolean
  reward?: number
  message?: string
}

export interface ProviderStatus extends AuthStatus {
  brand: BrandId
  /** Trae only: the region this reading belongs to. */
  region?: TraeRegion
  /** Present only after a successful quota read. */
  quota?: QuotaSnapshot
  quotaError?: string
  /** Trae CN only. */
  checkin?: CheckinStatus
}

export type { LocalAccount }
