/**
 * CodeArts browser sign-in: a loopback callback server plus the portal handoff.
 *
 * The flow is two-legged and both legs matter:
 *
 * 1. The settings page asks the host to start; the host opens a loopback server
 *    on a port ≥ 10000 (the portal refuses lower ones) and returns the portal
 *    URL. The page opens that URL in a normal browser tab.
 * 2. Huawei redirects to `http://127.0.0.1:<port>/oauth/callback?code=…`; the
 *    host exchanges the code (PKCE + DPoP), stores the credential and closes the
 *    server. The page polls `/account/browser` and adopts the account.
 *
 * The portal can also answer the *legacy* way, with `?secret=` instead of a
 * code. That branch polls the ticket endpoint for a plain AK/SK/ST triple: it
 * still signs correctly, but it carries no refresh token, so the account lasts
 * two hours and then needs another sign-in. Both branches are reported as
 * success — hiding the second one would leave users stuck on a page that says
 * "waiting" forever.
 *
 * @module dsh-llm-adapters/codearts-login
 */

import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { LoginStatus } from './login-page.ts'
import {
  CODEARTS_SNAP_BASE,
  CODEARTS_LOGIN_PLUGIN_NAME,
  CODEARTS_LOGIN_PLUGIN_VERSION,
  CODEARTS_REDIRECT_PATH,
} from './codearts-endpoints.ts'
import {
  buildAuthorizeUrl, buildLoginResultUrl, exchangeAuthorizationCode, generateDpopKeyPair,
  generatePkcePair,
} from './codearts-oauth.ts'
import type { CodeArtsCredential, DpopKeyPair, PkcePair } from './codearts-oauth.ts'

/** What the store keeps after a successful sign-in. */
export interface CodeArtsLoginAccount extends CodeArtsCredential {
  userName?: string
  loginAt: number
}

export interface CodeArtsLoginOptions {
  save: (account: CodeArtsLoginAccount) => Promise<void>
  timeoutMs?: number
  fetcher?: typeof fetch
  logger?: (message: string) => void
}

/** The portal rejects callback ports below 10000. */
const MIN_CALLBACK_PORT = 10_000
const DEFAULT_TIMEOUT_MS = 180_000

const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
}

