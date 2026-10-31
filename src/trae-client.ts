/**
 * The local Trae desktop client's sign-in state.
 *
 * Trae's check-in route insists on the device id its own client registered, so
 * the website login cannot use it. When the client is installed and already
 * signed in, the plugin can reuse that state instead:
 *
 *  - the `Cloud-IDE-JWT` stored under `iCubeAuthInfo://icube.cloudide`;
 *  - the 16-digit device id encoded in the `iCubeAuthInfo://icube-dc:<id>` key;
 *  - `telemetry.machineId`, the value the client sends as `x-machine-id`.
 *
 * The stored value uses the client's own AES-CBC envelope: six magic bytes, a
 * 32-byte key material, then the ciphertext. The AES key and IV are derived
 * from that key material with SHA-512 and a fixed salt, and the plaintext is a
 * SHA-512 digest followed by the JSON document. Nothing here writes to the
 * client, and the token is never returned by the settings API.
 *
 * @module dsh-llm-adapters/trae-client
 */

import { createDecipheriv, createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { TraeRegion } from './brand.ts'
import type { ClientLoginStatus } from './types.ts'

/** What the provider stores after importing a client login. */
export interface TraeClientLoginState {
  region: TraeRegion
  token: string
  deviceId: string
  machineId: string
  userId?: string
  name?: string
  expiresAt?: number
}

/** The settings-facing half (no token) plus the internal state when usable. */
export interface TraeClientDetection {
  status: ClientLoginStatus
  state?: TraeClientLoginState
}

export interface TraeClientReadOptions {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  home?: string
}

const AUTH_PROVIDER_KEY = 'iCubeAuthInfo://icube.cloudide'
const DEVICE_KEY_PREFIX = 'iCubeAuthInfo://icube-dc:'
const MACHINE_KEY = 'telemetry.machineId'
const SERVICE_MACHINE_KEY = 'storage.serviceMachineId'

const AES_MAGIC = Buffer.from([0x74, 0x63, 0x05, 0x10, 0x00, 0x00])
const AES_PRIVATE_MAGIC = Buffer.from([0x12, 0x39, 0x20, 0x20, 0x02, 0x03])
const KEY_OFFSET = 6
const KEY_LENGTH = 32
const HASH_LENGTH = 64
/** Aue ^ Due from the client's byteCrypto module. */
const AES_SALT = Buffer.from(
  '4dd4c2e6b83162090e52b3c7a6733ba41cb2462b829ab58a196b39db57177524'
  + 'f49baf7f08e8d68d26a72e37c1a95a2f1f05a51892aef2949732b62a38aadd58',
  'hex',
)
/** Tue ^ Iue, the AES_PRIVATE variant of the same envelope. */
const AES_PRIVATE_SALT = Buffer.from(
  '490cc21292b05d0cc06ccbe91fb92e21b5a7c538811dc85e27a96e28104e1cf6'
  + '9c7166efab232807390da78a8b91e49c44b49a43feb941a1e46f2656e613e47b',
  'hex',
)
const DEVICE_RE = /^\d{16}$/

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

/** Accept epoch seconds, epoch milliseconds, or an ISO date. */
function epochMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value < 1e12 ? Math.round(value * 1_000) : Math.round(value)
  }
  if (typeof value === 'string') {
    if (/^\d+$/.test(value.trim())) return epochMs(Number(value))
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

function jwtExpiry(token: string): number | undefined {
  const parts = token.split('.')
  if (parts.length < 2) return undefined
  try {
    const base64 = parts[1]!.replace(/-/g, '+').replace(/_/g, '/')
    const padded = base64 + '='.repeat((4 - base64.length % 4) % 4)
    const payload: unknown = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'))
    return epochMs(record(payload)?.exp)
  } catch {
    return undefined
  }
}

/**
 * Open one `iCubeAuthInfo` value.
 *
 * The digest check is the client's own integrity check: the first 64 plaintext
 * bytes are SHA-512 of the document that follows. A malformed or changed
 * envelope is rejected instead of being parsed as garbage.
 */
function decryptAuthValue(value: string): unknown {
  const bytes = Buffer.from(value, 'base64')
  if (bytes.length < KEY_OFFSET + KEY_LENGTH + HASH_LENGTH) {
    throw new Error('数据长度不足')
  }
  const magic = bytes.subarray(0, KEY_OFFSET)
  const salt = magic.equals(AES_MAGIC)
    ? AES_SALT
    : magic.equals(AES_PRIVATE_MAGIC) ? AES_PRIVATE_SALT : undefined
  if (salt === undefined) throw new Error('未知的加密格式')
  const keyMaterial = bytes.subarray(KEY_OFFSET, KEY_OFFSET + KEY_LENGTH)
  const mixed = createHash('sha512').update(keyMaterial).digest()
  const derived = createHash('sha512').update(Buffer.concat([mixed, salt])).digest()
  const decipher = createDecipheriv(
    'aes-128-cbc',
    derived.subarray(0, 16),
    derived.subarray(16, 32),
  )
  const plain = Buffer.concat([
    decipher.update(bytes.subarray(KEY_OFFSET + KEY_LENGTH)),
    decipher.final(),
  ])
  if (plain.length < HASH_LENGTH) throw new Error('解密结果为空')
  const body = plain.subarray(HASH_LENGTH)
  const digest = createHash('sha512').update(body).digest()
  if (!digest.equals(plain.subarray(0, HASH_LENGTH))) throw new Error('校验失败')
  return JSON.parse(body.toString('utf8'))
}

/**
 * The client's data directory, most specific first.
 *
 * `DSH_TRAE_CLIENT_DIR` is a portable/test override; the region-specific
 * variables let one machine keep separate CN and international installs.
 */
export function traeClientDataDirs(
  region: TraeRegion,
  options: TraeClientReadOptions = {},
): string[] {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const home = options.home ?? homedir()
  const name = region === 'cn' ? 'Trae CN' : 'Trae'
  const out: string[] = []
  const add = (directory: string | undefined): void => {
    if (directory !== undefined && directory !== '') out.push(directory)
  }
  add(env[region === 'cn' ? 'DSH_TRAE_CN_CLIENT_DIR' : 'DSH_TRAE_GLOBAL_CLIENT_DIR'])
  add(env['DSH_TRAE_CLIENT_DIR'])
  if (platform === 'win32') {
    const appData = env['APPDATA'] ?? join(home, 'AppData', 'Roaming')
    add(join(appData, name))
  } else if (platform === 'darwin') {
    add(join(home, 'Library', 'Application Support', name))
  } else {
    const config = env['XDG_CONFIG_HOME'] ?? join(home, '.config')
    add(join(config, name))
  }
  return [...new Set(out)]
}

function storageFile(userDataDir: string): string {
  return join(userDataDir, 'User', 'globalStorage', 'storage.json')
}

function authValueOf(storage: Record<string, unknown>): string | undefined {
  const direct = text(storage[AUTH_PROVIDER_KEY])
  if (direct !== undefined) return direct
  for (const key of Object.keys(storage)) {
    if (key.startsWith('iCubeAuthInfo://') && key.endsWith('.cloudide')) {
      const value = text(storage[key])
      if (value !== undefined) return value
    }
  }
  return undefined
}

/** The client has one device id per machine; the last valid key is current. */
function deviceIdOf(storage: Record<string, unknown>): string | undefined {
  const keys = Object.keys(storage).filter(key => key.startsWith(DEVICE_KEY_PREFIX))
  for (let index = keys.length - 1; index >= 0; index--) {
    const value = text(keys[index]!.slice(DEVICE_KEY_PREFIX.length))
    if (value !== undefined && DEVICE_RE.test(value)) return value
  }
  return undefined
}

function regionMismatch(region: TraeRegion, userInfo: Record<string, unknown>): boolean {
  const account = record(userInfo.account)
  const userRegion = record(userInfo.userRegion)
  const evidence = (text(userRegion?.region) ?? text(account?.storeRegion))?.toUpperCase()
  if (evidence === undefined) return false
  return region === 'cn' ? evidence !== 'CN' : evidence === 'CN'
}

/** Parse one `storage.json` document; exported for tests and diagnostics. */
export function parseTraeClientStorage(
  region: TraeRegion,
  storage: Record<string, unknown>,
): TraeClientDetection {
  const encrypted = authValueOf(storage)
  if (encrypted === undefined) {
    return {
      status: {
        available: true,
        signedIn: false,
        error: '本机 Trae 客户端尚未登录。请先在客户端完成登录。',
      },
    }
  }
  let parsed: unknown
  try {
    parsed = decryptAuthValue(encrypted)
  } catch (error) {
    return {
      status: {
        available: true,
        signedIn: false,
        error: `读取本机 Trae 客户端登录态失败：${error instanceof Error ? error.message : String(error)}`,
      },
    }
  }
  const userInfo = record(parsed)
  const token = text(userInfo?.token)
  if (userInfo === undefined || token === undefined) {
    return {
      status: {
        available: true,
        signedIn: false,
        error: '本机 Trae 客户端登录态里没有令牌，请先在客户端重新登录。',
      },
    }
  }
  const account = record(userInfo.account)
  const name = text(account?.username) ?? text(account?.name)
  const userId = text(userInfo.userId)
  const expiresAt = epochMs(userInfo.expiredAt) ?? jwtExpiry(token)
  const identity = {
    ...name === undefined ? {} : { name },
    ...userId === undefined ? {} : { userId },
    ...expiresAt === undefined ? {} : { expiresAt },
  }
  const unavailable = (error: string): TraeClientDetection => ({
    status: { available: true, signedIn: false, ...identity, error },
  })
  if (regionMismatch(region, userInfo)) {
    return unavailable(region === 'cn'
      ? '本机 Trae 客户端登录的是国际版账号，请切换到国际版后再复用。'
      : '本机 Trae 客户端登录的是国内版账号，请切换到国内版后再复用。')
  }
  if (expiresAt !== undefined && expiresAt <= Date.now()) {
    return unavailable('本机 Trae 客户端登录已过期，请先在客户端重新登录。')
  }
  const deviceId = deviceIdOf(storage)
  if (deviceId === undefined) {
    return unavailable('本机 Trae 客户端登录缺少 16 位设备号，请先在客户端重新登录。')
  }
  const machineId = text(storage[MACHINE_KEY]) ?? text(storage[SERVICE_MACHINE_KEY])
  if (machineId === undefined) {
    return unavailable('本机 Trae 客户端登录缺少机器码，请先在客户端重新登录。')
  }
  return {
    status: { available: true, signedIn: true, ...identity },
    state: { region, token, deviceId, machineId, ...identity },
  }
}

/** Read the currently selected region's client state from this machine. */
export function readTraeClientLogin(
  region: TraeRegion,
  options: TraeClientReadOptions = {},
): TraeClientDetection {
  let available = false
  let error: string | undefined
  for (const directory of traeClientDataDirs(region, options)) {
    const file = storageFile(directory)
    if (!existsSync(file)) continue
    available = true
    try {
      const raw = readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
      const storage = record(JSON.parse(raw))
      if (storage === undefined) throw new Error('storage.json 不是对象')
      return parseTraeClientStorage(region, storage)
    } catch (cause) {
      error = `读取本机 Trae 客户端登录态失败：${cause instanceof Error ? cause.message : String(cause)}`
    }
  }
  return {
    status: {
      available,
      signedIn: false,
      ...error === undefined ? {} : { error },
    },
  }
}
