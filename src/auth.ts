/**
 * Credential state for every provider.
 *
 * Sign-in happens in the provider's own web page, so credentials exist in
 * exactly one place: the plugin's own account store. No desktop client file is
 * discovered, read, or written, and no token leaves this module in errors or
 * display fields.
 *
 * @module dsh-llm-adapters/auth
 */

import type {
  AccountStore, CodeArtsAccountRecord, LoomyAccountRecord, RaccoonAccountRecord, TraeAccountRecord,
} from './account-store.ts'
import type { TraeRegion } from './brand.ts'
import { RefreshTokenExpiredError, exchangeRefreshToken, keyPairFromStoredJwk, readUserProfile } from './codearts-oauth.ts'
import type { CodeArtsCredential } from './codearts-oauth.ts'

export interface LocalAccount {
  name?: string
  phone?: string
  userId?: string
  ownerType?: string
  sessionId?: string
}

export interface AuthStatus {
  signedIn: boolean
  loginAt?: number
  expiresAt?: number
  /** The stored credential is past its own expiry. */
  possiblyExpired?: boolean
  account?: LocalAccount
  error?: string
}

/** Expiry margin for Raccoon's JWT, so a call does not start on a dead token. */
const RACCOON_EXPIRY_MARGIN_MS = 30_000
/** Same margin for Trae's web token. */
const TRAE_EXPIRY_MARGIN_MS = 30_000

function traeLabel(region: TraeRegion): string {
  return region === 'cn' ? 'Trae 国内版' : 'Trae 国际版'
}

function traeAccount(record: TraeAccountRecord): LocalAccount {
  const account: LocalAccount = {}
  if (record.name !== undefined) account.name = record.name
  if (record.userId !== undefined) account.userId = record.userId
  return account
}

function loomyAccount(record: LoomyAccountRecord): LocalAccount {
  const account: LocalAccount = {}
  if (record.name !== undefined) account.name = record.name
  if (record.phone !== undefined) account.phone = record.phone
  if (record.userId !== undefined) account.userId = record.userId
  return account
}

function raccoonAccount(record: RaccoonAccountRecord, facts: JwtFacts): LocalAccount {
  const account: LocalAccount = {}
  const name = record.name ?? facts.name
  const phone = record.phone ?? facts.phone
  if (name !== undefined) account.name = name
  if (phone !== undefined) account.phone = phone
  // Every request uses an empty X-Org-Code, so a QR account is personal unless
  // the login response said otherwise.
  account.ownerType = record.ownerType ?? facts.ownerType ?? 'personal'
  if (facts.sessionId !== undefined) account.sessionId = facts.sessionId
  return account
}

export class LoomyAuth {
  constructor(private readonly store: AccountStore) {}

  async status(): Promise<AuthStatus> {
    const stored = await this.store.loomy()
    if (stored === undefined) {
      return { signedIn: false, error: 'Loomy 尚未登录。请在设置页点「打开扫码登录」。' }
    }
    const account = loomyAccount(stored)
    const expired = stored.expiresAt <= Date.now()
    return {
      signedIn: !expired,
      loginAt: stored.loginAt,
      expiresAt: stored.expiresAt,
      ...expired ? { possiblyExpired: true } : {},
      ...Object.keys(account).length === 0 ? {} : { account },
      ...expired
        ? { error: 'Loomy 登录已过期，请在设置页重新扫码登录。' }
        : {},
    }
  }

  /** The bearer session, or undefined when there is no stored login. */
  async session(): Promise<string | undefined> {
    return (await this.store.loomy())?.session
  }

  async logout(): Promise<void> {
    await this.store.clear('loomy')
  }
}

export interface JwtFacts {
  expiresAt?: number
  name?: string
  phone?: string
  ownerType?: string
  sessionId?: string
}

