import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  LoomyQrLogin, buildLoomySigningString, buildLoomyWechatAuthUrl, extractWechatUuid,
  loomyAccountHeaders, pollLoomyWechat,
} from '../src/loomy-login.ts'

const logins: LoomyQrLogin[] = []

afterEach(async () => {
  await Promise.all(logins.splice(0).map(login => login.cancel()))
})

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function jpeg(): Response {
  const bytes = new Uint8Array(300)
  bytes[0] = 0xff
  bytes[1] = 0xd8
  bytes[2] = 0xff
  return new Response(bytes, { headers: { 'content-type': 'image/jpeg' } })
}

const AUTH_HTML = '<img class="js_qrcode_img" src="/connect/qrcode/abcdef123?x=1"/>'

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('condition not met before timeout')
}

function statusUrl(login: LoomyQrLogin): string {
  const url = login.status().url
  if (url === undefined) throw new Error('login page has no URL')
  return url.replace(/\/login$/, '/status')
}

async function drivePage(login: LoomyQrLogin, until: string[]): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    const payload = await (await fetch(statusUrl(login))).json() as Record<string, unknown>
    if (typeof payload.phase === 'string' && until.includes(payload.phase)) return payload
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('login page did not reach the expected phase')
}

describe('Loomy QR login', () => {
  it('builds the WeChat authorize URL and extracts the QR uuid', () => {
    const url = buildLoomyWechatAuthUrl('state-1')
    expect(url).toContain('open.weixin.qq.com/connect/qrconnect')
    expect(url).toContain('appid=wx18d60be432287cf8')
    expect(url).toContain('state=state-1')
    expect(decodeURIComponent(url)).toContain('https://loomy.xunfei.cn/oauth/wechat/callback')
    expect(extractWechatUuid(AUTH_HTML)).toBe('abcdef123')
    expect(extractWechatUuid('no code here')).toBe('')
  })

  it('signs nine lines with the account HMAC', () => {
    const body = '{"a":1}'
    const string = buildLoomySigningString({
      accessKeyId: 'ak',
      accessKeySecret: 'secret',
      method: 'post',
      path: '/login/phone/sendMsg',
      body,
      contentType: 'application/json',
      date: 'Mon, 01 Jan 2024 00:00:00 GMT',
      nonce: 'n1',
    })
    expect(string.split('\n')).toHaveLength(9)
    expect(string.endsWith('\n\n')).toBe(true)
    expect(string).toContain(createHash('md5').update(body).digest('base64'))

    const headers = loomyAccountHeaders({ method: 'POST', path: '/x', body })
    expect(headers.authorization).toMatch(/^account 2thryby66wxi53sk:/)
    expect(headers['content-md5']).toBe(createHash('md5').update(body).digest('base64'))
  })

  it('maps WeChat long-poll status codes', async () => {
    expect(await pollLoomyWechat('u', '', async () => new Response("window.wx_errcode=408;window.wx_code='';")))
      .toMatchObject({ status: 'waiting' })
    expect(await pollLoomyWechat('u', '', async () => new Response("window.wx_errcode=404;window.wx_code='';")))
      .toMatchObject({ status: 'scanned' })
    expect(await pollLoomyWechat('u', '', async () => new Response("window.wx_errcode=405;window.wx_code='wx-code';")))
      .toEqual({ status: 'confirmed', code: 'wx-code', errcode: '405' })
    expect(await pollLoomyWechat('u', '', async () => new Response("window.wx_errcode=403;window.wx_code='';")))
      .toMatchObject({ status: 'cancelled' })
    expect(await pollLoomyWechat('u', '', async () => new Response("window.wx_errcode=402;window.wx_code='';")))
      .toMatchObject({ status: 'expired' })
  })

  it('logs in through WeChat when the account already has a phone', async () => {
    let polls = 0
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith('https://open.weixin.qq.com/connect/qrconnect')) return new Response(AUTH_HTML)
      if (url.startsWith('https://open.weixin.qq.com/connect/qrcode/')) return jpeg()
      if (url.startsWith('https://long.open.weixin.qq.com/connect/l/qrconnect')) {
        polls += 1
        if (polls === 1) return new Response("window.wx_errcode=408;window.wx_code='';")
        if (polls === 2) return new Response("window.wx_errcode=404;window.wx_code='';")
        return new Response("window.wx_errcode=405;window.wx_code='wx-code';")
      }
      if (url.endsWith('/login/thirdAccount/bind/auth')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as { param?: { tcode?: { code?: string } } }
        expect(body.param?.tcode?.code).toBe('wx-code')
        return json({ code: '000000', data: { bind: 1, rcode: 'rcode-1', nickname: 'Tester' } })
      }
      if (url.endsWith('/login/thirdAccount/bind/skip')) {
        return json({ code: '000000', data: { session: 's'.repeat(32), userid: 'user-1' } })
      }
      throw new Error(`unexpected request ${url}`)
    })
    const save = vi.fn(async () => undefined)
    const login = new LoomyQrLogin({ fetchImpl: fetchImpl as unknown as typeof fetch, save })
    logins.push(login)

    const start = await login.start()
    const page = await (await fetch(start.url!)).text()
    expect(page).toContain('使用微信扫码登录 Loomy')

    await drivePage(login, ['done', 'error', 'binding', 'cancelled', 'expired'])
    await waitFor(() => login.status().phase === 'done')
    expect(save).toHaveBeenCalledWith({
      token: 's'.repeat(32),
      userId: 'user-1',
      name: 'Tester',
    })
  })

  it('binds a phone when the WeChat account is new', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith('https://open.weixin.qq.com/connect/qrconnect')) return new Response(AUTH_HTML)
      if (url.startsWith('https://open.weixin.qq.com/connect/qrcode/')) return jpeg()
      if (url.startsWith('https://long.open.weixin.qq.com/connect/l/qrconnect')) {
        return new Response("window.wx_errcode=405;window.wx_code='wx-code';")
      }
      if (url.endsWith('/login/thirdAccount/bind/auth')) {
        return json({ code: '000000', data: { bind: 0, rcode: 'rcode-1', nickname: 'Newbie' } })
      }
      if (url.endsWith('/login/thirdAccount/bind/sendMsg')) {
        return json({ code: '000000', data: { msgid: 'msg-1' } })
      }
      if (url.endsWith('/login/thirdAccount/bind/checkCode')) {
        return json({
          code: '000000',
          data: { session: 't'.repeat(32), userid: 'user-2', phone: '13800138000' },
        })
      }
      throw new Error(`unexpected request ${url}`)
    })
    const save = vi.fn(async () => undefined)
    const login = new LoomyQrLogin({ fetchImpl: fetchImpl as unknown as typeof fetch, save })
    logins.push(login)
    await login.start()

    await drivePage(login, ['binding'])
    const base = statusUrl(login).replace(/\/status$/, '')
    const send = await fetch(`${base}/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone: '13800138000' }),
    })
    expect(await send.json()).toMatchObject({ ok: true })
    const verify = await fetch(`${base}/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone: '13800138000', code: '123456' }),
    })
    expect(await verify.json()).toMatchObject({ ok: true, done: true })
    await waitFor(() => login.status().phase === 'done')
    expect(save).toHaveBeenCalledWith({
      token: 't'.repeat(32),
      userId: 'user-2',
      phone: '13800138000',
      name: 'Newbie',
    })
  })
})
