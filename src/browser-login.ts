/**
 * Browser login: launches an isolated Chromium window, waits for the user to
 * sign in, then harvests the resulting credentials over the DevTools protocol.
 *
 * The window gets a throwaway profile, so the user's everyday browser cookies
 * are never read. Credentials stay in memory until the provider stores them.
 *
 * @module dsh-llm-adapters/browser-login
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

export class BrowserLoginError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BrowserLoginError'
  }
}

export type BrowserLoginPhase =
  | 'idle'
  | 'launching'
  | 'waiting'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'timeout'

export interface BrowserLoginStatus {
  running: boolean
  phase: BrowserLoginPhase
  url?: string
  error?: string
  signedIn?: boolean
  startedAt?: number
  finishedAt?: number
}

export interface BrowserAccount {
  token: string
  refreshToken?: string
  name?: string
  phone?: string
  userId?: string
  ownerType?: string
}

export interface BrowserProfile {
  name?: string
  phone?: string
  userId?: string
}

interface BrowserCookie {
  name: string
  value: string
  domain: string
}

interface BrowserTarget {
  targetId: string
  url: string
}

/** What the in-page probe returns. */
export interface BrowserProbeValue {
  tokens?: unknown
  profile?: unknown
  ready?: unknown
}

export interface BrowserDriver {
  readonly closed: boolean
  pages(): Promise<BrowserTarget[]>
  attach(targetId: string): Promise<string>
  evaluate(sessionId: string, expression: string): Promise<unknown>
  cookies(): Promise<BrowserCookie[]>
  /** Login responses captured so far, in arrival order. */
  authResponses(): readonly { url: string, text: string }[]
  close(): Promise<void>
}

export type BrowserLauncher = (executable: string, url: string) => Promise<BrowserDriver>

export interface BrowserLoginSpec {
  /** Page URLs that may receive the probe, matched as substrings. */
  hosts: readonly string[]
  /** Cookie domains whose values become candidates. */
  cookieDomains: readonly string[]
  loginUrl: string
  probe: string
  timeoutMs?: number
  /** Validate every candidate; the first account returned wins. */
  resolve: (input: { tokens: readonly string[], profile?: BrowserProfile }) => Promise<BrowserAccount | undefined>
  save: (account: BrowserAccount) => Promise<void>
}

export interface BrowserLoginOptions {
  launch?: BrowserLauncher
  findExecutable?: () => string | undefined
  pollMs?: number
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1_000
const DEFAULT_POLL_MS = 1_500
const MAX_CANDIDATES = 24

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Best-effort removal of the throwaway profile.
 *
 * Windows keeps handles open briefly after the browser exits; a single `rm`
 * would leave the login cookies behind, so retry instead of giving up.
 */
async function removeProfile(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      await fs.rm(dir, { recursive: true, force: true })
      return
    } catch {
      await delay(250)
    }
  }
}

/**
 * Chromium browsers that support `--remote-debugging-port`, most likely first.
 * An explicit `DSH_LLM_ADAPTERS_BROWSER` always wins so a custom install works.
 */
export function browserCandidates(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const out: string[] = []
  const explicit = env.DSH_LLM_ADAPTERS_BROWSER?.trim()
  if (explicit !== undefined && explicit !== '') out.push(explicit)
  if (platform === 'win32') {
    const programFiles = env.ProgramFiles ?? 'C:\\Program Files'
    const programFilesX86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
    const localAppData = env.LOCALAPPDATA
    out.push(
      path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      ...localAppData === undefined ? [] : [path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe')],
      path.join(programFiles, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
    )
  } else if (platform === 'darwin') {
    out.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    )
  } else {
    out.push(
      '/usr/bin/google-chrome',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/microsoft-edge',
    )
  }
  return [...new Set(out)]
}

export function findBrowser(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return browserCandidates(platform, env).find(candidate => existsSync(candidate))
}

/** Collects token-ish strings from captured login responses. */
export function tokensFromAuthResponses(bodies: readonly { text: string }[]): string[] {
  const out: string[] = []
  const visit = (value: unknown, key: string, depth: number): void => {
    if (depth > 6) return
    if (typeof value === 'string') {
      const field = key.toLowerCase()
      const tokenField = field.includes('token') || field === 'session' || field.includes('sessionid')
      if (tokenField && value.length >= 16 && value.length <= 4096 && !/\s/.test(value)) out.push(value)
      return
    }
    if (value === null || typeof value !== 'object') return
    if (Array.isArray(value)) {
      for (const item of value) visit(item, key, depth + 1)
      return
    }
    for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
      visit(child, childKey, depth + 1)
    }
  }
  for (const body of bodies) {
    try {
      visit(JSON.parse(body.text), '', 0)
    } catch {
      /* not JSON */
    }
  }
  return out
}

