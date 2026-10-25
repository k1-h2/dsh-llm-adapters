import { afterEach, describe, expect, it, vi } from 'vitest'
import { RaccoonQrLogin, pollRaccoonQr, raccoonQrContent, raccoonQrCode } from '../src/raccoon-login.ts'

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
    if (payload.phase === 'done' || payload.phase === 'error' || payload.phase === 'cancelled') return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('login page did not settle')
}

describe('raccoon QR login', () => {
  it('builds a 32-hex code and the public landing URL', () => {
    const code = raccoonQrCode()
    expect(code).toMatch(/^\d{13}[0-9a-f]{32}$/)
    const content = raccoonQrContent(code)
    expect(content.startsWith('https://xiaohuanxiong.com/login/mp?')).toBe(true)
    expect(content).toContain(`code=${code}`)
    expect(decodeURIComponent(content)).toContain('小浣熊官网')
  })

  it('maps pending, scanned and success polls', async () => {
    const responses = [
      { code: 0, data: { status: 'pending' } },
      { code: 0, data: { status: 'logging' } },
      { code: 0, data: { status: 'success', access_token: 'a', refresh_token: 'r' } },
    ]
    let index = 0
    const fetchImpl = vi.fn(async () => json(responses[index++]))
    expect(await pollRaccoonQr('c', fetchImpl)).toEqual({ status: 'pending' })
    expect(await pollRaccoonQr('c', fetchImpl)).toEqual({ status: 'logging' })
    expect(await pollRaccoonQr('c', fetchImpl)).toEqual({ status: 'success', accessToken: 'a', refreshToken: 'r' })
    const request = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(String(request[0])).toContain('/api/web/auth/v1/login_with_qrcode_code')
    expect(JSON.parse(String(request[1].body))).toEqual({ qrcode_code: 'c' })
  })

  it('treats malformed responses and network failures as pending', async () => {
    expect(await pollRaccoonQr('c', async () => json({ code: 500 }))).toEqual({ status: 'pending' })
    expect(await pollRaccoonQr('c', async () => json({ code: 0, data: { status: 'success' } }))).toEqual({ status: 'pending' })
    expect(await pollRaccoonQr('c', async () => { throw new Error('offline') })).toEqual({ status: 'pending' })
  })

  it('saves the token pair once the scan succeeds', async () => {
    let polls = 0
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/auth/v1/login_with_qrcode_code')) {
        polls += 1
        return polls === 1
          ? json({ code: 0, data: { status: 'pending' } })
          : json({ code: 0, data: { status: 'success', access_token: 'access-token', refresh_token: 'refresh-token' } })
      }
      if (url.includes('/auth/v1/user_info')) {
        return json({ code: 0, data: { name: 'Tester', phone: '13800138000', owner_type: 'personal' } })
      }
      throw new Error(`unexpected request ${url}`)
    })
    const save = vi.fn(async () => undefined)
    const login = new RaccoonQrLogin({ fetchImpl: fetchImpl as unknown as typeof fetch, save })
    logins.push(login)

    const start = await login.start()
    expect(start.running).toBe(true)
    expect(start.url).toContain('127.0.0.1')

    const page = await (await fetch(start.url!)).text()
    expect(page).toContain('微信扫码登录 Raccoon')

    await drivePage(login)
    await waitFor(() => login.status().phase === 'done')
    expect(save).toHaveBeenCalledWith({
      token: 'access-token',
      refreshToken: 'refresh-token',
      name: 'Tester',
      phone: '13800138000',
      ownerType: 'personal',
    })
  })

  it('stops when the user cancels on the phone', async () => {
    const fetchImpl = vi.fn(async () => json({ code: 0, data: { status: 'canceled' } }))
    const login = new RaccoonQrLogin({ fetchImpl: fetchImpl as unknown as typeof fetch, save: async () => undefined })
    logins.push(login)
    await login.start()
    await drivePage(login)
    await waitFor(() => login.status().phase === 'cancelled')
  })
})
