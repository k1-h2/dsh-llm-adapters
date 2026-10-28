/**
 * Trae sign-in through the provider's own website.
 *
 * The plugin does not read a desktop install: it opens a dedicated browser
 * profile, lets the user sign in on trae.cn / trae.ai, and then takes the
 * session the website itself created. Two things come out of that session:
 *
 *  - the `Cloud-IDE-JWT` token, fetched with the page's own cookies through
 *    `/cloudide/api/v3/common/GetUserToken` — the same call the site makes;
 *  - the device fingerprint (`__msuuid__` from the page, or one generated in
 *    the page), which Trae's check-in route requires and which therefore must
 *    belong to this web session rather than to a machine install.
 *
 * Cookies are captured over the DevTools protocol and kept in the plugin's own
 * account store so the short-lived JWT can be renewed later; the dedicated
 * browser profile stays on disk and is reused for subsequent sign-ins.
 *
 * @module dsh-llm-adapters/trae-login
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TraeRegion } from './brand.ts'
import type { LoginPhase, LoginStatus } from './login-page.ts'
import type { TraeRegionProfile } from './trae-endpoints.ts'
import { TRAE_REGION_PROFILES, TRAE_WEB_USER_AGENT } from './trae-endpoints.ts'

export interface TraeLoginAccount {
  accessToken: string
  deviceId: string
  machineId: string
  userId?: string
  name?: string
  /** The JWT expiry, not the longer website-session expiry. */
  expiresAt?: number
  cookies?: string
  sessionExpiresAt?: number
}

export interface TraeWebLoginOptions {
  region: TraeRegion
  /** Keep this profile across sign-ins so the device looks stable to Trae. */
  profileDir?: string
  save(account: TraeLoginAccount): Promise<void>
  timeoutMs?: number
  logger?: (message: string) => void
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1_000
const POLL_INTERVAL_MS = 2_000
const WAITING_MESSAGE = '请在浏览器中完成登录，成功后窗口会自动关闭。'
const DEVICE_EXPRESSION = `(() => {
  try { const value = localStorage.getItem('__msuuid__'); if (value) return value } catch (error) {}
  try { const value = localStorage.getItem('msid'); if (value) return value } catch (error) {}
  try { return crypto.randomUUID() } catch (error) { return '' }
})()`

interface CdpTarget {
  id?: string
  type: string
  url: string
  webSocketDebuggerUrl?: string
}

interface WebSocketLike {
  onopen: (() => void) | null
  onclose: (() => void) | null
  onerror: ((event: unknown) => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  send(data: string): void
  close(): void
}

type WebSocketConstructor = new (url: string) => WebSocketLike

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

/** Upstream epochs are seconds on some fields and milliseconds on others. */
function epochMs(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  return value < 1e12 ? Math.round(value * 1_000) : Math.round(value)
}

function jwtExpiry(token: string): number | undefined {
  const parts = token.split('.')
  if (parts.length < 2) return undefined
  try {
    const base64 = parts[1]!.replace(/-/g, '+').replace(/_/g, '/')
    const padded = base64 + '='.repeat((4 - base64.length % 4) % 4)
    const payload: unknown = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'))
    const exp = record(payload)?.exp
    return typeof exp === 'number' ? epochMs(exp) : undefined
  } catch {
    return undefined
  }
}

export function machineIdOf(deviceId: string): string {
  return createHash('sha256').update(`trae-web-machine\0${deviceId}`).digest('hex')
}

/** Browser binaries this plugin can drive, most specific first. */
function browserCandidates(): string[] {
  const env = process.env
  if (process.platform === 'win32') {
    const roots = [env['PROGRAMFILES'], env['PROGRAMFILES(X86)'], env['LOCALAPPDATA']]
      .filter((root): root is string => typeof root === 'string' && root !== '')
    return [
      ...roots.map(root => join(root, 'Google', 'Chrome', 'Application', 'chrome.exe')),
      ...roots.map(root => join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe')),
      ...roots.map(root => join(root, 'Chromium', 'Application', 'chrome.exe')),
    ]
  }
  if (process.platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    ]
  }
  const names = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'brave-browser']
  const fromPath = (env.PATH ?? '')
    .split(':')
    .filter(directory => directory !== '')
    .flatMap(directory => names.map(name => join(directory, name)))
  return [
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
    '/snap/bin/chromium',
    ...fromPath,
  ]
}

function findBrowser(): string | undefined {
  const override = process.env.DSH_TRAE_BROWSER?.trim()
  if (override !== undefined && override !== '' && existsSync(override)) return override
  return browserCandidates().find(candidate => existsSync(candidate))
}

/** A minimal DevTools protocol client over the page target's WebSocket. */
class CdpClient {
  private nextId = 0
  private closedFlag = false
  private readonly pending = new Map<number, {
    resolve: (value: unknown) => void
    reject: (error: Error) => void
    timer: NodeJS.Timeout
  }>()