/**
 * Shared storage scan. Runs in the provider page; no network calls beyond the
 * provider's own readiness endpoint are made from inside that page.
 */
const STORAGE_SCAN = String.raw`
  const push = value => {
    if (typeof value === 'string' && value.length >= 16 && value.length <= 4096 && !/\s/.test(value)) out.tokens.push(value);
  };
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key) continue;
      const raw = localStorage.getItem(key);
      if (!raw || raw.length > 8192) continue;
      push(raw);
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          for (const field of ['session', 'sessionId', 'session_id', 'token', 'access_token', 'accessToken', 'refresh_token', 'refreshToken']) {
            push(parsed[field]);
          }
        }
      } catch (error) {}
    }
  } catch (error) {}
  try {
    for (const part of document.cookie.split(';')) {
      const raw = part.split('=').slice(1).join('=');
      if (raw) {
        try { push(decodeURIComponent(raw.trim())); } catch (error) { push(raw.trim()); }
      }
    }
  } catch (error) {}
`

export const LOOMY_LOGIN_PROBE = String.raw`(async () => {
  const out = { tokens: [], profile: {}, ready: false };
  ${STORAGE_SCAN}
  try {
    const response = await fetch('/api/workspace/auth/me', { credentials: 'same-origin' });
    if (response.ok) {
      const body = await response.json();
      const data = body && body.data ? body.data : body;
      if (data && typeof data === 'object') {
        const userId = data.userId || data.user_id || '';
        const maskedPhone = data.maskedPhone || data.masked_phone || '';
        const name = data.nickname || data.name || '';
        if (userId || maskedPhone) {
          out.ready = true;
          out.profile = { userId: userId, phone: maskedPhone, name: name };
        }
      }
    }
  } catch (error) {}
  return out;
})()`

export const RACCOON_LOGIN_PROBE = String.raw`(async () => {
  const out = { tokens: [], profile: {}, ready: false };
  const jwt = value => typeof value === 'string' && /^ey[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value);
  const keep = value => { if (jwt(value)) out.tokens.push(value); };
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key) continue;
      const raw = localStorage.getItem(key);
      if (!raw || raw.length > 8192) continue;
      keep(raw);
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          for (const field of ['access_token', 'refresh_token', 'accessToken', 'refreshToken', 'token']) keep(parsed[field]);
        }
      } catch (error) {}
    }
  } catch (error) {}
  try {
    for (const part of document.cookie.split(';')) {
      const raw = part.split('=').slice(1).join('=');
      if (raw) {
        try { keep(decodeURIComponent(raw.trim())); } catch (error) { keep(raw.trim()); }
      }
    }
  } catch (error) {}
  out.ready = out.tokens.length > 0;
  return out;
})()`

interface SocketLike {
  send(data: string): void
  close(): void
  addEventListener(type: string, listener: (event: unknown) => void): void
}

type SocketConstructor = new (url: string) => SocketLike

interface CdpEvent {
  method: string
  params: Record<string, unknown>
  sessionId?: string
}

class Cdp {
  private nextId = 0
  private closedFlag = false
  private readonly pending = new Map<number, { resolve: (value: unknown) => void, reject: (error: Error) => void }>()
  private readonly listeners = new Set<(event: CdpEvent) => void>()

