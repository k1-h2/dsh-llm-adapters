/**
 * Raccoon QR sign-in.
 *
 * The official desktop client receives its authorization through the
 * `office-raccoon://auth/callback` protocol, which a host-side Node process
 * cannot receive, and the web page's callback address is fixed. The QR route
 * avoids callbacks entirely: the host generates a code, the phone scans the
 * matching public login page, and the host polls until the code turns into a
 * token pair.
 *
 * @module dsh-llm-adapters/raccoon-login
 */

import { randomBytes } from 'node:crypto'
import { raccoonAccountInfo } from './account-profile.ts'
import { startLoginPage, type LoginPageHandle, type LoginStatus } from './login-page.ts'
import { renderQrSvg } from './qr.ts'

// Same value as RACCOON_BASE in raccoon.ts. Importing it here would make the
// provider→login→provider cycle evaluate a constant before it is initialized.
const RACCOON_API = 'https://xiaohuanxiong.com/api/web'

/** Origin that serves the public QR landing page (the API lives under /api/web). */
export const RACCOON_QR_ORIGIN = 'https://xiaohuanxiong.com'

const POLL_TIMEOUT_MS = 20_000
const QR_CODE_BYTES = 16

export interface RaccoonLoginAccount {
  token: string
  refreshToken?: string
  name?: string
  phone?: string
  ownerType?: string
}

export interface RaccoonLoginOptions {
  save(account: RaccoonLoginAccount): Promise<void>
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

interface QrPoll {
  status: 'pending' | 'logging' | 'canceled' | 'success'
  accessToken?: string
  refreshToken?: string
}

/** Milliseconds + 32 lowercase hex, matching the web client's QR payload. */
export function raccoonQrCode(): string {
  return `${Date.now()}${randomBytes(QR_CODE_BYTES).toString('hex')}`
}

/** The URL encoded into the QR image; scanning it opens WeChat authorization. */
export function raccoonQrContent(code: string): string {
  const query = new URLSearchParams({ code, appname: '小浣熊官网' })
  return `${RACCOON_QR_ORIGIN}/login/mp?${query.toString()}`
}

/** One poll against the login endpoint; network failures count as still pending. */
export async function pollRaccoonQr(
  code: string,
  fetchImpl: typeof fetch = fetch,
): Promise<QrPoll> {
  try {
    const response = await fetchImpl(`${RACCOON_API}/auth/v1/login_with_qrcode_code`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ qrcode_code: code }),
      signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
    })
    if (!response.ok) return { status: 'pending' }
    const payload: unknown = await response.json()
    if (payload === null || typeof payload !== 'object') return { status: 'pending' }
    const root = payload as Record<string, unknown>
    if (root.code !== 0) return { status: 'pending' }
    const data = root.data !== null && typeof root.data === 'object' && !Array.isArray(root.data)
      ? root.data as Record<string, unknown>
      : undefined
    if (data === undefined) return { status: 'pending' }
    const status = typeof data.status === 'string' ? data.status : ''
    if (status === 'canceled') return { status: 'canceled' }
    if (status === 'logging') return { status: 'logging' }
    if (status !== 'success') return { status: 'pending' }
    const accessToken = typeof data.access_token === 'string' ? data.access_token : ''
    if (accessToken.length === 0) return { status: 'pending' }
    const refreshToken = typeof data.refresh_token === 'string' && data.refresh_token.length > 0
      ? data.refresh_token
      : undefined
    return {
      status: 'success',
      accessToken,
      ...refreshToken === undefined ? {} : { refreshToken },
    }
  } catch {
    return { status: 'pending' }
  }
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
    const code = raccoonQrCode()
    let accessToken = ''
    let refreshToken: string | undefined

    try {
      const handle = await startLoginPage({
        title: 'Raccoon 登录',
        heading: '使用微信扫码登录 Raccoon',
        subtitle: '打开微信扫一扫，扫描下方二维码',
        prepare: async () => ({ qr: renderQrSvg(raccoonQrContent(code), { size: 220 }) }),
        poll: async () => {
          const polled = await pollRaccoonQr(code, fetchImpl)
          if (polled.status === 'success' && polled.accessToken !== undefined) {
            accessToken = polled.accessToken
            refreshToken = polled.refreshToken
            return { phase: 'done', message: '登录成功，可以关闭此窗口。' }
          }
          if (polled.status === 'logging') return { phase: 'scanned', message: '已扫码，请在手机上确认' }
          if (polled.status === 'canceled') return { phase: 'cancelled', message: '你已取消授权，请重新登录。' }
          return { phase: 'waiting', message: '等待扫码…' }
        },
        finish: async () => {
          const info = await raccoonAccountInfo({ accessToken, fetchImpl })
          await this.options.save({
            token: accessToken,
            ...refreshToken === undefined ? {} : { refreshToken },
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
