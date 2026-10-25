/**
 * Plugin-owned credentials for account login.
 *
 * Sign-in happens in the provider's own web page through the plugin's QR flow.
 * The resulting session or token is stored here — the only credential source.
 * The file is written atomically and restricted to the current user; tokens are
 * never logged or returned to the browser.
 *
 * @module dsh-llm-adapters/account-store
 */

import { promises as fs } from 'node:fs'
import { randomBytes, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import path from 'node:path'

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

export interface StoredAccounts {
  loomy?: LoomyAccountRecord
  raccoon?: RaccoonAccountRecord
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

export class AccountStore {
  private writeChain: Promise<void> = Promise.resolve()

  constructor(private readonly root: () => string = defaultRoot) {}

  path(): string {
    return path.join(this.root(), FILE_NAME)
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
    return out
  }

  async loomy(): Promise<LoomyAccountRecord | undefined> {
    return (await this.read()).loomy
  }

  async raccoon(): Promise<RaccoonAccountRecord | undefined> {
    return (await this.read()).raccoon
  }

  async saveLoomy(record: LoomyAccountRecord): Promise<void> {
    await this.update(current => ({ ...current, loomy: record }))
  }

  async saveRaccoon(record: RaccoonAccountRecord): Promise<void> {
    await this.update(current => ({ ...current, raccoon: record }))
  }

  async clear(brand: 'loomy' | 'raccoon'): Promise<void> {
    await this.update(current => {
      const next: StoredAccounts = { ...current }
      delete next[brand]
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