  constructor(private readonly socket: SocketLike) {
    socket.addEventListener('message', raw => {
      let message: {
        id?: number
        method?: string
        params?: Record<string, unknown>
        sessionId?: string
        result?: unknown
        error?: { message?: string }
      }
      try {
        message = JSON.parse(String((raw as { data?: unknown }).data)) as typeof message
      } catch {
        return
      }
      if (message.method !== undefined) {
        const event: CdpEvent = {
          method: message.method,
          params: message.params ?? {},
          ...message.sessionId === undefined ? {} : { sessionId: message.sessionId },
        }
        for (const listener of this.listeners) {
          try {
            listener(event)
          } catch {
            /* listener failures must not break the protocol loop */
          }
        }
        return
      }
      if (message.id === undefined) return
      const pending = this.pending.get(message.id)
      if (pending === undefined) return
      this.pending.delete(message.id)
      if (message.error !== undefined) pending.reject(new Error(message.error.message ?? '浏览器调试调用失败'))
      else pending.resolve(message.result)
    })
    socket.addEventListener('close', () => {
      this.closedFlag = true
      for (const pending of this.pending.values()) pending.reject(new BrowserLoginError('浏览器已关闭。'))
      this.pending.clear()
    })
  }

  static async connect(url: string): Promise<Cdp> {
    const Constructor = (globalThis as unknown as { WebSocket?: SocketConstructor }).WebSocket
    if (Constructor === undefined) {
      throw new BrowserLoginError('当前 Node 运行时不支持 WebSocket，无法启动浏览器登录。')
    }
    const socket = new Constructor(url)
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        reject(new BrowserLoginError('连接浏览器调试端口超时。'))
      }, 10_000)
      socket.addEventListener('open', () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve()
      })
      socket.addEventListener('error', () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(new BrowserLoginError('无法连接浏览器调试端口。'))
      })
    })
    return new Cdp(socket)
  }

  get isClosed(): boolean {
    return this.closedFlag
  }

  onEvent(listener: (event: CdpEvent) => void): void {
    this.listeners.add(listener)
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    if (this.closedFlag) return Promise.reject(new BrowserLoginError('浏览器已关闭。'))
    const id = ++this.nextId
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
      this.socket.send(JSON.stringify({ id, method, params, ...sessionId === undefined ? {} : { sessionId } }))
    })
  }

  close(): void {
    try {
      this.socket.close()
    } catch {
      /* already closed */
    }
  }
}

async function connectToDevTools(child: ChildProcess, profileDir: string): Promise<Cdp> {
  const portFile = path.join(profileDir, 'DevToolsActivePort')
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new BrowserLoginError('浏览器进程已退出，无法完成登录。')
    try {
      const content = (await fs.readFile(portFile, 'utf8')).trim()
      const [portLine, wsPath] = content.split('\n')
      const port = Number(portLine)
      if (Number.isInteger(port) && port > 0 && wsPath !== undefined && wsPath.trim() !== '') {
        return await Cdp.connect(`ws://127.0.0.1:${port}${wsPath.trim()}`)
      }
    } catch {
      /* the file is written once the browser is ready */
    }
    await delay(150)
  }
  throw new BrowserLoginError('浏览器调试端口没有就绪，无法完成登录。')
}

