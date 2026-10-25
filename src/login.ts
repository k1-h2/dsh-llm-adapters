/**
 * Web account login, for users who do not install either desktop client.
 *
 * This reimplements the login calls the official clients make:
 *
 * - Loomy (`account.xfinfr.com`): HMAC-SHA1 signed JSON envelopes. Password
 *   login uses a server-issued RSA public key and nonce; the SMS path sends a
 *   code and returns a `msgid`. Neither needs a captcha.
 * - Raccoon (`xiaohuanxiong.com/api/web/auth/v1`): phone and password are
 *   AES-128-CFB encrypted with the web client's own key before they are sent.
 *   Its SMS endpoint sits behind an Aliyun slider captcha, so only the password
 *   path is offered here.
 *
 * These are the clients' private interfaces, not published APIs. They can stop
 * working when a client changes; failures name the upstream message so the
 * settings page can explain what to do.
 *
 * @module dsh-llm-adapters/login
 */

import {
  constants, createCipheriv, createHash, createHmac, publicEncrypt, randomBytes, randomUUID,
} from 'node:crypto'
import { attributionHeaders } from '@deepseek-ai/dsh-llm'

export const LOOMY_ACCOUNT_BASE = 'https://account.xfinfr.com'
export const RACCOON_WEB_BASE = 'https://xiaohuanxiong.com/api/web'

/**
 * The access key pair the Loomy client ships for its account service.
 *
 * It is a client-side constant, not a user secret. The environment variables
 * exist so a future client release can be matched without a code change.
 */
const LOOMY_AK_ID = process.env.LOOMY_AK_ID?.trim() || '2thryby66wxi53sk'
const LOOMY_AK_SECRET = process.env.LOOMY_AK_SECRET?.trim() || 'zsak6eadrbawz683wf5r3m2snrwj868r'

/** Session lifetime the Loomy client itself requests (14 days). */
export const LOOMY_SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1_000

const RACCOON_AES_KEY = 'senseraccoon2023'
const REQUEST_TIMEOUT_MS = 20_000

export class LoginError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message)
    this.name = 'LoginError'
  }
}

function escapeComponent(value: string): string {
  return encodeURIComponent(value)
    .replace(/!/g, '%21')
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/\*/g, '%2A')
}

function contentMd5(body: string): string {
  return body === '' ? '' : createHash('md5').update(body, 'utf8').digest('base64')
}

/** The 9-line canonical string the account service signs. */
export function loomyStringToSign(input: {
  path: string
  body: string
  date: string
  nonce: string
  contentType?: string
}): string {
  const segments = input.path.startsWith('/') ? input.path.split('/') : `/${input.path}`.split('/')
  return [
    'POST',
    segments.map(escapeComponent).join('/'),
    '',
    contentMd5(input.body),
    input.contentType ?? 'application/json',
    input.date,
    input.nonce,
    '',
    '',
  ].join('\n')
}

export function loomySignature(input: { path: string, body: string, date: string, nonce: string }): string {
  return createHmac('sha1', LOOMY_AK_SECRET)
    .update(loomyStringToSign(input), 'utf8')
    .digest('base64')
}

function parseJson(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}

async function postJson(
  url: string,
  body: Record<string, unknown>,
  extraHeaders: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<{ status: number, payload: Record<string, unknown> | undefined, text: string }> {
  let response: Response
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { ...attributionHeaders(), accept: 'application/json', 'content-type': 'application/json', ...extraHeaders },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    throw new LoginError(`无法连接登录服务：${error instanceof Error ? error.message : String(error)}`, 'NETWORK')
  }
  const text = await response.text().catch(() => '')
  return { status: response.status, payload: parseJson(text), text }
}

