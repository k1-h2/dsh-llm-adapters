/**
 * Credential resolution for both providers.
 *
 * Credentials come from one of two places, in this order:
 *
 * 1. The plugin's own account store, filled by the settings page's account
 *    login. This is the path for users who do not install either desktop app.
 * 2. The desktop application's login file, reused read-only.
 *
 * Raccoon tokens rotate on refresh, so whichever store supplied them is also
 * written back atomically: the desktop app's file for file-sourced tokens, the
 * plugin store for account-sourced ones.
 *
 * Tokens never leave this module in errors, diagnostics, or returned display
 * fields.
 *
 * @module dsh-llm-adapters/auth
 */

import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { attributionHeaders } from '@deepseek-ai/dsh-llm'
import type { AccountSource, AccountStore, LoomyAccountRecord, RaccoonAccountRecord } from './account-store.ts'

export interface LocalAccount {
  name?: string
  phone?: string
  userId?: string
  ownerType?: string
  sessionId?: string
}

export interface AuthStatus {
  signedIn: boolean
  source?: string
  /** `account` = signed in through the settings page; `file` = desktop app reuse. */
  sourceKind?: AccountSource
  fileUpdatedAt?: number
  loginAt?: number
  expiresAt?: number
  refreshExpiresAt?: number
  expiryEstimated?: boolean
  needsRefresh?: boolean
  possiblyExpired?: boolean
  account?: LocalAccount
  error?: string
}

interface SessionFile {
  path?: string
  kind?: AccountSource
  raw?: Record<string, unknown>
  updatedAt?: number
  error?: string
}

const LOOMY_SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1_000
const RACCOON_REFRESH_MARGIN_MS = 2 * 60 * 1_000

/** A path supplied by config or environment, with whitespace tolerated. */
function explicitPath(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed === '' ? undefined : path.resolve(trimmed)
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}