async function launchBrowserDriver(executable: string, url: string): Promise<BrowserDriver> {
  const profileDir = await fs.mkdtemp(path.join(tmpdir(), 'dsh-llm-login-'))
  const child = spawn(executable, [
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--disable-extensions',
    '--disable-features=msEdgeFirstRunExperience',
    '--new-window',
    url,
  ], { stdio: 'ignore' })

  let cdp: Cdp
  try {
    cdp = await connectToDevTools(child, profileDir)
  } catch (error) {
    child.kill()
    await removeProfile(profileDir)
    throw error
  }
  const connection = cdp

  const authBodies: { url: string, text: string }[] = []
  const watched = new Map<string, string>()
  connection.onEvent(event => {
    if (event.sessionId === undefined) return
    const requestId = typeof event.params.requestId === 'string' ? event.params.requestId : undefined
    if (requestId === undefined) return
    const key = `${event.sessionId}:${requestId}`
    if (event.method === 'Network.responseReceived') {
      const response = event.params.response as { url?: unknown, mimeType?: unknown } | undefined
      const target = typeof response?.url === 'string' ? response.url : ''
      const mime = typeof response?.mimeType === 'string' ? response.mimeType : ''
      if (target === '' || !/auth|login|token|session|oauth/i.test(target) || !mime.includes('json')) return
      watched.set(key, target)
      return
    }
    if (event.method !== 'Network.loadingFinished') return
    const target = watched.get(key)
    if (target === undefined) return
    watched.delete(key)
    void connection.send<{ body: string, base64Encoded: boolean }>(
      'Network.getResponseBody',
      { requestId },
      event.sessionId,
    ).then(result => {
      if (authBodies.length >= 20) return
      authBodies.push({
        url: target,
        text: result.base64Encoded ? Buffer.from(result.body, 'base64').toString('utf8') : result.body,
      })
    }).catch(() => undefined)
  })

  return {
    get closed() {
      return connection.isClosed
    },
    async pages() {
      const result = await connection.send<{ targetInfos?: { targetId: string, type: string, url: string }[] }>('Target.getTargets')
      return (result.targetInfos ?? [])
        .filter(target => target.type === 'page')
        .map(target => ({ targetId: target.targetId, url: target.url }))
    },
    async attach(targetId) {
      const attached = await connection.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true })
      await connection.send('Runtime.enable', {}, attached.sessionId).catch(() => undefined)
      await connection.send('Network.enable', {}, attached.sessionId).catch(() => undefined)
      return attached.sessionId
    },
    async evaluate(sessionId, expression) {
      const result = await connection.send<{ result?: { value?: unknown } }>(
        'Runtime.evaluate',
        { expression, awaitPromise: true, returnByValue: true },
        sessionId,
      )
      return result.result?.value
    },
    async cookies() {
      const result = await connection.send<{ cookies?: BrowserCookie[] }>('Storage.getCookies')
      return result.cookies ?? []
    },
    authResponses() {
      return authBodies
    },
    async close() {
      try {
        await connection.send('Browser.close')
      } catch {
        /* already gone */
      }
      connection.close()
      await delay(300)
      if (child.exitCode === null && child.signalCode === null) child.kill()
      await removeProfile(profileDir)
    },
  }
}

function profileFrom(probe: BrowserProbeValue | undefined): BrowserProfile | undefined {
  const raw = probe?.profile
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const record = raw as Record<string, unknown>
  const text = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
  const profile: BrowserProfile = {}
  if (text(record.name) !== undefined) profile.name = text(record.name)
  if (text(record.phone) !== undefined) profile.phone = text(record.phone)
  if (text(record.userId) !== undefined) profile.userId = text(record.userId)
  return Object.keys(profile).length === 0 ? undefined : profile
}

/**
 * One browser login attempt per flow. `start()` is non-blocking: it opens the
 * window, then this object is polled by the settings page.
 */
export class BrowserLoginFlow {
  private state: BrowserLoginStatus = { running: false, phase: 'idle' }
  private driver: BrowserDriver | undefined
  private cancelled = false
  private lastTriedKey: string | undefined

  constructor(
    private readonly spec: BrowserLoginSpec,
    private readonly options: BrowserLoginOptions = {},
  ) {}

  status(): BrowserLoginStatus {
    return { ...this.state }
  }

  start(): BrowserLoginStatus {
    if (this.state.running) return this.status()
    const executable = (this.options.findExecutable ?? findBrowser)()
    if (executable === undefined) {
      throw new BrowserLoginError('未找到可用的 Chromium 浏览器（Edge / Chrome）。请安装其中之一，或用环境变量 DSH_LLM_ADAPTERS_BROWSER 指定路径。')
    }
    this.cancelled = false
    this.lastTriedKey = undefined
    this.state = {
      running: true,
      phase: 'launching',
      url: this.spec.loginUrl,
      startedAt: Date.now(),
    }
    void this.run(executable)
    return this.status()
  }

