/**
 * Raccoon QR sign-in.
 *
 * The official desktop client receives its authorization through the
 * `office-raccoon://auth/callback` protocol, which a host-side Node process
 * cannot receive, and the web page's callback address is fixed. The current
 * website instead asks the server for a QR session, renders the returned
 * `scan_path`, and polls the same session until the phone confirms it.
 *
 * The QR code is single-use and server-issued: a locally invented code looks
 * fine while polling but the scan landing page rejects it as expired or
 * already used. Nothing here may fabricate the code.
 *
 * @module dsh-llm-adapters/raccoon-login
 */

import { raccoonAccountInfo } from './account-profile.ts'
import { startLoginPage, type LoginPageHandle, type LoginStatus } from './login-page.ts'
import { renderQrSvg } from './qr.ts'

const RACCOON_WEB_API = 'https://xiaohuanxiong.com/api/web'
/** IAM endpoints that create and poll the QR session. */
export const RACCOON_IAM_BASE = 'https://xiaohuanxiong.com/api/iam/v1'
/** Origin the server-issued `scan_path` is resolved against. */
export const RACCOON_QR_ORIGIN = 'https://xiaohuanxiong.com'
/** Name shown by the scan landing page; the website sends exactly this value. */
export const RACCOON_QR_APP_NAME = '商汤小浣熊'

const IAM_TIMEOUT_MS = 20_000

export interface RaccoonLoginAccount {
  token: string
  refreshToken?: string
  name?: string
  phone?: string
  ownerType?: string
}

export interface RaccoonLoginOptions {
  save(account: RaccoonLoginAccount): Promise<void>
  /** Gateway catalog probe; a token is only saved when this returns true. */
  validate(token: string): Promise<boolean>
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

/** A server-issued QR session. */
export interface RaccoonQrSession {
  code: string
  scanPath: string
  expiresIn: number
  pollInterval: number
}

export interface RaccoonQrPoll {
  status: 'pending' | 'logging' | 'canceled' | 'success' | 'expired' | 'error'
  accessToken?: string
  refreshToken?: string
  expiresIn?: number
  pollInterval?: number
  message?: string
}

/** A failed IAM call; `code` is the server's error code when there is one. */
export class RaccoonIamError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 0,
  ) {
    super(message)
    this.name = 'RaccoonIamError'
  }
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function numberField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** POST one IAM endpoint and unwrap its `{ code, data }` envelope. */
async function postIam(
  path: string,
  body: Record<string, unknown>,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown> | undefined> {
  let response: Response
  try {
    response = await fetchImpl(`${RACCOON_IAM_BASE}${path}`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(IAM_TIMEOUT_MS),
    })
  } catch (error) {
    const timeout = error instanceof Error
      && (error.name === 'TimeoutError' || error.name === 'AbortError')
    throw new RaccoonIamError(
      timeout ? 'TIMEOUT' : 'NETWORK_ERROR',
      `小浣熊登录请求失败：${error instanceof Error ? error.message : String(error)}`,
    )
  }

  let parsed: unknown
  try {
    parsed = await response.json()
  } catch {
    throw new RaccoonIamError(
      'INVALID_RESPONSE',
      `小浣熊登录响应不是 JSON（HTTP ${response.status}）`,
      response.status,
    )
  }
  const root = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {}
  const code = stringField(root.code) ?? ''
  if (!response.ok || code !== 'OK') {
    const message = stringField(root.message)
      ?? `小浣熊登录服务返回错误 ${code || `HTTP ${response.status}`}`
    throw new RaccoonIamError(code || `HTTP_${response.status}`, message, response.status)
  }
  const data = root.data !== null && typeof root.data === 'object' && !Array.isArray(root.data)
    ? root.data as Record<string, unknown>
    : undefined
  return data
}