  private constructor(private readonly socket: WebSocketLike) {
    socket.onclose = () => {
      this.closedFlag = true
      this.failPending(new Error('浏览器调试连接已断开'))
    }
    socket.onmessage = event => {
      if (typeof event.data !== 'string') return
      let message: unknown
      try {
        message = JSON.parse(event.data)
      } catch {
        return
      }
      const frame = record(message)
      const id = typeof frame?.id === 'number' ? frame.id : undefined
      if (id === undefined) return
      const waiter = this.pending.get(id)
      if (waiter === undefined) return
      this.pending.delete(id)
      if (frame?.error !== undefined) {
        const error = record(frame.error)
        waiter.reject(new Error(text(error?.message) ?? '浏览器调试命令失败'))
      } else {
        waiter.resolve(frame?.result)
      }
    }
  }

  get closed(): boolean {
    return this.closedFlag
  }

  static async connect(url: string): Promise<CdpClient> {
    const Constructor = (globalThis as { WebSocket?: WebSocketConstructor }).WebSocket
    if (Constructor === undefined) throw new Error('当前 Node 版本没有 WebSocket，无法连接浏览器调试端口')
    const socket = new Constructor(url)
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve()
      socket.onerror = () => reject(new Error('无法连接浏览器调试端口'))
    })
    return new CdpClient(socket)
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.closedFlag) return Promise.reject(new Error('浏览器调试连接已断开'))
    const id = ++this.nextId
    return new Promise<T>((resolve, reject) => {
      // A socket can stay "open" while the browser stops answering; without a
      // timeout the whole login poll would wait forever and never recover.
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('浏览器调试命令超时'))
      }, 15_000)
      timer.unref?.()
      this.pending.set(id, {
        resolve: value => {
          clearTimeout(timer)
          resolve(value as T)
        },
        reject: error => {
          clearTimeout(timer)
          reject(error)
        },
        timer,
      })
      try {
        this.socket.send(JSON.stringify({ id, method, params }))
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  private failPending(error: Error): void {
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
    this.pending.clear()
  }

  async evaluate<T>(expression: string): Promise<T> {
    const result = await this.send<{ result?: { value?: T }, exceptionDetails?: { text?: string } }>('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    if (result?.exceptionDetails !== undefined) {
      throw new Error(result.exceptionDetails.text ?? '页面脚本执行失败')
    }
    return result?.result?.value as T
  }

  close(): void {
    this.closedFlag = true
    this.failPending(new Error('浏览器调试连接已关闭'))
    try {
      this.socket.close()
    } catch {
      /* already closed */
    }
  }
}

/** The port a browser wrote to `DevToolsActivePort`, live or not. */
export function devToolsPortOf(profile: string): number | undefined {
  try {
    const lines = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').trim().split(/\r?\n/)
    const port = Number(lines[0])
    return Number.isInteger(port) && port > 0 ? port : undefined
  } catch {
    return undefined
  }
}

/** Whether something answers the DevTools HTTP endpoint on that port. */
async function devToolsAlive(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(800),
    })
    return response.ok
  } catch {
    return false
  }
}