function page(title: string, detail: string): string {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>`
    + '<style>body{font:15px/1.6 system-ui,sans-serif;margin:0;padding:48px;color:#111}'
    + 'h1{font-size:1.15em;margin:0 0 8px}p{margin:0;opacity:.75}</style>'
    + `<h1>${title}</h1><p>${detail}</p>`
}

/** Listen on loopback, retrying with a high port when the kernel picks a low one. */
async function listenHigh(server: Server, attempt = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => reject(error)
    server.once('error', onError)
    server.listen(attempt === 0 ? 0 : MIN_CALLBACK_PORT + Math.floor(Math.random() * (65_536 - MIN_CALLBACK_PORT)), '127.0.0.1', () => {
      server.removeListener('error', onError)
      const address = server.address() as AddressInfo | null
      const port = address?.port ?? 0
      if (port >= MIN_CALLBACK_PORT || attempt >= 3) {
        resolve(port)
        return
      }
      server.close(() => { void listenHigh(server, attempt + 1).then(resolve, reject) })
    })
  })
}

/** Poll the legacy ticket endpoint until the credential appears. */
async function pollTicket(
  ticketId: string,
  secret: string,
  fetcher: typeof fetch,
): Promise<CodeArtsCredential | undefined> {
  const url = `${CODEARTS_SNAP_BASE}/snap-manager/v1/login/ticket`
    + `?ticket_id=${encodeURIComponent(ticketId)}&secret=${encodeURIComponent(secret)}`
  for (let attempt = 0; attempt < 30; attempt++) {
    if (attempt > 0) await new Promise(resolve => setTimeout(resolve, 1_000))
    try {
      const response = await fetcher(url, {
        headers: {
          'content-type': 'application/json;charset=UTF-8',
          'plugin-name': CODEARTS_LOGIN_PLUGIN_NAME,
          'plugin-version': CODEARTS_LOGIN_PLUGIN_VERSION,
        },
        signal: AbortSignal.timeout(15_000),
      })
      if (!response.ok) continue
      const body = await response.json() as Record<string, unknown>
      const credential = body.credential as Record<string, unknown> | undefined
      const result = body.result as Record<string, unknown> | undefined
      const ak = String(credential?.access ?? result?.accessKeyId ?? '')
      const st = String(credential?.securitytoken ?? credential?.securityToken ?? result?.securityToken ?? '')
      const sk = String(credential?.secret ?? result?.secretAccessKey ?? '')
      if (ak !== '' && st !== '') {
        const raw = String(credential?.expires_at ?? result?.expiration ?? '')
        const expiresAt = Date.parse(raw)
        return {
          accessKeyId: ak,
          secretAccessKey: sk,
          securityToken: st,
          ...Number.isNaN(expiresAt) ? {} : { expiresAt },
        }
      }
    } catch {
      /* transient; the next attempt retries */
    }
  }
  return undefined
}

/**
 * One in-flight sign-in.
 *
 * A second `start()` while one is running returns the existing status: two
 * callback servers would race for the same credential and the losing one would
 * report a spurious timeout.
 */
export class CodeArtsLogin {
  private server: Server | undefined
  private state: LoginStatus = { running: false, phase: 'idle' }
  private timer: ReturnType<typeof setTimeout> | undefined
  private ticketId = ''
  private keyPair: DpopKeyPair | undefined
  private pkce: PkcePair | undefined

  constructor(private readonly options: CodeArtsLoginOptions) {}

  private get fetcher(): typeof fetch {
    return this.options.fetcher ?? fetch
  }

  status(): LoginStatus {
    return { ...this.state }
  }

  async start(): Promise<LoginStatus> {
    if (this.state.running) return this.status()
    await this.dispose()

    const ticketId = randomUUID()
    const pkce = generatePkcePair()
    const keyPair = generateDpopKeyPair()
    this.ticketId = ticketId
    this.pkce = pkce
    this.keyPair = keyPair

    const server = createServer((request, response) => {
      void this.handle(request.url ?? '/', response)
    })
    const port = await listenHigh(server)
    this.server = server

    const url = buildAuthorizeUrl(port, pkce, ticketId)
    this.state = {
      running: true,
      phase: 'waiting',
      url,
      startedAt: Date.now(),
      message: '已打开华为云登录页：完成授权后会自动接回，无需复制任何令牌。',
    }
    const timeout = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.timer = setTimeout(() => {
      this.fail(new Error(`登录超时（${Math.round(timeout / 60_000)} 分钟）。请重新点一次登录。`))
    }, timeout)
    this.timer.unref?.()
    return this.status()
  }

  private async handle(rawUrl: string, response: import('node:http').ServerResponse): Promise<void> {
    let url: URL
    try {
      url = new URL(rawUrl, 'http://127.0.0.1')
    } catch {
      response.writeHead(400, CORS_HEADERS).end('Bad request')
      return
    }
    if (!url.pathname.startsWith(CODEARTS_REDIRECT_PATH)) {
      response.writeHead(404, CORS_HEADERS).end('Not found')
      return
    }
    if (url.searchParams.get('code') === null && url.searchParams.get('secret') === null) {
      response.writeHead(400, CORS_HEADERS).end('Missing authorization code')
      return
    }

    const code = url.searchParams.get('code')
    const secret = url.searchParams.get('secret')
    if (secret !== null) {
      // Legacy branch: the portal did not accept the OAuth request. Answer the
      // browser first (it is waiting), then poll for the credential.
      response.writeHead(307, { ...CORS_HEADERS, location: buildLoginResultUrl(true) }).end()
      const credential = await pollTicket(this.ticketId, secret, this.fetcher)
      if (credential === undefined) {
        this.fail(new Error('华为云没有返回凭据，请重新登录。'))
        return
      }
      await this.finish(credential)
      return
    }

    const port = (this.server?.address() as AddressInfo | null)?.port ?? 0
    const pkce = this.pkce
    const keyPair = this.keyPair
    if (pkce === undefined || keyPair === undefined) {
      response.writeHead(400, CORS_HEADERS).end('No login in progress')
      return
    }
    try {
      const credential = await exchangeAuthorizationCode(code!, pkce.codeVerifier, port, keyPair, this.fetcher)
      response.writeHead(307, { ...CORS_HEADERS, location: buildLoginResultUrl(true) }).end()
      await this.finish(credential)
    } catch (error) {
      response.writeHead(307, { ...CORS_HEADERS, location: buildLoginResultUrl(false) }).end()
      this.fail(error instanceof Error ? error : new Error(String(error)))
    }
  }

  private async finish(credential: CodeArtsCredential): Promise<void> {
    await this.options.save({ ...credential, loginAt: Date.now() })
    this.state = {
      running: false,
      phase: 'done',
      signedIn: true,
      startedAt: this.state.startedAt,
      finishedAt: Date.now(),
      message: '登录成功。',
    }
    await this.dispose()
  }

  private fail(error: Error): void {
    this.state = {
      running: false,
      phase: 'error',
      error: error.message,
      startedAt: this.state.startedAt,
      finishedAt: Date.now(),
    }
    this.options.logger?.(`codearts login: ${error.message}`)
    void this.dispose()
  }

  async cancel(): Promise<void> {
    if (this.state.running) {
      this.state = { running: false, phase: 'cancelled', finishedAt: Date.now() }
    }
    await this.dispose()
  }

  async close(): Promise<void> {
    await this.cancel()
  }

  private async dispose(): Promise<void> {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    const server = this.server
    this.server = undefined
    if (server !== undefined) await new Promise<void>(resolve => server.close(() => resolve()))
  }
}

/** Render the page a browser tab shows when the user lands on the callback. */
export function loginLandingPage(ok: boolean): string {
  return ok
    ? page('登录成功', '可以关闭这个标签页，回到设置页继续。')
    : page('登录失败', '授权没有完成，请回到设置页重新点一次登录。')
}