/** The server must hand out a same-origin path; never treat it as a URL to visit blindly. */
function assertScanPath(scanPath: string): void {
  if (!scanPath.startsWith('/') || scanPath.startsWith('//') || /[\\\s#]/.test(scanPath)) {
    throw new RaccoonIamError('INVALID_RESPONSE', '小浣熊登录服务返回了无效的扫码地址。')
  }
  const url = new URL(scanPath, RACCOON_QR_ORIGIN)
  if (url.protocol !== 'https:' || url.origin !== RACCOON_QR_ORIGIN || url.hash !== '') {
    throw new RaccoonIamError('INVALID_RESPONSE', '小浣熊登录服务返回了无效的扫码地址。')
  }
}

/** Ask the server for a new single-use QR session. */
export async function createRaccoonQr(
  fetchImpl: typeof fetch = fetch,
): Promise<RaccoonQrSession> {
  const data = await postIam('/auth/mp/qrcode', {}, fetchImpl)
  const code = stringField(data?.qrcode_code)
  const scanPath = stringField(data?.scan_path)
  const expiresIn = numberField(data?.expires_in)
  const pollInterval = numberField(data?.poll_interval)
  if (
    code === undefined
    || scanPath === undefined
    || expiresIn === undefined
    || pollInterval === undefined
    || expiresIn <= 0
    || expiresIn > 3600
    || pollInterval <= 0
  ) {
    throw new RaccoonIamError('INVALID_RESPONSE', '小浣熊登录服务返回的二维码信息不完整。')
  }
  assertScanPath(scanPath)
  return { code, scanPath, expiresIn, pollInterval }
}

/** The exact URL the website encodes into its own QR. */
export function raccoonQrContent(session: RaccoonQrSession): string {
  const url = new URL(session.scanPath, RACCOON_QR_ORIGIN)
  url.search = ''
  url.searchParams.set('code', session.code)
  url.searchParams.set('appname', RACCOON_QR_APP_NAME)
  url.searchParams.set('source', 'platform')
  return url.href
}

/**
 * One poll. Expiry is reported as its own state; ordinary network hiccups stay
 * pending so a transient failure cannot kill a login the user is completing.
 */
export async function pollRaccoonQr(
  code: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RaccoonQrPoll> {
  try {
    const data = await postIam('/auth/mp/qrcode/login', { qrcode_code: code }, fetchImpl)
    if (data === undefined) {
      throw new RaccoonIamError('INVALID_RESPONSE', '小浣熊登录服务没有返回二维码状态。')
    }
    const status = stringField(data.status) ?? ''
    const expiresIn = numberField(data.expires_in)
    const pollInterval = numberField(data.poll_interval)
    const timing = {
      ...expiresIn === undefined ? {} : { expiresIn },
      ...pollInterval === undefined ? {} : { pollInterval },
    }
    if (status === 'canceled') return { status: 'canceled', ...timing }
    if (status === 'logging') return { status: 'logging', ...timing }
    if (status !== 'success') return { status: 'pending', ...timing }

    const accessToken = stringField(data.access_token)
    if (accessToken === undefined) {
      throw new RaccoonIamError('INVALID_RESPONSE', '小浣熊登录响应缺少访问令牌。')
    }
    const tokenType = stringField(data.token_type)
    if (tokenType !== undefined && tokenType.toLowerCase() !== 'bearer') {
      throw new RaccoonIamError('INVALID_RESPONSE', '小浣熊登录响应包含不支持的令牌类型。')
    }
    const refreshToken = stringField(data.refresh_token)
    return {
      status: 'success',
      accessToken,
      ...refreshToken === undefined ? {} : { refreshToken },
      ...timing,
    }
  } catch (error) {
    if (error instanceof RaccoonIamError) {
      if (error.code === 'AUTH_QRCODE_EXPIRED' || error.code === 'AUTH_QRCODE_NOT_FOUND') {
        return { status: 'expired', message: '二维码已过期，请重新发起登录。' }
      }
      if (error.code === 'NETWORK_ERROR' || error.code === 'TIMEOUT') {
        return { status: 'pending' }
      }
      return { status: 'error', message: error.message }
    }
    return { status: 'pending' }
  }
}

/** A cookie value from one `Set-Cookie` header, if the response carried it. */
function cookieValue(setCookies: readonly string[], matches: (name: string) => boolean): string | undefined {
  for (const line of setCookies) {
    const pair = line.split(';', 1)[0] ?? ''
    const index = pair.indexOf('=')
    if (index <= 0) continue
    const name = pair.slice(0, index).trim()
    if (!matches(name)) continue
    const raw = pair.slice(index + 1).trim().replace(/^"|"$/g, '')
    try {
      return decodeURIComponent(raw)
    } catch {
      return raw
    }
  }
  return undefined
}

/**
 * Establish the business session for a freshly issued IAM token.
 *
 * The website calls this before its own `/api/web` requests, and the response
 * is what gives it the `xhx_token` business cookie. A host-side fetch keeps no
 * cookie jar, so the token is taken out of `Set-Cookie` explicitly. Failure is
 * not fatal: the catalog probe in `finish()` is the authoritative check.
 */
async function confirmIamSession(
  token: string,
  fetchImpl: typeof fetch,
): Promise<{ token?: string, refreshToken?: string }> {
  try {
    const response = await fetchImpl(`${RACCOON_WEB_API}/auth/v1/iam/confirm`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        'x-raccoon-language': 'zh-CN',
      },
      body: '{}',
      redirect: 'error',
      signal: AbortSignal.timeout(IAM_TIMEOUT_MS),
    })
    const headers = response.headers as Headers & { getSetCookie?: () => string[] }
    const setCookies = headers.getSetCookie?.()
      ?? (headers.get('set-cookie') === null ? [] : [headers.get('set-cookie')!])
    await response.text()
    if (!response.ok) return {}
    const businessToken = cookieValue(setCookies, name => name === 'xhx_token' || name.endsWith('xhx_token'))
    const refreshToken = cookieValue(setCookies, name => name.endsWith('raccoon_refresh_token'))
    return {
      ...businessToken === undefined ? {} : { token: businessToken },
      ...refreshToken === undefined ? {} : { refreshToken },
    }
  } catch {
    /* the gateway probe below decides whether the token is usable */
  }
  return {}
}