/**
 * A live browser left over from an earlier attempt, or `undefined` after
 * clearing the dead port file.
 *
 * A browser killed on Windows leaves `DevToolsActivePort` behind. Reading that
 * stale file made the next launch connect to a dead port, wait 25 s for a page
 * that could never appear, and then close the window it had just opened. The
 * two cases are now told apart: a port that answers is reused, anything else is
 * a leftover and is removed before the new browser starts.
 */
export async function existingDevToolsPort(profile: string): Promise<number | undefined> {
  const port = devToolsPortOf(profile)
  if (port !== undefined) {
    // The file appears just before the endpoint starts answering, so give a
    // browser that is still starting a moment before calling it a leftover.
    for (let attempt = 0; attempt < 3; attempt++) {
      if (await devToolsAlive(port)) return port
      await sleep(300)
    }
  }
  rmSync(join(profile, 'DevToolsActivePort'), { force: true })
  return undefined
}

/** Open a fresh login tab in a browser that already owns the profile. */
async function openLoginPage(
  port: number,
  url: string,
  origin: string,
  timeoutMs: number,
  stopped?: () => boolean,
): Promise<CdpTarget> {
  // Chrome 111+ requires PUT; older builds (and some Edge versions) only accept
  // GET. Whichever works, the returned target is the new tab.
  for (const method of ['PUT', 'GET']) {
    if (stopped?.() === true) throw new Error('登录已取消。')
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, {
        method,
        signal: AbortSignal.timeout(5_000),
      })
      if (!response.ok) continue
      const target = await response.json() as CdpTarget
      if (target.webSocketDebuggerUrl !== undefined) return target
    } catch {
      /* try the other method, then any existing tab */
    }
  }
  return waitForPage(port, origin, timeoutMs, stopped)
}

async function waitForDevToolsPort(
  profile: string,
  timeoutMs: number,
  since: number,
  stopped?: () => boolean,
): Promise<number> {
  const file = join(profile, 'DevToolsActivePort')
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (stopped?.() === true) throw new Error('登录已取消。')
    try {
      // Only a file written by this launch counts: a leftover from a previous
      // browser must never be mistaken for the port of the window just opened.
      if (statSync(file).mtimeMs >= since - 1_000) {
        const lines = readFileSync(file, 'utf8').trim().split(/\r?\n/)
        const port = Number(lines[0])
        if (Number.isInteger(port) && port > 0) return port
      }
    } catch {
      /* not written yet */
    }
    await sleep(150)
  }
  throw new Error('浏览器没有在预期时间内打开调试端口，登录无法继续')
}