  cancel(): void {
    if (!this.state.running) return
    this.cancelled = true
    this.state = {
      ...this.state,
      running: false,
      phase: 'cancelled',
      error: '已取消登录。',
      finishedAt: Date.now(),
    }
    const driver = this.driver
    this.driver = undefined
    void driver?.close()
  }

  private async run(executable: string): Promise<void> {
    let sawReady = false
    try {
      const launch = this.options.launch ?? launchBrowserDriver
      const driver = await launch(executable, this.spec.loginUrl)
      this.driver = driver
      if (this.cancelled) {
        await driver.close()
        return
      }
      this.state = { ...this.state, phase: 'waiting' }

      const pollMs = this.options.pollMs ?? DEFAULT_POLL_MS
      const deadline = Date.now() + (this.spec.timeoutMs ?? DEFAULT_TIMEOUT_MS)
      const sessions = new Map<string, string>()
      let profile: BrowserProfile | undefined

      while (!this.cancelled && Date.now() < deadline) {
        if (driver.closed) throw new BrowserLoginError('浏览器窗口已关闭，登录未完成。')

        const tokens: string[] = []
        const pages = await driver.pages()
        for (const page of pages) {
          if (!this.spec.hosts.some(host => page.url.includes(host))) continue
          let sessionId = sessions.get(page.targetId)
          if (sessionId === undefined) {
            try {
              sessionId = await driver.attach(page.targetId)
              sessions.set(page.targetId, sessionId)
            } catch {
              continue
            }
          }
          try {
            const value = await driver.evaluate(sessionId, this.spec.probe) as BrowserProbeValue | undefined
            if (value === null || typeof value !== 'object') continue
            if (value.ready === true) sawReady = true
            if (Array.isArray(value.tokens)) {
              for (const token of value.tokens) {
                if (typeof token === 'string') tokens.push(token)
              }
            }
            const reported = profileFrom(value)
            if (reported !== undefined) profile = { ...profile, ...reported }
          } catch {
            /* the page may be mid-navigation */
          }
        }

        const cookies = await driver.cookies()
        const relevant = cookies
          .filter(cookie => {
            if (cookie.value.length < 16 || cookie.value.length > 4096 || /\s/.test(cookie.value)) return false
            const domain = cookie.domain.replace(/^\./, '')
            return this.spec.cookieDomains.some(suffix => domain === suffix || domain.endsWith(`.${suffix}`))
          })
          .sort((a, b) => scoreCookie(b.name) - scoreCookie(a.name))
        for (const cookie of relevant) tokens.push(cookie.value)

        for (const token of tokensFromAuthResponses(driver.authResponses())) tokens.push(token)

        const unique = [...new Set(tokens)].slice(0, MAX_CANDIDATES)
        const key = unique.join('\u0000')
        if (unique.length > 0 && key !== this.lastTriedKey) {
          this.lastTriedKey = key
          const account = await this.spec.resolve({ tokens: unique, profile })
          if (account !== undefined) {
            await this.spec.save(account)
            this.state = {
              ...this.state,
              running: false,
              phase: 'done',
              signedIn: true,
              error: undefined,
              finishedAt: Date.now(),
            }
            return
          }
        }
        await delay(pollMs)
      }

      if (!this.cancelled) {
        this.state = {
          ...this.state,
          running: false,
          phase: 'timeout',
          finishedAt: Date.now(),
          error: sawReady
            ? '网页里已经登录成功，但没有拿到可用的模型调用凭据。请改用桌面客户端登录态，或稍后重试。'
            : '等待登录超时，请重试。',
        }
      }
    } catch (error) {
      if (!this.cancelled) {
        this.state = {
          ...this.state,
          running: false,
          phase: 'failed',
          finishedAt: Date.now(),
          error: error instanceof Error ? error.message : String(error),
        }
      }
    } finally {
      const driver = this.driver
      this.driver = undefined
      await driver?.close()
    }
  }
}

function scoreCookie(name: string): number {
  return /session|token|auth|sid/i.test(name) ? 1 : 0
}
