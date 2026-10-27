/**
 * Plugin-owned credentials for account login.
 *
 * Sign-in happens in the provider's own web page. The resulting session or
 * token is stored here — the only credential source. The file is written
 * atomically and restricted to the current user; tokens are never logged or
 * returned to the browser.
 *
 * Trae keeps one account per region: switching regions must restore that
 * region's own login instead of overwriting the other one.
 *
 * @module dsh-llm-adapters/account-store
 */

import { promises as fs } from 'node:fs'
import { randomBytes, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import path from 'node:path'
import type { BrandId, TraeRegion } from './brand.ts'
import { normalizeTraeRegion } from './brand.ts'

export interface LoomyAccountRecord {
  session: string
  userId?: string
  phone?: string
  name?: string
  /** Stable per-user device id sent to the account service. */
  deviceId: string
  loginAt: number
  expiresAt: number
}

export interface RaccoonAccountRecord {
  accessToken: string
  phone?: string
  name?: string
  ownerType?: string
  loginAt: number
}

/**
 * One Trae web login.
 *
 * `accessToken` is the `Cloud-IDE-JWT` the website itself uses. `deviceId` and
 * `machineId` are the fingerprints captured from that web session — this
 * plugin never reads a desktop install — and are replayed on chat, quota and
 * check-in requests.
 */
export interface TraeAccountRecord {
  accessToken: string
  region: TraeRegion
  deviceId: string
  machineId: string
  userId?: string
  name?: string
  loginAt: number
  /** The `Cloud-IDE-JWT` expiry (about 8 hours); absent when the JWT carries none. */
  expiresAt?: number
  /**
   * Cookies captured from the sign-in browser.
   *
   * `GetUserToken` accepts these instead of a password, so the short-lived JWT
   * can be renewed silently until the web session itself expires.
   */
  cookies?: string
  /** The website session's expiry, read from the login response (about 14 days). */
  sessionExpiresAt?: number
}

/**
 * One CodeArts sign-in.
 *
 * The gateway takes no bearer token: every request is signed with the AK/SK
 * pair plus the STS security token. `refreshToken`, `codeVerifier` and the DPoP
 * private key are kept because a refresh has to reuse the same PKCE verifier and
 * the same key — a fresh pair is rejected.
 */
export interface CodeArtsAccountRecord {
  accessKeyId: string
  secretAccessKey: string
  securityToken: string
  /** Epoch ms; the STS token lasts two hours. */
  expiresAt?: number
  refreshToken?: string
  codeVerifier?: string
  dpopPrivateJwk?: {
    kty: 'EC'
    crv: 'P-256'
    x: string
    y: string
    d: string
  }
  userName?: string
  /**
   * Models the account answered `InferHub.4004.200` for.
   *
   * The verdict is worth persisting: asking with `maas_type: benefit` spends
   * one of the three chat slots the plan allows per minute, even though the
   * call cannot succeed.
   */
  noBenefit?: string[]
  loginAt: number
}

export interface StoredAccounts {
  loomy?: LoomyAccountRecord
  raccoon?: RaccoonAccountRecord
  trae?: Partial<Record<TraeRegion, TraeAccountRecord>>
  codearts?: CodeArtsAccountRecord
}

const FILE_NAME = 'accounts.json'

function defaultRoot(): string {
  const configured = process.env.DSH_LLM_ADAPTERS_HOME?.trim()
  if (configured !== undefined && configured !== '') return path.resolve(configured)
  const dshHome = process.env.DSH_HOME?.trim()
  const base = dshHome !== undefined && dshHome !== '' ? dshHome : path.join(homedir(), '.dsh')
  return path.join(base, 'llm-adapters')
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

function traeRecord(value: unknown, region: TraeRegion): TraeAccountRecord | undefined {
  const raw = record(value)
  const accessToken = text(raw?.accessToken)
  if (raw === undefined || accessToken === undefined) return undefined
  const deviceId = text(raw.deviceId)
  return {
    accessToken,
    region,
    deviceId: deviceId ?? `web-${randomBytes(8).toString('hex')}`,
    machineId: text(raw.machineId) ?? `web-${randomBytes(16).toString('hex')}`,
    loginAt: number(raw.loginAt) ?? Date.now(),
    ...text(raw.userId) === undefined ? {} : { userId: text(raw.userId)! },
    ...text(raw.name) === undefined ? {} : { name: text(raw.name)! },
    ...number(raw.expiresAt) === undefined ? {} : { expiresAt: number(raw.expiresAt)! },
    ...text(raw.cookies) === undefined ? {} : { cookies: text(raw.cookies)! },
    ...number(raw.sessionExpiresAt) === undefined ? {} : { sessionExpiresAt: number(raw.sessionExpiresAt)! },
  }
}

function codeartsRecord(value: unknown): CodeArtsAccountRecord | undefined {
  const raw = record(value)
  const accessKeyId = text(raw?.accessKeyId)
  const secretAccessKey = text(raw?.secretAccessKey)
  const securityToken = text(raw?.securityToken)
  if (raw === undefined || accessKeyId === undefined || secretAccessKey === undefined || securityToken === undefined) {
    return undefined
  }
  const jwk = record(raw.dpopPrivateJwk)
  const key = jwk !== undefined && text(jwk.x) !== undefined && text(jwk.y) !== undefined && text(jwk.d) !== undefined
    ? { kty: 'EC' as const, crv: 'P-256' as const, x: text(jwk.x)!, y: text(jwk.y)!, d: text(jwk.d)! }
    : undefined
  const noBenefit = Array.isArray(raw.noBenefit)
    ? raw.noBenefit.filter((id): id is string => typeof id === 'string' && id.trim().length > 0).map(id => id.trim())
    : []
  return {
    accessKeyId,
    secretAccessKey,
    securityToken,
    loginAt: number(raw.loginAt) ?? Date.now(),
    ...number(raw.expiresAt) === undefined ? {} : { expiresAt: number(raw.expiresAt)! },
    ...text(raw.refreshToken) === undefined ? {} : { refreshToken: text(raw.refreshToken)! },
    ...text(raw.codeVerifier) === undefined ? {} : { codeVerifier: text(raw.codeVerifier)! },
    ...key === undefined ? {} : { dpopPrivateJwk: key },
    ...text(raw.userName) === undefined ? {} : { userName: text(raw.userName)! },
    ...noBenefit.length === 0 ? {} : { noBenefit },
  }
}

export class AccountStore {
  private writeChain: Promise<void> = Promise.resolve()

  constructor(private readonly root: () => string = defaultRoot) {}

  path(): string {
    return path.join(this.root(), FILE_NAME)
  }

  /** The plugin's own data directory (also holds the OpenRouter snapshot). */
  directory(): string {
    return this.root()
  }

  async read(): Promise<StoredAccounts> {
    let parsed: unknown
    try {
      parsed = JSON.parse(await fs.readFile(this.path(), 'utf8'))
    } catch {
      return {}
    }
    const raw = record(parsed)
    if (raw === undefined) return {}
    const out: StoredAccounts = {}
    const loomy = record(raw.loomy)
    const loomySession = text(loomy?.session)
    if (loomySession !== undefined) {
      out.loomy = {
        session: loomySession,
        deviceId: text(loomy?.deviceId) ?? `web-${randomBytes(8).toString('hex')}`,
        loginAt: number(loomy?.loginAt) ?? Date.now(),
        expiresAt: number(loomy?.expiresAt) ?? Date.now(),
        ...text(loomy?.userId) === undefined ? {} : { userId: text(loomy?.userId)! },
        ...text(loomy?.phone) === undefined ? {} : { phone: text(loomy?.phone)! },
        ...text(loomy?.name) === undefined ? {} : { name: text(loomy?.name)! },
      }
    }
    const raccoon = record(raw.raccoon)
    const access = text(raccoon?.accessToken)
    if (access !== undefined) {
      out.raccoon = {
        accessToken: access,
        loginAt: number(raccoon?.loginAt) ?? Date.now(),
        ...text(raccoon?.phone) === undefined ? {} : { phone: text(raccoon?.phone)! },
        ...text(raccoon?.name) === undefined ? {} : { name: text(raccoon?.name)! },
        ...text(raccoon?.ownerType) === undefined ? {} : { ownerType: text(raccoon?.ownerType)! },
      }
    }
    const trae = record(raw.trae)
    if (trae !== undefined) {
      const cn = traeRecord(trae.cn, 'cn')
      const global = traeRecord(trae.global, 'global')
      if (cn !== undefined || global !== undefined) {
        out.trae = {
          ...cn === undefined ? {} : { cn },
          ...global === undefined ? {} : { global },
        }
      }
    }
    const codearts = codeartsRecord(raw.codearts)
    if (codearts !== undefined) out.codearts = codearts
    return out
  }

  async loomy(): Promise<LoomyAccountRecord | undefined> {
    return (await this.read()).loomy
  }

  async raccoon(): Promise<RaccoonAccountRecord | undefined> {
    return (await this.read()).raccoon
  }

  async trae(region: TraeRegion): Promise<TraeAccountRecord | undefined> {
    return (await this.read()).trae?.[normalizeTraeRegion(region)]
  }

  async codearts(): Promise<CodeArtsAccountRecord | undefined> {
    return (await this.read()).codearts
  }

  async saveLoomy(record: LoomyAccountRecord): Promise<void> {
    await this.update(current => ({ ...current, loomy: record }))
  }

  async saveRaccoon(record: RaccoonAccountRecord): Promise<void> {
    await this.update(current => ({ ...current, raccoon: record }))
  }

  async saveTrae(record: TraeAccountRecord): Promise<void> {
    const region = normalizeTraeRegion(record.region)
    await this.update(current => ({
      ...current,
      trae: { ...(current.trae ?? {}), [region]: { ...record, region } },
    }))
  }

  async saveCodearts(record: CodeArtsAccountRecord): Promise<void> {
    await this.update(current => ({ ...current, codearts: record }))
  }

  async clear(brand: BrandId, region?: TraeRegion): Promise<void> {
    await this.update(current => {
      const next: StoredAccounts = { ...current }
      if (brand === 'trae') {
        if (region === undefined) {
          delete next.trae
          return next
        }
        const accounts = { ...(next.trae ?? {}) }
        delete accounts[normalizeTraeRegion(region)]
        if (Object.keys(accounts).length === 0) delete next.trae
        else next.trae = accounts
        return next
      }
      if (brand === 'loomy') delete next.loomy
      else if (brand === 'raccoon') delete next.raccoon
      else delete next.codearts
      return next
    })
  }

  /**
   * A device id for the Loomy account service.
   *
   * Generated once and reused, so an account keeps looking like one device
   * across logins; `traceid` remains per-request.
   */
  async loomyDeviceId(): Promise<string> {
    const existing = (await this.loomy())?.deviceId
    return existing ?? `web-${randomUUID().replace(/-/g, '').slice(0, 16)}`
  }

  /**
   * Read-modify-write inside the write queue.
   *
   * The read has to happen there too: a token refresh and a login landing at
   * the same time would otherwise both read the same old file and the second
   * write would drop the first one's brand.
   */
  private async update(mutator: (current: StoredAccounts) => StoredAccounts): Promise<void> {
    this.writeChain = this.writeChain.then(async () => {
      const current = await this.read()
      await this.writeFile(mutator(current))
    }, () => undefined)
    await this.writeChain
  }

  private async writeFile(next: StoredAccounts): Promise<void> {
    const file = this.path()
    const body = `${JSON.stringify(next, null, 2)}\n`
    await fs.mkdir(path.dirname(file), { recursive: true })
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`
    await fs.writeFile(temp, body, { encoding: 'utf8', mode: 0o600 })
    await fs.rename(temp, file)
  }
}
