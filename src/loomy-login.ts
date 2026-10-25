/**
 * Loomy WeChat QR sign-in.
 *
 * The Loomy client intercepts the WeChat redirect inside Electron and never
 * loads the callback page; that page is 404 for everyone else. The host mirrors
 * the client's actual account API instead: fetch the WeChat authorization page,
 * read the QR uuid out of it, long-poll the QR status, and exchange the
 * confirmed `code` through the signed iFlytek account endpoints.
 *
 * The QR image is inlined into the local page, so the page needs no network of
 * its own beyond the host it came from.
 *
 * @module dsh-llm-adapters/loomy-login
 */

import { createHash, createHmac, randomUUID } from 'node:crypto'
import { startLoginPage, type LoginPageHandle, type LoginStatus } from './login-page.ts'

export const LOOMY_ACCOUNT_BASE = 'https://account.xfinfr.com'
export const LOOMY_WECHAT_APP_ID = 'wx18d60be432287cf8'
export const LOOMY_WECHAT_REDIRECT_URI = 'https://loomy.xunfei.cn/oauth/wechat/callback'

const LOOMY_ACCESS_KEY_ID = '2thryby66wxi53sk'
const LOOMY_ACCESS_KEY_SECRET = 'zsak6eadrbawz683wf5r3m2snrwj868r'
const LOOMY_APP_ID = 'GM3LOOMY'
const LOOMY_OK_CODE = '000000'
// Keep in step with LOOMY_SESSION_TTL_MS in loomy.ts; the login module must not
// import that module or the provider→login→provider cycle would be a TDZ risk.
const LOOMY_SESSION_TTL_SECONDS = 14 * 24 * 60 * 60
const REQUEST_TIMEOUT_MS = 30_000
const POLL_TIMEOUT_MS = 40_000
const WECHAT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

export interface LoomyLoginAccount {
  token: string
  userId?: string
  phone?: string
  name?: string
}

export interface LoomyLoginOptions {
  save(account: LoomyLoginAccount): Promise<void>
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

interface WechatPoll {
  status: 'waiting' | 'scanned' | 'confirmed' | 'cancelled' | 'expired' | 'error'
  code: string
  errcode: string
}

/** RFC 3986 escaping used by the iFlytek signer (also covers `!'()*`). */
function escapeRfc3986(value: string): string {
  return encodeURIComponent(value)
    .replace(/!/g, '%21')
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/\*/g, '%2A')
}

function contentMd5(body: string): string {
  return body.length === 0 ? '' : createHash('md5').update(body, 'utf8').digest('base64')
}

function escapedPath(raw: string): string {
  let value = raw.startsWith('/') ? raw : `/${raw}`
  if (value.length > 1 && value.endsWith('/')) value = value.slice(0, -1)
  return value.split('/').map(part => part.length === 0 ? '' : escapeRfc3986(part)).join('/')
}

/** The nine-line string iFlytek signs; the last two lines are empty here. */
export function buildLoomySigningString(input: {
  accessKeyId: string
  accessKeySecret: string
  method: string
  path: string
  body?: string
  contentType?: string
  date: string
  nonce: string
}): string {
  return [
    input.method.toUpperCase(),
    escapedPath(input.path),
    '',
    contentMd5(input.body ?? ''),
    input.contentType ?? '',
    input.date,
    input.nonce,
    '',
    '',
  ].join('\n')
}

/** Headers for one signed iFlytek account request. */
export function loomyAccountHeaders(input: {
  method: string
  path: string
  body: string
  contentType?: string
}): Record<string, string> {
  const date = new Date().toUTCString()
  const nonce = randomUUID()
  const contentType = input.contentType ?? 'application/json'
  const signature = createHmac('sha1', LOOMY_ACCESS_KEY_SECRET)
    .update(buildLoomySigningString({
      accessKeyId: LOOMY_ACCESS_KEY_ID,
      accessKeySecret: LOOMY_ACCESS_KEY_SECRET,
      method: input.method,
      path: input.path,
      body: input.body,
      contentType,
      date,
      nonce,
    }), 'utf8')
    .digest('base64')
  const headers: Record<string, string> = {
    authorization: `account ${LOOMY_ACCESS_KEY_ID}:${signature}`,
    date,
    nonce,
    'content-type': contentType,
  }
  const md5 = contentMd5(input.body)
  if (md5.length > 0) headers['content-md5'] = md5
  return headers
}

