import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  RaccoonIamError, RaccoonQrLogin, RACCOON_QR_APP_NAME, createRaccoonQr, pollRaccoonQr,
  raccoonQrContent,
} from '../src/raccoon-login.ts'

const logins: RaccoonQrLogin[] = []

afterEach(async () => {
  await Promise.all(logins.splice(0).map(login => login.cancel()))
})

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function ok(data: unknown): Response {
  return json({ code: 'OK', message: 'success', data })
}

function withCookies(body: unknown, cookies: readonly string[]): Response {
  const headers = new Headers({ 'content-type': 'application/json' })
  for (const cookie of cookies) headers.append('set-cookie', cookie)
  return new Response(JSON.stringify(body), { status: 200, headers })
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('condition not met before timeout')
}

async function drivePage(login: RaccoonQrLogin): Promise<void> {
  const url = login.status().url
  if (url === undefined) throw new Error('login page has no URL')
  const status = url.replace(/\/login$/, '/status')
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    const payload = await (await fetch(status)).json() as { phase?: string }
    if (['done', 'error', 'cancelled', 'expired'].includes(payload.phase ?? '')) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('login page did not settle')
}

function qrSession(): Response {
  return ok({
    qrcode_code: 'qr-01a1726c-test',
    scan_path: '/login/mp',
    expires_in: 300,
    poll_interval: 2,
    status: 'pending',
  })
}