/** Normalize seconds, milliseconds, and ISO strings to epoch milliseconds. */
function timestampOf(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value < 10_000_000_000 ? value * 1_000 : value
  }
  if (typeof value === 'string') {
    if (/^\d+$/.test(value)) return timestampOf(Number(value))
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

/** Read non-secret JWT claims; malformed tokens simply yield no facts. */
export function decodeJwtFacts(token: string): JwtFacts {
  const parts = token.split('.')
  if (parts.length < 2) return {}
  try {
    const base64 = parts[1]!.replace(/-/g, '+').replace(/_/g, '/')
    const padded = base64 + '='.repeat((4 - base64.length % 4) % 4)
    const payload: unknown = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'))
    if (payload === null || typeof payload !== 'object') return {}
    const record = payload as Record<string, unknown>
    return {
      ...timestampOf(record.exp) === undefined ? {} : { expiresAt: timestampOf(record.exp)! },
      ...typeof record.name === 'string' ? { name: record.name } : {},
      ...typeof record.phone === 'string' ? { phone: record.phone } : {},
      ...typeof record.owner_type === 'string' ? { ownerType: record.owner_type } : {},
      ...typeof record.sid === 'string' ? { sessionId: record.sid } : {},
    }
  } catch {
    return {}
  }
}

export class RaccoonAuth {
  constructor(private readonly store: AccountStore) {}

  async status(): Promise<AuthStatus> {
    const stored = await this.store.raccoon()
    if (stored === undefined) {
      return { signedIn: false, error: '小浣熊尚未登录。请在设置页点「打开扫码登录」。' }
    }
    const facts = decodeJwtFacts(stored.accessToken)
    // An opaque token carries no expiry. It was accepted by the gateway when
    // the login stored it, so it counts as signed in until a 401 says otherwise.
    const signedIn = facts.expiresAt === undefined
      || facts.expiresAt > Date.now() + RACCOON_EXPIRY_MARGIN_MS
    const account = raccoonAccount(stored, facts)
    return {
      signedIn,
      loginAt: stored.loginAt,
      ...facts.expiresAt === undefined ? {} : { expiresAt: facts.expiresAt },
      ...signedIn ? {} : { possiblyExpired: true },
      ...Object.keys(account).length === 0 ? {} : { account },
      ...signedIn
        ? {}
        : { error: '小浣熊登录已过期，请在设置页重新扫码登录。' },
    }
  }

  /**
   * The stored access token.
   *
   * A QR login has no refresh flow. `force` marks a gateway 401, so the only
   * honest answer then is to ask for a new scan.
   */
  async accessToken(force = false): Promise<string> {
    const stored = await this.store.raccoon()
    if (stored === undefined) {
      throw new Error('小浣熊尚未登录。请在设置页点「打开扫码登录」。')
    }
    if (force) {
      throw new Error('小浣熊登录已失效，请在设置页重新扫码登录。')
    }
    const facts = decodeJwtFacts(stored.accessToken)
    if (facts.expiresAt !== undefined && facts.expiresAt <= Date.now() + RACCOON_EXPIRY_MARGIN_MS) {
      throw new Error('小浣熊登录已过期，请在设置页重新扫码登录。')
    }
    return stored.accessToken
  }

  async logout(): Promise<void> {
    await this.store.clear('raccoon')
  }
}

/**
 * Trae's web login, one per region.
 *
 * The token is the same `Cloud-IDE-JWT` the website uses. There is no refresh
 * flow this plugin can rely on, so an expired token is a user-visible sign-in
 * action — the same contract the other two providers have.
 */
export class TraeAuth {
  constructor(
    private readonly store: AccountStore,
    private readonly currentRegion: () => TraeRegion,
  ) {}

  region(): TraeRegion {
    return this.currentRegion()
  }

  async status(): Promise<AuthStatus> {
    const region = this.region()
    const stored = await this.store.trae(region)
    if (stored === undefined) {
      return { signedIn: false, error: `${traeLabel(region)}尚未登录。请在设置页点「打开浏览器登录」。` }
    }
    const account = traeAccount(stored)
    const expired = stored.expiresAt !== undefined && stored.expiresAt <= Date.now() + TRAE_EXPIRY_MARGIN_MS
    return {
      signedIn: !expired,
      loginAt: stored.loginAt,
      ...stored.expiresAt === undefined ? {} : { expiresAt: stored.expiresAt },
      ...expired ? { possiblyExpired: true } : {},
      ...Object.keys(account).length === 0 ? {} : { account },
      ...expired ? { error: `${traeLabel(region)}登录已过期，请在设置页重新登录。` } : {},
    }
  }

  /** The bearer token, or an actionable error when there is none. */
  async accessToken(force = false): Promise<string> {
    const region = this.region()
    const stored = await this.store.trae(region)
    if (stored === undefined) {
      throw new Error(`${traeLabel(region)}尚未登录。请在设置页点「打开浏览器登录」。`)
    }
    if (force) {
      throw new Error(`${traeLabel(region)}登录已失效，请在设置页重新登录。`)
    }
    if (stored.expiresAt !== undefined && stored.expiresAt <= Date.now() + TRAE_EXPIRY_MARGIN_MS) {
      throw new Error(`${traeLabel(region)}登录已过期，请在设置页重新登录。`)
    }
    return stored.accessToken
  }

  /** The fingerprints captured from the web session, replayed on every call. */
  async identity(): Promise<{ deviceId: string, machineId: string, userId?: string }> {
    const region = this.region()
    const stored = await this.store.trae(region)
    if (stored === undefined) {
      throw new Error(`${traeLabel(region)}尚未登录。请在设置页点「打开浏览器登录」。`)
    }
    return {
      deviceId: stored.deviceId,
      machineId: stored.machineId,
      ...stored.userId === undefined ? {} : { userId: stored.userId },
    }
  }

  async logout(): Promise<void> {
    await this.store.clear('trae', this.region())
  }
}


/** Margin before the STS token's own expiry, so a call never starts on a dead one. */
const CODEARTS_EXPIRY_MARGIN_MS = 5 * 60_000

/**
 * CodeArts credentials.
 *
 * There is no bearer token: the gateway verifies a signature over each request,
 * so what this class hands out is the AK/SK/security-token triple. The STS token
 * lives two hours and is renewed with the refresh token; both the PKCE verifier
 * and the DPoP private key from the original login have to be reused, or Huawei
 * rejects the renewal.
 */
export class CodeArtsAuth {
  private inflight: Promise<CodeArtsCredential> | undefined
  private lastError: string | undefined

  constructor(private readonly store: AccountStore) {}

  async status(): Promise<AuthStatus> {
    const stored = await this.store.codearts()
    if (stored === undefined) {
      return { signedIn: false, error: 'CodeArts 尚未登录。请在设置页点「打开浏览器登录」。' }
    }
    const expired = stored.expiresAt !== undefined && stored.expiresAt <= Date.now()
    const refreshable = stored.refreshToken !== undefined && stored.codeVerifier !== undefined && stored.dpopPrivateJwk !== undefined
    // The name lives in the refresh token, so an account stored before this was
    // read still shows it without waiting for a renewal or a new sign-in.
    const userName = stored.userName ?? readUserProfile(stored.refreshToken)?.userName
    const account: LocalAccount = userName === undefined ? {} : { name: userName }
    return {
      signedIn: !expired || refreshable,
      loginAt: stored.loginAt,
      ...stored.expiresAt === undefined ? {} : { expiresAt: stored.expiresAt },
      ...expired && !refreshable ? { possiblyExpired: true } : {},
      ...Object.keys(account).length === 0 ? {} : { account },
      ...expired && !refreshable
        ? { error: 'CodeArts 登录已过期（STS 令牌两小时），请在设置页重新登录。' }
        : {},
      ...this.lastError === undefined ? {} : { error: this.lastError },
    }
  }

  /** A usable triple, renewed first when it is close to expiring. */
  async credential(): Promise<CodeArtsCredential> {
    const stored = await this.store.codearts()
    if (stored === undefined) throw new Error('CodeArts 尚未登录。请在设置页点「打开浏览器登录」。')
    const stale = stored.expiresAt !== undefined && stored.expiresAt <= Date.now() + CODEARTS_EXPIRY_MARGIN_MS
    if (!stale) return credentialOf(stored)
    if (stored.refreshToken === undefined || stored.codeVerifier === undefined || stored.dpopPrivateJwk === undefined) {
      throw new Error('CodeArts 登录已过期（STS 令牌两小时），请在设置页重新登录。')
    }
    return this.refresh(false)
  }

  /**
   * Renew the triple.
   *
   * `force` is used when the gateway rejected a signature the local clock still
   * considered valid (revoked or rotated token). A single in-flight renewal is
   * shared, so parallel requests do not each spend a refresh.
   */
  async refresh(force: boolean): Promise<CodeArtsCredential> {
    if (this.inflight !== undefined) return this.inflight
    this.inflight = (async () => {
      const stored = await this.store.codearts()
      if (stored === undefined) throw new Error('CodeArts 尚未登录。请在设置页点「打开浏览器登录」。')
      if (stored.refreshToken === undefined || stored.codeVerifier === undefined || stored.dpopPrivateJwk === undefined) {
        throw new Error('CodeArts 登录已过期（STS 令牌两小时），请在设置页重新登录。')
      }
      try {
        const next = await exchangeRefreshToken(
          stored.refreshToken,
          stored.codeVerifier,
          keyPairFromStoredJwk(stored.dpopPrivateJwk),
        )
        await this.store.saveCodearts({
          ...stored,
          accessKeyId: next.accessKeyId,
          secretAccessKey: next.secretAccessKey,
          securityToken: next.securityToken,
          ...next.expiresAt === undefined ? {} : { expiresAt: next.expiresAt },
          ...next.refreshToken === undefined ? {} : { refreshToken: next.refreshToken },
          ...next.userName === undefined ? {} : { userName: next.userName },
        })
        this.lastError = undefined
        return next
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.lastError = error instanceof RefreshTokenExpiredError
          ? 'CodeArts 登录已失效（续期令牌过期），请在设置页重新登录。'
          : `CodeArts 续期失败：${message}`
        throw new Error(this.lastError)
      } finally {
        this.inflight = undefined
      }
    })()
    void force
    return this.inflight
  }

  async logout(): Promise<void> {
    await this.store.clear('codearts')
    this.lastError = undefined
  }
}

function credentialOf(record: CodeArtsAccountRecord): CodeArtsCredential {
  return {
    accessKeyId: record.accessKeyId,
    secretAccessKey: record.secretAccessKey,
    securityToken: record.securityToken,
    ...record.expiresAt === undefined ? {} : { expiresAt: record.expiresAt },
    ...record.refreshToken === undefined ? {} : { refreshToken: record.refreshToken },
    ...record.codeVerifier === undefined ? {} : { codeVerifier: record.codeVerifier },
    ...record.dpopPrivateJwk === undefined ? {} : { dpopPrivateJwk: record.dpopPrivateJwk },
  }
}