async function readJson(file: string): Promise<Record<string, unknown> | undefined> {
  try {
    const value: unknown = JSON.parse(await fs.readFile(file, 'utf8'))
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}

async function mtime(file: string): Promise<number | undefined> {
  try {
    return (await fs.stat(file)).mtimeMs
  } catch {
    return undefined
  }
}

/**
 * Find the newest Loomy session file.
 *
 * The public profile is where the Windows client stores per-install data
 * (`Public\Loomy\<hash>\userData\auth-session.json`). The other roots cover
 * portable installations and macOS/Linux layouts; missing directories are
 * ordinary, not errors.
 */
async function discoverLoomySession(): Promise<string | undefined> {
  const home = homedir()
  const roots = [
    process.env.PUBLIC === undefined ? undefined : path.join(process.env.PUBLIC, 'Loomy'),
    process.env.LOCALAPPDATA === undefined ? undefined : path.join(process.env.LOCALAPPDATA, 'Loomy'),
    process.env.APPDATA === undefined ? undefined : path.join(process.env.APPDATA, 'Loomy'),
    path.join(home, 'Loomy'),
    path.join(home, 'Library', 'Application Support', 'Loomy'),
    path.join(home, '.config', 'Loomy'),
  ].filter((entry): entry is string => entry !== undefined)

  const found: { file: string, at: number }[] = []
  for (const root of roots) {
    const direct = path.join(root, 'userData', 'auth-session.json')
    if (await exists(direct)) found.push({ file: direct, at: (await mtime(direct)) ?? 0 })
    let entries
    try {
      entries = await fs.readdir(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const file = path.join(root, entry.name, 'userData', 'auth-session.json')
      if (await exists(file)) found.push({ file, at: (await mtime(file)) ?? 0 })
    }
  }
  found.sort((a, b) => b.at - a.at)
  return found[0]?.file
}

function firstString(value: unknown, keys: readonly string[], depth = 0): string | undefined {
  if (value === null || typeof value !== 'object' || depth > 4) return undefined
  const record = value as Record<string, unknown>
  for (const key of keys) {
    const candidate = record[key]
    if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate.trim()
  }
  for (const candidate of Object.values(record)) {
    const nested = firstString(candidate, keys, depth + 1)
    if (nested !== undefined) return nested
  }
  return undefined
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

function firstTimestamp(value: unknown, keys: readonly string[], depth = 0): number | undefined {
  if (value === null || typeof value !== 'object' || depth > 4) return undefined
  const record = value as Record<string, unknown>
  for (const key of keys) {
    const parsed = timestampOf(record[key])
    if (parsed !== undefined) return parsed
  }
  for (const candidate of Object.values(record)) {
    const nested = firstTimestamp(candidate, keys, depth + 1)
    if (nested !== undefined) return nested
  }
  return undefined
}

export class LoomyAuth {
  constructor(
    private readonly configuredPath: () => string,
    private readonly store?: AccountStore,
  ) {}

  private async stored(): Promise<LoomyAccountRecord | undefined> {
    return this.store?.loomy()
  }

  private async load(): Promise<SessionFile> {
    const explicit = explicitPath(this.configuredPath()) ?? explicitPath(process.env.LOOMY_AUTH_FILE)
    const file = explicit ?? await discoverLoomySession()
    if (file === undefined) {
      return { error: '未找到 Loomy 登录态。请在下方用手机号登录，或启动 Loomy 客户端并完成登录；若客户端装在非标准位置，可在高级设置里填写 auth-session.json 的路径。' }
    }
    const raw = await readJson(file)
    if (raw === undefined) return { path: file, kind: 'file', error: `无法读取 Loomy 登录态文件：${file}` }
    if (firstString(raw, ['session', 'sessionId', 'session_token', 'sessionToken', 'accessToken', 'access_token', 'token']) === undefined) {
      return { path: file, kind: 'file', error: 'Loomy 登录态文件里没有 session 字段，请确认已在客户端完成登录。' }
    }
    return { path: file, kind: 'file', raw, updatedAt: await mtime(file) }
  }

  async status(): Promise<AuthStatus> {
    const stored = await this.stored()
    if (stored !== undefined) {
      const account: LocalAccount = {}
      if (stored.name !== undefined) account.name = stored.name
      if (stored.phone !== undefined) account.phone = stored.phone
      if (stored.userId !== undefined) account.userId = stored.userId
      const expired = stored.expiresAt <= Date.now()
      return {
        signedIn: true,
        source: '账号登录',
        sourceKind: 'account',
        loginAt: stored.loginAt,
        expiresAt: stored.expiresAt,
        ...Object.keys(account).length === 0 ? {} : { account },
        ...expired
          ? { possiblyExpired: true, error: 'Loomy 登录已过期，请在下方重新登录。' }
          : {},
      }
    }
    const loaded = await this.load()
    if (loaded.raw === undefined) {
      return {
        signedIn: false,
        ...loaded.path === undefined ? {} : { source: loaded.path },
        ...loaded.kind === undefined ? {} : { sourceKind: loaded.kind },
        ...loaded.error === undefined ? {} : { error: loaded.error },
      }
    }
    const raw = loaded.raw
    const updatedAt = loaded.updatedAt
    const account: LocalAccount = {}
    const name = firstString(raw, ['nickname', 'nickName', 'name', 'userName'])
    const phone = firstString(raw, ['phone', 'mobile', 'loginid', 'loginId'])
    const userId = firstString(raw, ['userid', 'userId', 'uid'])
    if (name !== undefined) account.name = name
    if (phone !== undefined) account.phone = phone
    if (userId !== undefined) account.userId = userId
    const declaredExpiry = firstTimestamp(raw, ['expiresAt', 'expireAt', 'expire_time', 'expireTime', 'expiry'])
    const expiresAt = declaredExpiry ?? (updatedAt === undefined ? undefined : updatedAt + LOOMY_SESSION_TTL_MS)
    return {
      signedIn: true,
      source: loaded.path,
      sourceKind: 'file',
      ...updatedAt === undefined ? {} : { fileUpdatedAt: updatedAt },
      ...expiresAt === undefined ? {} : { expiresAt },
      ...declaredExpiry === undefined ? { expiryEstimated: true } : {},
      ...expiresAt !== undefined && expiresAt <= Date.now() ? { possiblyExpired: true } : {},
      ...Object.keys(account).length === 0 ? {} : { account },
    }
  }

  /**
   * The bearer session, or undefined with the reason in status().
   *
   * A stored account session wins over the desktop file: the user chose the
   * login the settings page can refresh and sign out of.
   */
  async session(): Promise<string | undefined> {
    const stored = await this.stored()
    if (stored !== undefined) return stored.session
    const loaded = await this.load()
    if (loaded.raw === undefined) return undefined
    return firstString(loaded.raw, ['session', 'sessionId', 'session_token', 'sessionToken', 'accessToken', 'access_token', 'token'])
  }

  /** Sign out of the plugin's own account; the desktop app is untouched. */
  async logout(): Promise<void> {
    await this.store?.clear('loomy')
  }
}

export interface JwtFacts {
  expiresAt?: number
  name?: string
  phone?: string
  ownerType?: string
  sessionId?: string
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

interface RaccoonTokens {
  access?: string
  refresh?: string
  raw?: Record<string, unknown>
}

const RACCOON_REFRESH_URL = 'https://xiaohuanxiong.com/api/web/auth/v1/refresh'

export class RaccoonAuth {
  private refreshing: Promise<string> | undefined

  constructor(
    private readonly configuredPath: () => string,
    private readonly store?: AccountStore,
  ) {}

  path(): string {
    const explicit = explicitPath(this.configuredPath()) ?? explicitPath(process.env.RACCOON_AUTH_FILE)
    if (explicit !== undefined) return explicit
    const dir = explicitPath(process.env.BOX_AGENT_CONFIG_DIR)
    return dir === undefined
      ? path.join(homedir(), '.box-agent', 'config', 'auth.json')
      : path.join(dir, 'auth.json')
  }

  private async load(): Promise<SessionFile> {
    const stored = await this.store?.raccoon()
    if (stored !== undefined) {
      return {
        kind: 'account',
        raw: {
          access_token: stored.accessToken,
          ...stored.refreshToken === undefined ? {} : { refresh_token: stored.refreshToken },
          ...stored.name === undefined ? {} : { name: stored.name },
          ...stored.phone === undefined ? {} : { phone: stored.phone },
          ...stored.ownerType === undefined ? {} : { owner_type: stored.ownerType },
        },
        updatedAt: stored.loginAt,
      }
    }
    const file = this.path()
    if (!(await exists(file))) {
      return { path: file, kind: 'file', error: '未登录小浣熊。请用浏览器登录，或启动小浣熊桌面端完成登录。' }
    }
    const raw = await readJson(file)
    if (raw === undefined) return { path: file, kind: 'file', error: `无法读取小浣熊登录态文件：${file}` }
    return { path: file, kind: 'file', raw, updatedAt: await mtime(file) }
  }

  private tokens(raw: Record<string, unknown>): RaccoonTokens {
    const string = (...keys: string[]): string | undefined => {
      for (const key of keys) {
        const value = raw[key]
        if (typeof value === 'string' && value.trim().length > 0) return value.trim()
      }
      return undefined
    }
    return {
      access: string('access_token', 'accessToken', 'token', 'auth_token'),
      refresh: string('refresh_token', 'refreshToken'),
      raw,
    }
  }

  async status(): Promise<AuthStatus> {
    const loaded = await this.load()
    if (loaded.raw === undefined) {
      return {
        signedIn: false,
        source: loaded.path,
        sourceKind: loaded.kind,
        ...loaded.error === undefined ? {} : { error: loaded.error },
      }
    }
    const token = this.tokens(loaded.raw)
    const accessFacts = token.access === undefined ? {} : decodeJwtFacts(token.access)
    const refreshFacts = token.refresh === undefined ? {} : decodeJwtFacts(token.refresh)
    const now = Date.now()
    const accessValid = accessFacts.expiresAt !== undefined && accessFacts.expiresAt > now + 30_000
    const refreshValid = refreshFacts.expiresAt !== undefined && refreshFacts.expiresAt > now + 30_000
    // A browser-login token is opaque to us (no JWT claims) but the gateway
    // already accepted it when the flow stored it, so it counts as signed in.
    const opaqueAccess = token.access !== undefined && accessFacts.expiresAt === undefined
    const signedIn = opaqueAccess && loaded.kind === 'account'
      ? true
      : accessValid || refreshValid
    const account: LocalAccount = {}
    if (accessFacts.name !== undefined) account.name = accessFacts.name
    if (accessFacts.phone !== undefined) account.phone = accessFacts.phone
    if (accessFacts.ownerType !== undefined) account.ownerType = accessFacts.ownerType
    if (accessFacts.sessionId !== undefined) account.sessionId = accessFacts.sessionId
    const needsRefresh = signedIn && !opaqueAccess
      && (!accessValid || (accessFacts.expiresAt ?? 0) <= now + RACCOON_REFRESH_MARGIN_MS)
    const sourceKind = loaded.kind ?? 'file'
    return {
      signedIn,
      source: sourceKind === 'account' ? '账号登录' : loaded.path,
      sourceKind,
      ...loaded.updatedAt === undefined ? {} : { fileUpdatedAt: loaded.updatedAt },
      ...sourceKind === 'account' && loaded.updatedAt !== undefined ? { loginAt: loaded.updatedAt } : {},
      ...accessFacts.expiresAt === undefined ? {} : { expiresAt: accessFacts.expiresAt },
      ...refreshFacts.expiresAt === undefined ? {} : { refreshExpiresAt: refreshFacts.expiresAt },
      ...signedIn ? { needsRefresh } : {},
      ...!signedIn ? { possiblyExpired: true } : {},
      ...Object.keys(account).length === 0 ? {} : { account },
      ...signedIn
        ? {}
        : {
            error: sourceKind === 'account'
              ? '小浣熊登录已过期，请重新用浏览器登录。'
              : '小浣熊登录态已过期。请打开小浣熊桌面端重新登录。',
          },
    }
  }

  /**
   * A usable access token.
   *
   * `force` is for a 401: the token looked valid locally but the gateway
   * rejected it. A concurrent refresh is shared so two in-flight calls cannot
   * rotate the same single-use refresh token twice.
   */
  async accessToken(force = false): Promise<string> {
    const loaded = await this.load()
    if (loaded.raw === undefined) throw new Error(loaded.error ?? '小浣熊尚未登录。')
    const token = this.tokens(loaded.raw)
    const facts = token.access === undefined ? {} : decodeJwtFacts(token.access)
    const opaque = token.access !== undefined && facts.expiresAt === undefined
    const healthy = token.access !== undefined && (
      opaque && loaded.kind === 'account'
        ? true
        : facts.expiresAt !== undefined && facts.expiresAt > Date.now() + RACCOON_REFRESH_MARGIN_MS
    )
    if (healthy && !force) return token.access!

    if (this.refreshing !== undefined) return this.refreshing
    this.refreshing = this.refresh(token.refresh, loaded).finally(() => { this.refreshing = undefined })
    return this.refreshing
  }

  /** Sign out of the plugin's own account; the desktop app is untouched. */
  async logout(): Promise<void> {
    await this.store?.clear('raccoon')
  }

  private async refresh(refresh: string | undefined, loaded: SessionFile): Promise<string> {
    if (refresh === undefined) throw new Error('小浣熊登录态缺少 refresh_token，请重新登录。')
    const response = await fetch(RACCOON_REFRESH_URL, {
      method: 'POST',
      headers: { ...attributionHeaders(), 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ refresh_token: refresh }),
      signal: AbortSignal.timeout(20_000),
    })
    const text = await response.text()
    let payload: Record<string, unknown> | undefined
    try {
      const parsed: unknown = JSON.parse(text)
      if (parsed !== null && typeof parsed === 'object') payload = parsed as Record<string, unknown>
    } catch {
      /* handled below */
    }
    const data = payload?.data !== null && typeof payload?.data === 'object'
      ? payload.data as Record<string, unknown>
      : undefined
    const access = typeof data?.access_token === 'string' ? data.access_token : undefined
    const nextRefresh = typeof data?.refresh_token === 'string' ? data.refresh_token : undefined

    if (response.ok && payload?.code === 0 && access !== undefined) {
      await this.persist(loaded, access, nextRefresh)
      return access
    }

    // Reused or conflicting refresh token: the desktop app (or another DSH
    // process) may have refreshed already. Adopt that result, never retry the
    // same token.
    if (payload?.code === 200822 || payload?.message === 'refresh_conflict') {
      const reread = await this.load()
      if (reread.raw !== undefined) {
        const current = this.tokens(reread.raw)
        const facts = current.access === undefined ? {} : decodeJwtFacts(current.access)
        if (current.access !== undefined && (facts.expiresAt ?? 0) > Date.now() + 30_000) return current.access
      }
      throw new Error(loaded.kind === 'account'
        ? '小浣熊刷新令牌已被其他客户端使用，请重新登录。'
        : '小浣熊刷新令牌已被其他窗口使用，且本机登录态仍未更新。请打开小浣熊桌面端重新登录。')
    }
    const message = typeof payload?.message === 'string' && payload.message.length > 0
      ? payload.message
      : `HTTP ${response.status}`
    throw new Error(`小浣熊登录态刷新失败：${message}`)
  }

  private async persist(loaded: SessionFile, access: string, refresh: string | undefined): Promise<void> {
    if (loaded.kind === 'account') {
      const current = await this.store?.raccoon()
      if (current === undefined) throw new Error('小浣熊账号凭据已丢失，请重新登录。')
      const next: RaccoonAccountRecord = {
        ...current,
        accessToken: access,
        ...refresh === undefined ? {} : { refreshToken: refresh },
      }
      await this.store?.saveRaccoon(next)
      return
    }
    await this.writeBack(loaded.path!, access, refresh)
  }

  /** Preserve every field the desktop app keeps in the file, replacing only tokens. */
  private async writeBack(file: string, access: string, refresh: string | undefined): Promise<void> {
    const current = (await readJson(file)) ?? {}
    const next: Record<string, unknown> = { ...current, access_token: access }
    if (refresh !== undefined) next.refresh_token = refresh
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`
    await fs.writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await fs.rename(temp, file)
  }
}
