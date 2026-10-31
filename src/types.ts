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
  /** The headline figure: credits left for Loomy/Raccoon, the allowance for Trae and CodeArts. */
  total?: number
  /** Spendable now; Loomy only. */
  available?: number
  /** Permanent Loomy pool. */
  permanent?: number
  /** Daily resetting Loomy pool. */
  daily?: number
  /** Loomy's daily cycle label, when present. */
  cycle?: string
  /** Consumed so far. Together with `total` it drives the card's usage bar. */
  used?: number
  /** Upstream-reported percentage; the card prefers its own used/total figure. */
  ratio?: number
  /** Trae CN: per-package breakdown, soonest expiry first. */
  packs?: readonly QuotaPack[]
  /** Trae international: subscription label (`Pro`, `Free plan`, `试用`…). */
  plan?: string
  trialEndsAt?: number
  /** Trae international bills in dollars, not credits. */
  unit?: 'usd'
  /** When the current quota period resets. */
  resetAt?: number
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
  /** When the reward was actually issued (epoch ms), so "today" is verifiable. */
  grantedAt?: number
  message?: string
  /** A page the user can open when the provider has no claimable API. */
  url?: string
}

/**
 * The local Trae client's state, as shown on the settings page.
 *
 * Never carries the token: only whether the client was found, whether a usable
 * login was read, and the non-secret account fields.
 */
export interface ClientLoginStatus {
  /** A Trae client data directory exists on this machine. */
  available: boolean
  /** The stored login is present, unexpired and usable. */
  signedIn: boolean
  name?: string
  userId?: string
  expiresAt?: number
  error?: string
}

export interface ProviderStatus extends AuthStatus {
  brand: BrandId
  /** Trae only: the region this reading belongs to. */
  region?: TraeRegion
  /** Present only after a successful quota read. */
  quota?: QuotaSnapshot
  quotaError?: string
  /** Trae only: the second sign-in method, when the desktop client exists. */
  clientLogin?: ClientLoginStatus
  /** Trae CN only, and only for a login imported from the client. */
  checkin?: CheckinStatus
}

export type { LocalAccount }