/**
 * One running Raccoon QR login. `start()` resolves once the local page is
 * listening; the user completes the scan in that page.
 */
export class RaccoonQrLogin {
  private handle: LoginPageHandle | undefined
  private failure: LoginStatus | undefined

  constructor(private readonly options: RaccoonLoginOptions) {}

  status(): LoginStatus {
    if (this.handle !== undefined) return this.handle.status()
    return this.failure ?? { running: false, phase: 'idle' }
  }

  async start(): Promise<LoginStatus> {
    const current = this.handle?.status()
    if (current?.running === true) return current
    if (this.handle !== undefined) {
      await this.handle.close()
      this.handle = undefined
    }
    this.failure = undefined

    const fetchImpl = this.options.fetchImpl ?? fetch
    let session: RaccoonQrSession | undefined
    let deadline = 0
    let accessToken = ''
    let refreshToken: string | undefined

    try {
      const handle = await startLoginPage({
        title: 'Raccoon 登录',
        heading: '使用微信扫码登录 Raccoon',
        subtitle: '打开微信扫一扫，扫描下方二维码',
        prepare: async () => {
          session = await createRaccoonQr(fetchImpl)
          deadline = Date.now() + session.expiresIn * 1_000
          return { qr: renderQrSvg(raccoonQrContent(session), { size: 220 }) }
        },
        poll: async () => {
          if (session === undefined) {
            return { phase: 'error', message: '二维码尚未准备好，请重新发起登录。' }
          }
          if (Date.now() >= deadline) {
            return { phase: 'expired', message: '二维码已过期，请重新发起登录。' }
          }
          const polled = await pollRaccoonQr(session.code, fetchImpl)
          if (polled.expiresIn !== undefined) {
            deadline = Date.now() + polled.expiresIn * 1_000
          }
          if (polled.status === 'success' && polled.accessToken !== undefined) {
            accessToken = polled.accessToken
            refreshToken = polled.refreshToken
            return { phase: 'done', message: '登录成功，可以关闭此窗口。' }
          }
          if (polled.status === 'logging') {
            return { phase: 'scanned', message: '已扫码，请在手机上确认' }
          }
          if (polled.status === 'canceled') {
            return { phase: 'cancelled', message: '你已取消授权，请重新登录。' }
          }
          if (polled.status === 'expired') {
            return { phase: 'expired', message: polled.message ?? '二维码已过期，请重新发起登录。' }
          }
          if (polled.status === 'error') {
            return { phase: 'error', message: polled.message ?? '小浣熊登录失败，请重试。' }
          }
          return { phase: 'waiting', message: '等待扫码…' }
        },
        finish: async () => {
          if (accessToken.length === 0) throw new Error('小浣熊登录响应缺少访问令牌。')
          const confirmed = await confirmIamSession(accessToken, fetchImpl)
          const token = confirmed.token ?? accessToken
          if (!(await this.options.validate(token))) {
            throw new Error('小浣熊账号已授权，但模型网关拒绝了这次登录令牌。请重试；若持续出现，请改用桌面客户端登录态。')
          }
          const info = await raccoonAccountInfo({ accessToken: token, fetchImpl })
          await this.options.save({
            token,
            ...confirmed.refreshToken === undefined && refreshToken === undefined
              ? {}
              : { refreshToken: confirmed.refreshToken ?? refreshToken },
            ...info,
          })
        },
        ...this.options.timeoutMs === undefined ? {} : { timeoutMs: this.options.timeoutMs },
      })
      this.handle = handle
      void handle.result.catch(() => undefined)
      return handle.status()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.failure = { running: false, phase: 'error', error: message }
      throw error
    }
  }

  async cancel(): Promise<void> {
    const handle = this.handle
    if (handle === undefined) return
    await handle.close()
  }
}
