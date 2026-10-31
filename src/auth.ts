/**
 * Credential state for every provider.
 *
 * Sign-in happens in the provider's own web page. Trae additionally offers an
 * explicit, read-only import of the local desktop client's login state; nothing
 * is ever written back to that client. Either way credentials end up in exactly
 * one place, the plugin's own account store, and no token leaves this module in
 * errors or display fields.
 *
 * @module dsh-llm-adapters/auth
 */

import type {
  AccountStore, CodeArtsAccountRecord, LoomyAccountRecord, RaccoonAccountRecord, TraeAccountRecord,
} from './account-store.ts'
import type { TraeRegion } from './brand.ts'
import { RefreshTokenExpiredError, exchangeRefreshToken, keyPairFromStoredJwk, readUserProfile } from './codearts-oauth.ts'
import type { CodeArtsCredential } from './codearts-oauth.ts'
import { responseError } from './http.ts'
import { TRAE_REGION_PROFILES, TRAE_WEB_USER_AGENT } from './trae-endpoints.ts'

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
  /** Trae only: where the token came from. */
  loginSource?: 'web' | 'client'
}

/** Expiry margin for Raccoon's JWT, so a call does not start on a dead token. */
const RACCOON_EXPIRY_MARGIN_MS = 30_000
/** Renew Trae's token well before its eight-hour expiry. */
const TRAE_EXPIRY_MARGIN_MS = 5 * 60_000

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
 * The two expiries a Trae record can carry.
 *
 * Older records stored the website-session expiry in `expiresAt` because the
 * short JWT was not known separately. The JWT's own `exp` is authoritative, so
 * read it from the token and treat a much longer stored value as the session.
 */
function traeExpiries(stored: TraeAccountRecord): { token?: number, session?: number } {
  const jwt = decodeJwtFacts(stored.accessToken).expiresAt
  const token = jwt ?? stored.expiresAt
  const session = stored.sessionExpiresAt
    ?? (jwt !== undefined && stored.expiresAt !== undefined && stored.expiresAt > jwt + 60_000
      ? stored.expiresAt
      : undefined)
  return {
    ...token === undefined ? {} : { token },
    ...session === undefined ? {} : { session },
  }
}

/** The token document `GetUserToken` returns, tolerating the nested envelope. */
function traeTokenOf(payload: unknown): string | undefined {
  if (payload === null || typeof payload !== 'object') return undefined
  const result = (payload as Record<string, unknown>).Result
  if (result === null || typeof result !== 'object') return undefined
  const token = (result as Record<string, unknown>).Token
  return typeof token === 'string' && token.trim().length > 0 ? token.trim() : undefined
}

function traeSessionExpiryOf(payload: unknown): number | undefined {
  if (payload === null || typeof payload !== 'object') return undefined
  const result = (payload as Record<string, unknown>).Result
  if (result === null || typeof result !== 'object') return undefined
  return timestampOf((result as Record<string, unknown>).ExpiredAt)
}

/** Merge `Set-Cookie` lines into the stored jar, so a rotated session survives. */
function mergeSetCookies(current: string, headers: readonly string[]): string {
  const jar = new Map<string, string>()
  for (const part of current.split(';')) {
    const index = part.indexOf('=')
    if (index <= 0) continue
    const name = part.slice(0, index).trim()
    if (name !== '') jar.set(name, part.slice(index + 1).trim())
  }
  for (const header of headers) {
    const first = header.split(';', 1)[0] ?? ''
    const index = first.indexOf('=')
    if (index <= 0) continue
    const name = first.slice(0, index).trim()
    if (name === '') continue
    if (/(?:^|;)\s*max-age=0\b/i.test(header)) {
      jar.delete(name)
      continue
    }
    jar.set(name, first.slice(index + 1).trim())
  }
  return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ')
}

/**
 * Trae's login, one per region.
 *
 * A web login stores the `Cloud-IDE-JWT` from the website plus the cookies
 * behind it, so the short token can be renewed silently until the website
 * session dies. A client login stores the token the desktop client already
 * uses; that token has no website session, and the client itself refreshes it.
 * Only the client source carries the device id the check-in route accepts.
 */
export class TraeAuth {
  private readonly inflight = new Map<TraeRegion, Promise<string>>()
  private lastError: string | undefined