/** One signed call to the iFlytek account service. */
async function loomyAccountCall(
  path: string,
  body: Record<string, unknown>,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown>> {
  const text = JSON.stringify(body)
  const date = new Date().toUTCString()
  const nonce = randomUUID()
  const headers = {
    authorization: `account ${LOOMY_AK_ID}:${loomySignature({ path, body: text, date, nonce })}`,
    date,
    nonce,
    'content-md5': contentMd5(text),
  }
  const result = await postJson(`${LOOMY_ACCOUNT_BASE}${path}`, body, headers, fetchImpl)
  if (result.payload === undefined) {
    throw new LoginError(`登录服务返回了无法解析的响应（HTTP ${result.status}）`, `HTTP_${result.status}`)
  }
  const code = typeof result.payload.code === 'string'
    ? result.payload.code
    : typeof result.payload.code === 'number' ? String(result.payload.code) : ''
  if (code !== '' && code !== '000000' && code !== '0') {
    const description = typeof result.payload.desc === 'string' && result.payload.desc.length > 0
      ? result.payload.desc
      : typeof result.payload.message === 'string' && result.payload.message.length > 0
        ? result.payload.message
        : `错误码 ${code}`
    throw new LoginError(loomyMessage(code, description), code)
  }
  if (result.status >= 400) {
    throw new LoginError(`登录服务返回 HTTP ${result.status}`, `HTTP_${result.status}`)
  }
  const data = result.payload.data
  return data !== null && typeof data === 'object' && !Array.isArray(data)
    ? data as Record<string, unknown>
    : result.payload
}

function loomyMessage(code: string, description: string): string {
  if (code === '220204') return '手机号或密码错误。'
  if (code === '100002') return '短信验证码错误或已过期，请重新获取。'
  if (code === '100001') return '登录请求过于频繁，请稍后再试。'
  return `Loomy 登录失败：${description}`
}

export interface LoomyLoginResult {
  session: string
  userId?: string
  phone?: string
  name?: string
}

function loomyEnvelope(deviceId: string): Record<string, unknown> {
  return {
    base: {
      appid: 'GM3LOOMY',
      modelid: 'Web',
      version: '1.0.0',
      devid: deviceId,
      ua: 'Loomy|Desktop|Electron|macOS',
      traceid: randomUUID().replace(/-/g, ''),
    },
  }
}

/** Encrypt the password the way the client does: RSA PKCS#1 v1.5, base64. */
export function loomyEncryptPassword(publicKeyBase64: string, password: string): string {
  const lines = publicKeyBase64.match(/.{1,64}/g)?.join('\n') ?? publicKeyBase64
  const pem = `-----BEGIN PUBLIC KEY-----\n${lines}\n-----END PUBLIC KEY-----`
  try {
    return publicEncrypt({ key: pem, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(password, 'utf8'))
      .toString('base64')
  } catch {
    throw new LoginError('密码过长或登录服务公钥不可用，无法加密提交。', 'RSA_ENCRYPT_FAILED')
  }
}

function textField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

export async function loomyLoginWithPassword(
  input: { phone: string, password: string, deviceId: string, fetchImpl?: typeof fetch },
): Promise<LoomyLoginResult> {
  const fetchImpl = input.fetchImpl ?? fetch
  const envelope = loomyEnvelope(input.deviceId)
  const key = await loomyAccountCall('/login/account/getPuKey', envelope, fetchImpl)
  const pukey = textField(key.pukey)
  const rcode = textField(key.rcode)
  if (pukey === undefined || rcode === undefined) {
    throw new LoginError('Loomy 登录服务没有返回可用公钥，请稍后重试。', 'NO_PUKEY')
  }
  const data = await loomyAccountCall('/login/account/byPwd', {
    ...envelope,
    param: {
      loginid: input.phone,
      password: loomyEncryptPassword(pukey, input.password),
      rcode,
      type: 1,
      expire: Math.floor(LOOMY_SESSION_TTL_MS / 1000),
    },
  }, fetchImpl)
  return loomySession(data)
}

export async function loomySendSmsCode(
  input: { phone: string, deviceId: string, fetchImpl?: typeof fetch },
): Promise<{ msgid: string }> {
  const fetchImpl = input.fetchImpl ?? fetch
  const data = await loomyAccountCall('/login/phone/sendMsgCode', {
    ...loomyEnvelope(input.deviceId),
    param: { ccode: '86', phone: input.phone, expire: 300 },
  }, fetchImpl)
  const msgid = textField(data.msgid)
  if (msgid === undefined) throw new LoginError('Loomy 没有返回短信消息 ID，请稍后重试。', 'NO_MSGID')
  return { msgid }
}

export async function loomyLoginWithSms(
  input: { phone: string, code: string, msgid: string, deviceId: string, fetchImpl?: typeof fetch },
): Promise<LoomyLoginResult> {
  const fetchImpl = input.fetchImpl ?? fetch
  const data = await loomyAccountCall('/login/phone/checkCode', {
    ...loomyEnvelope(input.deviceId),
    param: {
      ccode: '86',
      phone: input.phone,
      mcode: input.code,
      msgid: input.msgid,
      expire: Math.floor(LOOMY_SESSION_TTL_MS / 1000),
    },
  }, fetchImpl)
  return loomySession(data)
}

function loomySession(data: Record<string, unknown>): LoomyLoginResult {
  const session = textField(data.session)
  if (session === undefined) {
    throw new LoginError('Loomy 登录成功但没有返回会话，请重试。', 'NO_SESSION')
  }
  return {
    session,
    ...textField(data.userid) === undefined ? {} : { userId: textField(data.userid)! },
    ...textField(data.phone) === undefined ? {} : { phone: textField(data.phone)! },
  }
}

/** Display name for the account card; failures are not login failures. */
export async function loomyAccountName(
  input: { session: string, deviceId: string, fetchImpl?: typeof fetch },
): Promise<string | undefined> {
  const fetchImpl = input.fetchImpl ?? fetch
  try {
    const data = await loomyAccountCall('/userinfo/query/baseInfo', {
      ...loomyEnvelope(input.deviceId),
      param: { session: input.session },
    }, fetchImpl)
    return firstText(data, ['nickname', 'nickName', 'name', 'userName'])
  } catch {
    return undefined
  }
}

function firstText(value: unknown, keys: readonly string[], depth = 0): string | undefined {
  if (value === null || typeof value !== 'object' || depth > 3) return undefined
  const recordValue = value as Record<string, unknown>
  for (const key of keys) {
    const candidate = recordValue[key]
    if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate.trim()
  }
  for (const candidate of Object.values(recordValue)) {
    const nested = firstText(candidate, keys, depth + 1)
    if (nested !== undefined) return nested
  }
  return undefined
}

/** AES-128-CFB with a random IV, exactly as the Raccoon web client encrypts. */
export function raccoonEncrypt(value: string): string {
  const iv = randomBytes(16)
  const cipher = createCipheriv('aes-128-cfb', Buffer.from(RACCOON_AES_KEY, 'utf8'), iv)
  const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return Buffer.concat([iv, body]).toString('base64')
}

export interface RaccoonLoginResult {
  accessToken: string
  refreshToken?: string
  name?: string
  phone?: string
  ownerType?: string
}

function raccoonError(payload: Record<string, unknown> | undefined, status: number): LoginError {
  const code = payload?.code
  const message = typeof payload?.message === 'string' && payload.message.length > 0
    ? payload.message
    : typeof payload?.details === 'string' && payload.details.length > 0
      ? payload.details
      : `HTTP ${status}`
  if (code === 200004 || message.includes('phone_or_password')) return new LoginError('手机号或密码错误。', 'BAD_CREDENTIALS')
  if (code === 100002) return new LoginError('登录参数被上游拒绝，请确认手机号与密码格式。', 'PARAMS')
  if (code === 1000007) return new LoginError('登录尝试过于频繁，请稍后再试。', 'RATE_LIMIT')
  return new LoginError(`小浣熊登录失败：${message}`, String(code ?? status))
}

export async function raccoonLoginWithPassword(
  input: { phone: string, password: string, fetchImpl?: typeof fetch },
): Promise<RaccoonLoginResult> {
  const fetchImpl = input.fetchImpl ?? fetch
  const result = await postJson(`${RACCOON_WEB_BASE}/auth/v1/login_with_password`, {
    nation_code: '86',
    phone: raccoonEncrypt(input.phone),
    password: raccoonEncrypt(input.password),
  }, {}, fetchImpl)
  const payload = result.payload
  if (payload === undefined) {
    throw new LoginError(`小浣熊登录服务返回了无法解析的响应（HTTP ${result.status}）`, `HTTP_${result.status}`)
  }
  if (payload.code !== 0 || result.status >= 400) throw raccoonError(payload, result.status)
  const data = payload.data !== null && typeof payload.data === 'object' && !Array.isArray(payload.data)
    ? payload.data as Record<string, unknown>
    : {}
  const accessToken = textField(data.access_token)
  if (accessToken === undefined) {
    throw new LoginError('小浣熊登录成功但没有返回访问令牌，请重试。', 'NO_TOKEN')
  }
  return {
    accessToken,
    ...textField(data.refresh_token) === undefined ? {} : { refreshToken: textField(data.refresh_token)! },
  }
}

/** Non-secret account facts for the card; failures are ignored. */
export async function raccoonAccountInfo(
  input: { accessToken: string, fetchImpl?: typeof fetch },
): Promise<{ name?: string, phone?: string, ownerType?: string }> {
  const fetchImpl = input.fetchImpl ?? fetch
  try {
    const response = await fetchImpl(`${RACCOON_WEB_BASE}/auth/v1/user_info`, {
      method: 'GET',
      headers: { ...attributionHeaders(), accept: 'application/json', authorization: `Bearer ${input.accessToken}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!response.ok) return {}
    const payload = parseJson(await response.text())
    const data = payload?.data !== null && typeof payload?.data === 'object' && !Array.isArray(payload?.data)
      ? payload.data as Record<string, unknown>
      : {}
    return {
      ...textField(data.name) === undefined && textField(data.nickname) === undefined
        ? {}
        : { name: textField(data.name) ?? textField(data.nickname)! },
      ...textField(data.phone) === undefined ? {} : { phone: textField(data.phone)! },
      ...textField(data.owner_type) === undefined ? {} : { ownerType: textField(data.owner_type)! },
    }
  } catch {
    return {}
  }
}