/**
 * iFlytek account call. The body is serialized once and the same string is
 * signed and sent; re-serializing would change bytes and invalidate the HMAC.
 */
async function postLoomyAccount(
  path: string,
  param: Record<string, unknown>,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown>> {
  const body = JSON.stringify({
    base: {
      appid: LOOMY_APP_ID,
      modelid: 'Web',
      version: '1.0.0',
      devid: 'web',
      ua: 'Loomy|Desktop|Electron|macOS',
      traceid: randomUUID().replace(/-/g, ''),
    },
    param,
  })
  let response: Response
  try {
    response = await fetchImpl(`${LOOMY_ACCOUNT_BASE}${path}`, {
      method: 'POST',
      headers: loomyAccountHeaders({ method: 'POST', path, body }),
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    throw new Error(`讯飞账号请求失败：${error instanceof Error ? error.message : String(error)}`)
  }
  let parsed: unknown
  try {
    parsed = await response.json()
  } catch {
    throw new Error(`讯飞账号响应不是 JSON（HTTP ${response.status}）`)
  }
  const root = parsed !== null && typeof parsed === 'object'
    ? parsed as Record<string, unknown>
    : {}
  const code = typeof root.code === 'string' ? root.code : ''
  if (code !== LOOMY_OK_CODE) {
    const message = typeof root.desc === 'string' && root.desc.length > 0
      ? root.desc
      : `讯飞账号返回错误 ${code || '(缺少 code)'}`
    throw new Error(message)
  }
  return root.data !== null && typeof root.data === 'object' && !Array.isArray(root.data)
    ? root.data as Record<string, unknown>
    : {}
}

/** WeChat open-platform authorization URL; the redirect page itself is never loaded. */
export function buildLoomyWechatAuthUrl(state: string): string {
  return 'https://open.weixin.qq.com/connect/qrconnect'
    + `?appid=${encodeURIComponent(LOOMY_WECHAT_APP_ID)}`
    + `&redirect_uri=${encodeURIComponent(LOOMY_WECHAT_REDIRECT_URI)}`
    + '&response_type=code&scope=snsapi_login'
    + `&state=${encodeURIComponent(state)}`
    + '#wechat_redirect'
}

/** Read the QR uuid out of the authorization page HTML. */
export function extractWechatUuid(html: string): string {
  const fromImage = html.match(/\/connect\/qrcode\/([A-Za-z0-9_\-=+/]+)/)
  const fromPoll = html.match(/l\/qrconnect\?uuid=([A-Za-z0-9_\-=+/]+)/)
  const value = fromImage?.[1] ?? fromPoll?.[1] ?? ''
  return /^[A-Za-z0-9_\-=+/]{6,64}$/.test(value) ? value : ''
}

/** Fetch the authorization page and return its QR uuid. */
export async function fetchLoomyWechatUuid(
  state: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const authUrl = buildLoomyWechatAuthUrl(state)
  let response: Response
  try {
    response = await fetchImpl(authUrl, {
      headers: { 'user-agent': WECHAT_UA, referer: 'https://open.weixin.qq.com/' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    throw new Error(`微信授权页拉取失败：${error instanceof Error ? error.message : String(error)}`)
  }
  if (!response.ok) throw new Error(`微信授权页返回 HTTP ${response.status}`)
  const uuid = extractWechatUuid(await response.text())
  if (uuid.length === 0) throw new Error('微信授权页里没有二维码（页面结构可能已变化）')
  return uuid
}

function imageMime(bytes: Uint8Array): string {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif'
  return ''
}

/** Download the QR image and inline it as a data URL. */
export async function fetchLoomyWechatQr(
  uuid: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const url = `https://open.weixin.qq.com/connect/qrcode/${encodeURIComponent(uuid)}`
  let response: Response
  try {
    response = await fetchImpl(url, {
      headers: { 'user-agent': WECHAT_UA, referer: 'https://open.weixin.qq.com/' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    throw new Error(`微信二维码下载失败：${error instanceof Error ? error.message : String(error)}`)
  }
  if (!response.ok) throw new Error(`微信二维码返回 HTTP ${response.status}`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  const mime = imageMime(bytes)
  if (mime === '' || bytes.length < 200) throw new Error('微信二维码响应不是图片')
  return `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`
}

/** One long poll; 405 carries the one-time authorization code. */
export async function pollLoomyWechat(
  uuid: string,
  lastErrcode: string,
  fetchImpl: typeof fetch = fetch,
): Promise<WechatPoll> {
  const query = `uuid=${encodeURIComponent(uuid)}`
    + (lastErrcode.length > 0 ? `&last=${encodeURIComponent(lastErrcode)}` : '')
    + `&_=${Date.now()}`
  let body: string
  try {
    const response = await fetchImpl(`https://long.open.weixin.qq.com/connect/l/qrconnect?${query}`, {
      headers: { 'user-agent': WECHAT_UA, referer: buildLoomyWechatAuthUrl('') },
      signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
    })
    body = await response.text()
  } catch {
    return { status: 'error', code: '', errcode: 'network' }
  }
  const errcode = (body.match(/wx_errcode\s*=\s*(\d+)/) ?? [])[1] ?? ''
  const code = (body.match(/wx_code\s*=\s*'([^']*)'/) ?? [])[1] ?? ''
  if (errcode === '405') {
    return code.length > 0
      ? { status: 'confirmed', code, errcode }
      : { status: 'scanned', code: '', errcode }
  }
  if (errcode === '404') return { status: 'scanned', code: '', errcode }
  if (errcode === '403') return { status: 'cancelled', code: '', errcode }
  if (errcode === '402') return { status: 'expired', code: '', errcode }
  return { status: 'waiting', code: '', errcode }
}

/** First WeChat step: exchange a code for `rcode` and learn whether a phone is bound. */
export async function bindLoomyThirdAccount(
  code: string,
  fetchImpl: typeof fetch,
): Promise<{ bind: boolean, rcode: string, nickname?: string }> {
  const data = await postLoomyAccount('/login/thirdAccount/bind/auth', {
    tcode: { code },
    type: 'wx',
  }, fetchImpl)
  const rcode = typeof data.rcode === 'string' ? data.rcode : ''
  if (rcode.length === 0) throw new Error('微信授权响应缺少 rcode')
  return {
    bind: data.bind === 1,
    rcode,
    ...typeof data.nickname === 'string' && data.nickname.length > 0 ? { nickname: data.nickname } : {},
  }
}

export async function sendLoomyBindSms(
  rcode: string,
  phone: string,
  fetchImpl: typeof fetch,
): Promise<string> {
  const data = await postLoomyAccount('/login/thirdAccount/bind/sendMsg', {
    rcode,
    phone,
    ccode: '86',
    expire: 300,
  }, fetchImpl)
  const msgid = typeof data.msgid === 'string' ? data.msgid : ''
  if (msgid.length === 0) throw new Error('短信验证码响应缺少 msgid')
  return msgid
}

export async function verifyLoomyBindSms(
  rcode: string,
  code: string,
  msgid: string,
  fetchImpl: typeof fetch,
): Promise<{ session: string, userid: string, phone: string }> {
  const data = await postLoomyAccount('/login/thirdAccount/bind/checkCode', {
    rcode,
    mcode: code,
    msgid,
    expire: LOOMY_SESSION_TTL_SECONDS,
  }, fetchImpl)
  const session = typeof data.session === 'string' ? data.session : ''
  const userid = typeof data.userid === 'string' ? data.userid : ''
  if (session.length === 0) throw new Error('绑定登录响应缺少 session')
  if (userid.length === 0) throw new Error('绑定登录响应缺少 userid')
  return {
    session,
    userid,
    phone: typeof data.phone === 'string' ? data.phone : '',
  }
}

export async function skipLoomyBind(
  rcode: string,
  fetchImpl: typeof fetch,
): Promise<{ session: string, userid: string }> {
  const data = await postLoomyAccount('/login/thirdAccount/bind/skip', {
    rcode,
    expire: LOOMY_SESSION_TTL_SECONDS,
  }, fetchImpl)
  const session = typeof data.session === 'string' ? data.session : ''
  const userid = typeof data.userid === 'string' ? data.userid : ''
  if (session.length === 0) throw new Error('微信登录响应缺少 session')
  if (userid.length === 0) throw new Error('微信登录响应缺少 userid')
  return { session, userid }
}

/** One running Loomy QR login. */
export class LoomyQrLogin {
  private handle: LoginPageHandle | undefined
  private failure: LoginStatus | undefined

  constructor(private readonly options: LoomyLoginOptions) {}

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
    const state = randomUUID()
    let uuid = ''
    let lastErrcode = ''
    let rcode = ''
    let msgid = ''
    let nickname: string | undefined
    let account: LoomyLoginAccount | undefined

    try {
      const handle = await startLoginPage({
        title: 'Loomy 登录',
        heading: '使用微信扫码登录 Loomy',
        subtitle: '打开微信扫一扫，扫描下方二维码',
        prepare: async () => {
          uuid = await fetchLoomyWechatUuid(state, fetchImpl)
          const image = await fetchLoomyWechatQr(uuid, fetchImpl)
          return { qr: `<img src="${image}" alt="微信登录二维码">` }
        },
        poll: async () => {
          if (rcode.length > 0) return { phase: 'binding', message: '请绑定手机号' }
          const polled = await pollLoomyWechat(uuid, lastErrcode, fetchImpl)
          if (polled.errcode.length > 0) lastErrcode = polled.errcode
          if (polled.status === 'scanned') return { phase: 'scanned', message: '已扫码，请在手机上确认' }
          if (polled.status === 'cancelled') return { phase: 'cancelled', message: '你已取消授权，请重新登录。' }
          if (polled.status === 'expired') return { phase: 'expired', message: '二维码已失效，请重新登录。' }
          if (polled.status !== 'confirmed') return { phase: 'waiting', message: '等待扫码…' }

          const auth = await bindLoomyThirdAccount(polled.code, fetchImpl)
          nickname = auth.nickname
          if (auth.bind) {
            const login = await skipLoomyBind(auth.rcode, fetchImpl)
            account = {
              token: login.session,
              userId: login.userid,
              ...nickname === undefined ? {} : { name: nickname },
            }
            return { phase: 'done', message: '登录成功，可以关闭此窗口。' }
          }
          rcode = auth.rcode
          return { phase: 'binding', message: '首次登录需要绑定手机号' }
        },
        binding: {
          hint: '该微信账号还没有绑定手机号，绑定后才能登录 Loomy。',
          send: async (phone) => {
            msgid = await sendLoomyBindSms(rcode, phone, fetchImpl)
          },
          verify: async (phone, code) => {
            const login = await verifyLoomyBindSms(rcode, code, msgid, fetchImpl)
            account = {
              token: login.session,
              userId: login.userid,
              phone: login.phone.length > 0 ? login.phone : phone,
              ...nickname === undefined ? {} : { name: nickname },
            }
          },
        },
        finish: async () => {
          if (account === undefined) throw new Error('登录凭据缺失')
          await this.options.save(account)
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
    await this.handle?.close()
  }
}