describe('raccoon QR login', () => {
  it('creates a server-issued QR session', async () => {
    const fetchImpl = vi.fn(async () => qrSession())
    const session = await createRaccoonQr(fetchImpl as unknown as typeof fetch)
    expect(session).toEqual({
      code: 'qr-01a1726c-test',
      scanPath: '/login/mp',
      expiresIn: 300,
      pollInterval: 2,
    })
    const request = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(String(request[0])).toBe('https://xiaohuanxiong.com/api/iam/v1/auth/mp/qrcode')
    expect(request[1].method).toBe('POST')
    expect(request[1].body).toBe('{}')
  })

  it('rejects a QR session with an unusable scan path', async () => {
    const fetchImpl = vi.fn(async () => ok({
      qrcode_code: 'qr-1',
      scan_path: '//evil.example/login',
      expires_in: 300,
      poll_interval: 2,
    }))
    const error = await createRaccoonQr(fetchImpl as unknown as typeof fetch).catch(reason => reason)
    expect(error).toBeInstanceOf(RaccoonIamError)
    expect((error as RaccoonIamError).code).toBe('INVALID_RESPONSE')
  })

  it('encodes the same landing URL as the website', () => {
    const content = raccoonQrContent({
      code: 'qr-01a1726c-test',
      scanPath: '/login/mp',
      expiresIn: 300,
      pollInterval: 2,
    })
    const url = new URL(content)
    expect(url.origin).toBe('https://xiaohuanxiong.com')
    expect(url.pathname).toBe('/login/mp')
    expect(url.searchParams.get('code')).toBe('qr-01a1726c-test')
    expect(url.searchParams.get('appname')).toBe(RACCOON_QR_APP_NAME)
    expect(url.searchParams.get('source')).toBe('platform')
  })

  it('maps pending, scanned and success polls', async () => {
    const responses = [
      ok({ status: 'pending', expires_in: 299, poll_interval: 2 }),
      ok({ status: 'logging', expires_in: 298, poll_interval: 2 }),
      ok({
        status: 'success',
        access_token: 'a',
        refresh_token: 'r',
        token_type: 'Bearer',
        expires_in: 297,
        poll_interval: 2,
      }),
    ]
    let index = 0
    const fetchImpl = vi.fn(async () => responses[index++]!)
    expect(await pollRaccoonQr('c', fetchImpl)).toEqual({
      status: 'pending', expiresIn: 299, pollInterval: 2,
    })
    expect(await pollRaccoonQr('c', fetchImpl)).toEqual({
      status: 'logging', expiresIn: 298, pollInterval: 2,
    })
    expect(await pollRaccoonQr('c', fetchImpl)).toEqual({
      status: 'success',
      accessToken: 'a',
      refreshToken: 'r',
      expiresIn: 297,
      pollInterval: 2,
    })
    const request = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(String(request[0])).toContain('/api/iam/v1/auth/mp/qrcode/login')
    expect(JSON.parse(String(request[1].body))).toEqual({ qrcode_code: 'c' })
  })

  it('reports an expired code instead of polling forever', async () => {
    const fetchImpl = vi.fn(async () => json({ code: 'AUTH_QRCODE_EXPIRED', message: '二维码已过期' }, 400))
    const polled = await pollRaccoonQr('c', fetchImpl)
    expect(polled.status).toBe('expired')
    expect(polled.message).toContain('二维码已过期')
  })

  it('keeps network failures pending but reports malformed results', async () => {
    expect(await pollRaccoonQr('c', async () => { throw new Error('offline') })).toEqual({ status: 'pending' })
    const empty = await pollRaccoonQr('c', async () => json({ code: 'OK' }))
    expect(empty.status).toBe('error')
    const noToken = await pollRaccoonQr('c', async () => ok({ status: 'success', token_type: 'Bearer' }))
    expect(noToken.status).toBe('error')
    const wrongType = await pollRaccoonQr('c', async () => ok({
      status: 'success', access_token: 'a', token_type: 'mac',
    }))
    expect(wrongType.status).toBe('error')
  })

  it('confirms the business session, validates the token, and saves the account', async () => {
    let polls = 0
    const calls: string[] = []
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/api/iam/v1/auth/mp/qrcode')) {
        calls.push('create')
        return qrSession()
      }
      if (url.endsWith('/api/iam/v1/auth/mp/qrcode/login')) {
        polls += 1
        calls.push('poll')
        return polls === 1
          ? ok({ status: 'pending', expires_in: 299, poll_interval: 2 })
          : ok({
              status: 'success',
              access_token: 'access-token',
              refresh_token: 'refresh-token',
              token_type: 'Bearer',
              expires_in: 298,
              poll_interval: 2,
            })
      }
      if (url.endsWith('/api/web/auth/v1/iam/confirm')) {
        calls.push('confirm')
        expect(init?.headers).toMatchObject({ authorization: 'Bearer access-token' })
        return json({ code: 0, message: 'success' })
      }
      if (url.endsWith('/api/web/auth/v1/user_info')) {
        calls.push('userinfo')
        return json({ code: 0, data: { name: 'Tester', phone: '13800138000', owner_type: 'personal' } })
      }
      throw new Error(`unexpected request ${url}`)
    })
    const validate = vi.fn(async () => true)
    const save = vi.fn(async () => undefined)
    const login = new RaccoonQrLogin({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      validate,
      save,
    })
    logins.push(login)

    const start = await login.start()
    expect(start.running).toBe(true)
    expect(start.url).toContain('127.0.0.1')
    const page = await (await fetch(start.url!)).text()
    expect(page).toContain('微信扫码登录 Raccoon')
    expect(page).toContain('<svg')

    await drivePage(login)
    await waitFor(() => login.status().phase === 'done')
    expect(calls).toContain('confirm')
    expect(validate).toHaveBeenCalledWith('access-token')
    expect(save).toHaveBeenCalledWith({
      token: 'access-token',
      refreshToken: 'refresh-token',
      name: 'Tester',
      phone: '13800138000',
      ownerType: 'personal',
    })
  })

  it('adopts the business token from the confirm response cookie', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/api/iam/v1/auth/mp/qrcode')) return qrSession()
      if (url.endsWith('/api/iam/v1/auth/mp/qrcode/login')) {
        return ok({ status: 'success', access_token: 'iam-token', token_type: 'Bearer', expires_in: 298, poll_interval: 2 })
      }
      if (url.endsWith('/api/web/auth/v1/iam/confirm')) {
        return withCookies({ code: 0 }, [
          'xhx_token=business-token; Path=/; HttpOnly',
          'raccoon_refresh_token=business-refresh; Path=/; HttpOnly',
        ])
      }
      if (url.endsWith('/api/web/auth/v1/user_info')) {
        return json({ code: 0, data: { name: 'Tester' } })
      }
      throw new Error(`unexpected request ${url}`)
    })
    const validate = vi.fn(async (token: string) => token === 'business-token')
    const save = vi.fn(async () => undefined)
    const login = new RaccoonQrLogin({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      validate,
      save,
    })
    logins.push(login)
    await login.start()
    await drivePage(login)
    await waitFor(() => login.status().phase === 'done')
    expect(validate).toHaveBeenCalledWith('business-token')
    expect(save).toHaveBeenCalledWith({
      token: 'business-token',
      refreshToken: 'business-refresh',
      name: 'Tester',
    })
  })

  it('does not save a token the model gateway rejects', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/api/iam/v1/auth/mp/qrcode')) return qrSession()
      if (url.endsWith('/api/iam/v1/auth/mp/qrcode/login')) {
        return ok({ status: 'success', access_token: 'rejected', token_type: 'Bearer', expires_in: 298, poll_interval: 2 })
      }
      if (url.endsWith('/api/web/auth/v1/iam/confirm')) return json({ code: 0 })
      throw new Error(`unexpected request ${url}`)
    })
    const save = vi.fn(async () => undefined)
    const login = new RaccoonQrLogin({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      validate: async () => false,
      save,
    })
    logins.push(login)
    await login.start()
    await drivePage(login)
    await waitFor(() => login.status().phase === 'error')
    expect(login.status().error).toContain('模型网关')
    expect(save).not.toHaveBeenCalled()
  })

  it('stops when the user cancels on the phone', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/api/iam/v1/auth/mp/qrcode')) return qrSession()
      if (url.endsWith('/api/iam/v1/auth/mp/qrcode/login')) return ok({ status: 'canceled' })
      throw new Error(`unexpected request ${url}`)
    })
    const save = vi.fn(async () => undefined)
    const login = new RaccoonQrLogin({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      validate: async () => true,
      save,
    })
    logins.push(login)
    await login.start()
    await drivePage(login)
    await waitFor(() => login.status().phase === 'cancelled')
    expect(save).not.toHaveBeenCalled()
  })
})