  constructor(
    private readonly store: AccountStore,
    private readonly currentRegion: () => TraeRegion,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  region(): TraeRegion {
    return this.currentRegion()
  }

  async status(): Promise<AuthStatus> {
    const region = this.region()
    const stored = await this.store.trae(region)
    if (stored === undefined) {
      return {
        signedIn: false,
        error: `${traeLabel(region)}尚未登录。可以点「打开浏览器登录」，或复用本机已登录的 Trae 客户端。`,
      }
    }
    const source = stored.source ?? 'web'
    const now = Date.now()
    const { token, session } = traeExpiries(stored)
    const tokenExpired = token !== undefined && token <= now + TRAE_EXPIRY_MARGIN_MS
    const account = traeAccount(stored)
    if (source === 'client') {
      // The client owns the refresh loop; when its token dies the user signs in
      // there again and imports the new state.
      const signedIn = !tokenExpired
      return {
        signedIn,
        loginSource: 'client',
        loginAt: stored.loginAt,
        ...token === undefined ? {} : { expiresAt: token },
        ...!signedIn ? { possiblyExpired: true } : {},
        ...Object.keys(account).length === 0 ? {} : { account },
        ...!signedIn
          ? { error: `${traeLabel(region)}客户端登录令牌已过期，请先在 Trae 客户端重新登录，再点「复用客户端登录态」。` }
          : {},
      }
    }
    const sessionExpired = session !== undefined && session <= now + TRAE_EXPIRY_MARGIN_MS
    const refreshable = stored.cookies !== undefined && !sessionExpired
    const signedIn = !tokenExpired || refreshable
    // With a renewable session the user cares about the website-session
    // deadline, not the eight-hour JWT the plugin replaces on its own.
    const expiresAt = refreshable ? session ?? token : token
    return {
      signedIn,
      loginSource: 'web',
      loginAt: stored.loginAt,
      ...expiresAt === undefined ? {} : { expiresAt },
      ...!signedIn ? { possiblyExpired: true } : {},
      ...Object.keys(account).length === 0 ? {} : { account },
      ...!signedIn
        ? { error: sessionExpired
          ? `${traeLabel(region)}网页会话已过期，请重新登录。`
          : `${traeLabel(region)}登录已过期，请在设置页重新登录。` }
        : tokenExpired && this.lastError !== undefined ? { error: this.lastError } : {},
    }
  }

  /**
   * The bearer token, or an actionable error when there is none.
   *
   * A web token near its expiry is renewed first; `force` means the gateway
   * already rejected it, so the renewal is attempted even if the clock
   * disagrees. A client token is returned until its own expiry and then asks
   * for a fresh import, because only the client can refresh it.
   */
  async accessToken(force = false): Promise<string> {
    const region = this.region()
    const stored = await this.store.trae(region)
    if (stored === undefined) {
      throw new Error(`${traeLabel(region)}尚未登录。可以点「打开浏览器登录」，或复用本机已登录的 Trae 客户端。`)
    }
    const { token, session } = traeExpiries(stored)
    const expired = token !== undefined && token <= Date.now() + TRAE_EXPIRY_MARGIN_MS
    if (stored.source === 'client') {
      if (!force && !expired) return stored.accessToken
      throw new Error(`${traeLabel(region)}客户端登录令牌已${force ? '失效' : '过期'}，请先在 Trae 客户端重新登录，再点「复用客户端登录态」。`)
    }
    if (!force && !expired) return stored.accessToken
    if (stored.cookies === undefined) {
      throw new Error(`${traeLabel(region)}登录已${force ? '失效' : '过期'}，请在设置页重新登录。`)
    }
    if (session !== undefined && session <= Date.now() + TRAE_EXPIRY_MARGIN_MS) {
      throw new Error(`${traeLabel(region)}网页会话已过期，请重新登录。`)
    }
    return this.refresh(region)
  }

  /** Renew the eight-hour JWT with the stored website cookies. */
  private async refresh(region: TraeRegion): Promise<string> {
    const existing = this.inflight.get(region)
    if (existing !== undefined) return existing
    const task = (async () => {
      const stored = await this.store.trae(region)
      if (stored === undefined || stored.source === 'client' || stored.cookies === undefined) {
        throw new Error(`${traeLabel(region)}登录已失效，请在设置页重新登录。`)
      }
      const profile = TRAE_REGION_PROFILES[region]
      let response: Response
      try {
        response = await this.fetchImpl(`${profile.apiBase}/cloudide/api/v3/common/GetUserToken`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
            cookie: stored.cookies,
            origin: profile.webOrigin,
            referer: `${profile.webOrigin}/`,
            'user-agent': TRAE_WEB_USER_AGENT,
          },
          body: '{}',
          signal: AbortSignal.timeout(15_000),
        })
      } catch (error) {
        const message = `Trae 令牌续期失败：${error instanceof Error ? error.message : String(error)}`
        this.lastError = message
        throw new Error(message)
      }
      if (!response.ok) {
        const message = response.status === 401 || response.status === 403
          ? `${traeLabel(region)}网页会话已失效，请重新登录。`
          : `Trae 令牌续期失败：${await responseError(response)}`
        this.lastError = message
        throw new Error(message)
      }
      const payload: unknown = await response.json().catch(() => undefined)
      const token = traeTokenOf(payload)
      if (token === undefined) {
        const message = 'Trae 令牌续期失败：响应里没有令牌。'
        this.lastError = message
        throw new Error(message)
      }
      const sessionExpiresAt = traeSessionExpiryOf(payload) ?? stored.sessionExpiresAt
      const expiresAt = decodeJwtFacts(token).expiresAt ?? sessionExpiresAt
      const headers = response.headers as Headers & { getSetCookie?: () => string[] }
      const setCookies = headers.getSetCookie?.() ?? []
      const cookies = setCookies.length === 0 ? stored.cookies : mergeSetCookies(stored.cookies, setCookies)
      await this.store.saveTrae({
        ...stored,
        accessToken: token,
        cookies,
        ...expiresAt === undefined ? {} : { expiresAt },
        ...sessionExpiresAt === undefined ? {} : { sessionExpiresAt },
      })
      this.lastError = undefined
      return token
    })()
    this.inflight.set(region, task)
    try {
      return await task
    } finally {
      this.inflight.delete(region)
    }
  }

  /** The fingerprints captured from the web session, replayed on every call. */
  async identity(): Promise<{ deviceId: string, machineId: string, userId?: string }> {
    const region = this.region()
    const stored = await this.store.trae(region)
    if (stored === undefined) {
      throw new Error(`${traeLabel(region)}尚未登录。可以点「打开浏览器登录」，或复用本机已登录的 Trae 客户端。`)
    }
    return {
      deviceId: stored.deviceId,
      machineId: stored.machineId,
      ...stored.userId === undefined ? {} : { userId: stored.userId },
    }
  }

  async logout(): Promise<void> {
    const region = this.region()
    const running = this.inflight.get(region)
    if (running !== undefined) {
      // Let a renewal finish before deleting the record, or it would write the
      // account back after the sign-out.
      await running.catch(() => undefined)
    }
    this.inflight.delete(region)
    this.lastError = undefined
    await this.store.clear('trae', region)
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