async function waitForPage(
  port: number,
  origin: string,
  timeoutMs: number,
  stopped?: () => boolean,
): Promise<CdpTarget> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (stopped?.() === true) throw new Error('登录已取消。')
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`)
      if (response.ok) {
        const targets = await response.json() as CdpTarget[]
        const page = targets.find(target => target.type === 'page' && target.url.startsWith(origin))
          ?? targets.find(target => target.type === 'page' && target.url.includes('trae'))
        if (page?.webSocketDebuggerUrl !== undefined) return page
      }
    } catch {
      /* browser still starting */
    }
    await sleep(250)
  }
  throw new Error('浏览器打开了，但没有找到 Trae 登录页')
}

function cookieHeader(cookies: readonly { name: string, value: string, domain: string, expires: number }[], host: string): string {
  const jar = new Map<string, string>()
  for (const cookie of cookies) {
    const domain = cookie.domain.startsWith('.') ? cookie.domain.slice(1) : cookie.domain
    if (host !== domain && !host.endsWith(`.${domain}`)) continue
    if (cookie.expires > 0 && cookie.expires * 1_000 <= Date.now()) continue
    if (!jar.has(cookie.name)) jar.set(cookie.name, cookie.value)
  }
  return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ')
}

async function authPost(
  profile: TraeRegionProfile,
  cookie: string,
  path: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${profile.apiBase}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      cookie,
      origin: profile.webOrigin,
      referer: `${profile.webOrigin}/`,
      'user-agent': TRAE_WEB_USER_AGENT,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  })
  const raw = await response.text()
  let payload: unknown
  try {
    payload = JSON.parse(raw)
  } catch {
    throw new Error(`${path} 返回的不是 JSON（HTTP ${response.status}）`)
  }
  if (!response.ok) throw new Error(`${path} 返回 HTTP ${response.status}`)
  const root = record(payload)
  const error = record(record(root?.ResponseMetadata)?.Error)
  if (error !== undefined && text(error.Message) !== undefined) {
    throw new Error(text(error.Message))
  }
  return root ?? {}
}

/**
 * One browser-backed Trae login.
 *
 * A flow is single-use: after it settles, start a new one for another login.
 */
export class TraeWebLogin {
  private phase: LoginPhase = 'idle'
  private message = ''
  private startedAt: number | undefined
  private finishedAt: number | undefined
  private error: string | undefined
  private signedIn = false
  private browser: ChildProcess | undefined
  private profile: string | undefined
  private persistentProfile = false
  private cdp: CdpClient | undefined
  private port: number | undefined
  /** True only for a browser this flow started; a reused one must survive. */
  private ownsBrowser = false
  private cleanupTask: Promise<void> | undefined
  private timer: NodeJS.Timeout | undefined
  private deadline: NodeJS.Timeout | undefined
  private closed = false
  private polling = false
  private failures = 0

  constructor(private readonly options: TraeWebLoginOptions) {}

  private get timeoutMs(): number {
    return this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  status(): LoginStatus {
    return {
      running: this.phase === 'preparing' || this.phase === 'waiting',
      phase: this.phase,
      ...this.message === '' ? {} : { message: this.message },
      ...this.startedAt === undefined ? {} : { startedAt: this.startedAt },
      ...this.finishedAt === undefined ? {} : { finishedAt: this.finishedAt },
      ...this.signedIn ? { signedIn: true } : {},
      ...this.error === undefined ? {} : { error: this.error },
    }
  }

  async start(): Promise<LoginStatus> {
    if (this.phase === 'preparing' || this.phase === 'waiting') return this.status()
    // A previous window may still be shutting down; starting again before that
    // finishes would race the kill against the new browser on the same profile.
    if (this.cleanupTask !== undefined) {
      await this.cleanupTask.catch(() => undefined)
      this.cleanupTask = undefined
    }
    this.reset()
    this.phase = 'preparing'
    this.startedAt = Date.now()
    this.message = '正在打开浏览器…'
    try {
      await this.launch()
      if (this.closed) return this.status()
      this.phase = 'waiting'
      this.message = WAITING_MESSAGE
      this.timer = setInterval(() => { void this.tick() }, POLL_INTERVAL_MS)
      this.timer.unref?.()
      this.deadline = setTimeout(() => { this.fail('登录等待超时，请重新发起登录。') }, this.timeoutMs)
      this.deadline.unref?.()
      void this.tick()
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error))
    }
    return this.status()
  }

  async cancel(): Promise<void> {
    if (this.phase !== 'preparing' && this.phase !== 'waiting') return
    this.settle('cancelled', '登录已取消。')
  }

  async close(): Promise<void> {
    await this.cancel()
    await this.shutdown()
  }

  private reset(): void {
    this.phase = 'idle'
    this.message = ''
    this.startedAt = undefined
    this.finishedAt = undefined
    this.error = undefined
    this.signedIn = false
    this.closed = false
    this.polling = false
    this.failures = 0
    this.persistentProfile = false
    this.port = undefined
    this.ownsBrowser = false
  }

  private async launch(): Promise<void> {
    const profile = TRAE_REGION_PROFILES[this.options.region]
    const executable = findBrowser()
    if (executable === undefined) {
      throw new Error('没有找到 Chrome 或 Edge。请先安装其中一个浏览器后再登录。')
    }
    const directory = this.options.profileDir ?? mkdtempSync(join(tmpdir(), 'dsh-trae-login-'))
    this.persistentProfile = this.options.profileDir !== undefined
    if (this.persistentProfile) mkdirSync(directory, { recursive: true })
    this.profile = directory
    const loginUrl = `${profile.webOrigin}/login?redirect_url=${encodeURIComponent(`${profile.webOrigin}/`)}`

    const existing = await existingDevToolsPort(directory)
    if (existing !== undefined) {
      // Chrome refuses a second instance on the same user-data-dir and hands the
      // URL to the running one instead. Reuse that window: the user may be in
      // the middle of signing in, and a browser this flow did not start must
      // never be killed when the flow ends.
      this.port = existing
      this.ownsBrowser = false
      const page = await openLoginPage(existing, loginUrl, profile.webOrigin, 25_000, () => this.closed)
      this.cdp = await CdpClient.connect(page.webSocketDebuggerUrl!)
      return
    }

    const launchedAt = Date.now()
    const child = spawn(executable, [
      '--remote-debugging-port=0',
      `--user-data-dir=${directory}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-sync',
      '--disable-background-networking',
      // A fresh automation-controlled profile is exactly what Trae's risk SDK
      // flags; keep the ordinary browser fingerprint for this dedicated profile.
      '--disable-blink-features=AutomationControlled',
      '--disable-features=Translate,MediaRouter',
      loginUrl,
    ], { stdio: 'ignore' })
    this.browser = child
    this.ownsBrowser = true
    child.once('error', error => {
      this.fail(`无法启动浏览器：${error.message}`)
    })
    child.once('exit', () => {
      if (this.closed || (this.phase !== 'preparing' && this.phase !== 'waiting')) return
      // A handoff to an already-running instance also ends this process; only a
      // dead DevTools port means the window really closed.
      const timer = setTimeout(() => {
        void (async () => {
          if (this.closed || (this.phase !== 'preparing' && this.phase !== 'waiting')) return
          const port = this.port ?? devToolsPortOf(directory)
          if (port !== undefined && await devToolsAlive(port)) {
            this.port = port
            return
          }
          this.fail('浏览器已关闭，登录未完成。')
        })()
      }, 1_500)
      timer.unref?.()
    })
    const port = await waitForDevToolsPort(directory, 25_000, launchedAt, () => this.closed)
    this.port = port
    const page = await waitForPage(port, profile.webOrigin, 25_000, () => this.closed)
    this.cdp = await CdpClient.connect(page.webSocketDebuggerUrl!)
  }

  private async cookies(host: string): Promise<string> {
    const cdp = this.cdp
    if (cdp === undefined) return ''
    let result: { cookies?: { name: string, value: string, domain: string, expires: number }[] } | undefined
    try {
      result = await cdp.send('Network.getAllCookies')
    } catch {
      result = await cdp.send<{ cookies?: { name: string, value: string, domain: string, expires: number }[] }>(
        'Storage.getCookies',
        {},
      ).catch(() => undefined)
    }
    return cookieHeader(result?.cookies ?? [], host)
  }

  private async tick(): Promise<void> {
    if (this.phase !== 'waiting' || this.cdp === undefined || this.polling) return
    this.polling = true
    try {
      const profile = TRAE_REGION_PROFILES[this.options.region]
      const host = new URL(profile.apiBase).hostname
      const cookie = await this.cookies(host)
      if (cookie === '') return
      const check = await authPost(profile, cookie, '/cloudide/api/v3/trae/CheckLogin', {
        GetNickNameEditStatus: true,
        ReqSource: 'OfficialSite',
      })
      const result = record(check.Result)
      if (result?.IsLogin !== true) {
        this.failures = 0
        this.message = WAITING_MESSAGE
        return
      }
      const tokenPayload = await authPost(profile, cookie, '/cloudide/api/v3/common/GetUserToken', {})
      const token = text(record(tokenPayload.Result)?.Token)
      if (token === undefined) throw new Error('登录成功，但没有读到网页令牌；请重试。')
      const captured = await this.cdp.evaluate<string>(DEVICE_EXPRESSION).catch(() => '')
      const deviceId = text(captured) ?? randomUUID()
      const name = await this.readName(profile, cookie)
      const sessionExpiresAt = epochMs(result.ExpiredAt)
      // `ExpiredAt` is the website session (about 14 days); the JWT itself
      // lasts about 8 hours and is the one every API call checks.
      const expiresAt = jwtExpiry(token) ?? sessionExpiresAt
      await this.options.save({
        accessToken: token,
        deviceId,
        machineId: machineIdOf(deviceId),
        ...text(result.UserID) === undefined ? {} : { userId: text(result.UserID)! },
        ...name === undefined ? {} : { name },
        ...expiresAt === undefined ? {} : { expiresAt },
        cookies: cookie,
        ...sessionExpiresAt === undefined ? {} : { sessionExpiresAt },
      })
      this.signedIn = true
      this.settle('done', '登录成功，浏览器窗口会自动关闭。')
    } catch (error) {
      this.failures += 1
      const message = error instanceof Error ? error.message : String(error)
      this.options.logger?.(`dsh-llm-adapters: Trae 登录状态检查失败（第 ${this.failures} 次）：${message}`)
      await this.recover()
    } finally {
      this.polling = false
    }
  }

  /**
   * Decide what a failed status check means.
   *
   * Giving up after three consecutive errors is six seconds of a redirect or a
   * flaky network — and ending the flow used to close the very window the user
   * was signing in on. Only a dead DevTools connection or a dead browser is
   * fatal now; everything else retries until the deadline.
   */
  private async recover(): Promise<void> {
    if (this.closed) return
    if (this.cdp?.closed === true) {
      this.fail('登录窗口已关闭，请重新发起登录。')
      return
    }
    if (this.port !== undefined && await devToolsAlive(this.port)) {
      this.message = '正在等待登录（状态检查暂时失败，自动重试中）…'
      return
    }
    this.fail('浏览器已关闭，登录未完成。')
  }

  private async readName(
    profile: TraeRegionProfile,
    cookie: string,
  ): Promise<string | undefined> {
    try {
      const payload = await authPost(profile, cookie, '/cloudide/api/v3/trae/GetUserInfo', { IfWebPage: true })
      const result = record(payload.Result)
      return text(result?.ScreenName) ?? text(result?.NickName) ?? text(result?.UserName)
    } catch {
      return undefined
    }
  }

  private settle(phase: 'done' | 'cancelled', message: string): void {
    if (this.phase === 'done' || this.phase === 'error' || this.phase === 'cancelled') return
    this.phase = phase
    this.message = message
    this.finishedAt = Date.now()
    void this.shutdown()
  }

  private fail(message: string): void {
    if (this.phase === 'done' || this.phase === 'error' || this.phase === 'cancelled') return
    this.phase = 'error'
    this.error = message
    this.message = message
    this.finishedAt = Date.now()
    this.options.logger?.(`dsh-llm-adapters: Trae 登录失败：${message}`)
    void this.shutdown()
  }

  /** One cleanup per flow; a new start waits for it before opening a browser. */
  private shutdown(): Promise<void> {
    this.cleanupTask ??= this.cleanup()
    return this.cleanupTask
  }

  private async cleanup(): Promise<void> {
    this.closed = true
    if (this.timer !== undefined) clearInterval(this.timer)
    if (this.deadline !== undefined) clearTimeout(this.deadline)
    this.timer = undefined
    this.deadline = undefined
    const cdp = this.cdp
    const owns = this.ownsBrowser
    this.cdp = undefined
    this.ownsBrowser = false
    this.port = undefined
    if (cdp !== undefined) {
      // A reused window belongs to an earlier attempt: close only the tab this
      // flow opened, never the browser itself.
      if (!owns && !cdp.closed) {
        try {
          await cdp.send('Page.close')
        } catch {
          /* the tab is already gone */
        }
      }
      cdp.close()
    }
    const child = this.browser
    this.browser = undefined
    if (owns && child !== undefined && child.exitCode === null) {
      child.kill()
      if (process.platform === 'win32' && child.pid !== undefined) {
        try {
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
        } catch {
          /* the browser is already gone */
        }
      }
    }
    const directory = this.profile
    const persistent = this.persistentProfile
    this.profile = undefined
    this.persistentProfile = false
    if (directory !== undefined && !persistent) {
      const timer = setTimeout(() => {
        try {
          rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
        } catch {
          /* a still-running browser keeps a lock; the temp dir is harmless */
        }
      }, 1_500)
      timer.unref?.()
    }
  }
}
