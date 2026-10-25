import { describe, expect, it, vi } from 'vitest'
import { constants, createDecipheriv, generateKeyPairSync, privateDecrypt } from 'node:crypto'
import {
  LoginError, loomyEncryptPassword, loomyLoginWithPassword, loomyLoginWithSms,
  loomySendSmsCode, loomySignature, loomyStringToSign, raccoonEncrypt, raccoonLoginWithPassword,
} from '../src/login.ts'

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

const keyPair = generateKeyPairSync('rsa', { modulusLength: 1024 })
const publicKeyBase64 = (keyPair.publicKey.export({ type: 'spki', format: 'der' }) as Buffer).toString('base64')

function decryptRaccoon(value: string): string {
  const bytes = Buffer.from(value, 'base64')
  const decipher = createDecipheriv('aes-128-cfb', Buffer.from('senseraccoon2023', 'utf8'), bytes.subarray(0, 16))
  return Buffer.concat([decipher.update(bytes.subarray(16)), decipher.final()]).toString('utf8')
}

describe('Loomy account signing', () => {
  it('builds the nine-line canonical string with escaped path segments', () => {
    const value = loomyStringToSign({
      path: '/login/account/getPuKey',
      body: '{"a":1}',
      date: 'Sun, 25 Oct 2026 00:00:00 GMT',
      nonce: 'n1',
    })
    const lines = value.split('\n')
    expect(lines).toHaveLength(9)
    expect(lines[0]).toBe('POST')
    expect(lines[1]).toBe('/login/account/getPuKey')
    expect(lines[2]).toBe('')
    expect(lines[3]).toMatch(/^[A-Za-z0-9+/]+=*$/)
    expect(lines[4]).toBe('application/json')
    expect(lines[5]).toBe('Sun, 25 Oct 2026 00:00:00 GMT')
    expect(lines[7]).toBe('')
    expect(lines[8]).toBe('')
  })

  it('signs deterministically and encrypts the password with RSA', () => {
    const input = { path: '/x', body: '{}', date: 'd', nonce: 'n' }
    expect(loomySignature(input)).toBe(loomySignature(input))
    const encrypted = Buffer.from(loomyEncryptPassword(publicKeyBase64, 'secret-pass'), 'base64')
    const decrypted = privateDecrypt(
      { key: keyPair.privateKey, padding: constants.RSA_PKCS1_PADDING },
      encrypted,
    ).toString('utf8')
    expect(decrypted).toBe('secret-pass')
  })

  it('logs in with the public key, nonce and encrypted password', async () => {
    const seen: { path: string, body: Record<string, unknown> }[] = []
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(url)).pathname
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      seen.push({ path, body })
      if (path.endsWith('/getPuKey')) {
        return json({ code: '000000', desc: '成功', data: { pukey: publicKeyBase64, rcode: 'rc-1' } })
      }
      const param = body.param as Record<string, unknown>
      const decrypted = privateDecrypt(
        { key: keyPair.privateKey, padding: constants.RSA_PKCS1_PADDING },
        Buffer.from(String(param.password), 'base64'),
      ).toString('utf8')
      expect(decrypted).toBe('Abcdef123456!')
      expect(param.rcode).toBe('rc-1')
      expect(param.loginid).toBe('13800000000')
      expect(param.expire).toBe(14 * 24 * 3600)
      return json({ code: '000000', data: { session: 'session-1', userid: 'u1', phone: '13800000000' } })
    })
    const result = await loomyLoginWithPassword({
      phone: '13800000000',
      password: 'Abcdef123456!',
      deviceId: 'web-abc',
      fetchImpl: fetchMock as unknown as typeof fetch,
    })
    expect(result).toEqual({ session: 'session-1', userId: 'u1', phone: '13800000000' })
    expect(seen.map(entry => entry.path)).toEqual(['/login/account/getPuKey', '/login/account/byPwd'])
    expect((seen[0]!.body.base as Record<string, unknown>).devid).toBe('web-abc')
    expect((seen[0]!.body.base as Record<string, unknown>).traceid).toMatch(/^[0-9a-f]{32}$/)
  })

  it('sends an SMS code and exchanges it for a session', async () => {
    const paths: string[] = []
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname
      paths.push(path)
      if (path.endsWith('/sendMsgCode')) return json({ code: '000000', data: { msgid: 'msg-1' } })
      return json({ code: '000000', data: { session: 'session-2', userid: 'u2' } })
    })
    const fetchImpl = fetchMock as unknown as typeof fetch
    expect(await loomySendSmsCode({ phone: '13800000000', deviceId: 'web-a', fetchImpl })).toEqual({ msgid: 'msg-1' })
    expect(await loomyLoginWithSms({
      phone: '13800000000', code: '123456', msgid: 'msg-1', deviceId: 'web-a', fetchImpl,
    })).toEqual({ session: 'session-2', userId: 'u2' })
    expect(paths).toEqual(['/login/phone/sendMsgCode', '/login/phone/checkCode'])
  })

  it('surfaces the upstream description for wrong credentials', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname
      if (path.endsWith('/getPuKey')) {
        return json({ code: '000000', data: { pukey: publicKeyBase64, rcode: 'r' } })
      }
      return json({ code: '220204', desc: '密码错误' })
    })
    await expect(loomyLoginWithPassword({
      phone: '13800000000',
      password: 'whatever',
      deviceId: 'web-a',
      fetchImpl: fetchMock as unknown as typeof fetch,
    })).rejects.toThrow('手机号或密码错误')
  })
})

describe('Raccoon web login', () => {
  it('encrypts the phone and password the way the web client does', () => {
    const text = '13800000000'
    const encrypted = raccoonEncrypt(text)
    expect(encrypted).not.toContain(text)
    expect(decryptRaccoon(encrypted)).toBe(text)
  })

  it('posts the encrypted pair and returns the token pair', async () => {
    const seen: Record<string, unknown> = {}
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      seen.body = JSON.parse(String(init?.body)) as Record<string, unknown>
      return json({ code: 0, data: { access_token: 'a1', refresh_token: 'r1' } })
    })
    const result = await raccoonLoginWithPassword({
      phone: '13800000000',
      password: 'Abcdef123456!',
      fetchImpl: fetchMock as unknown as typeof fetch,
    })
    expect(result).toEqual({ accessToken: 'a1', refreshToken: 'r1' })
    expect(seen.body).toMatchObject({ nation_code: '86' })
    expect(decryptRaccoon(String((seen.body as Record<string, unknown>).phone))).toBe('13800000000')
    expect(decryptRaccoon(String((seen.body as Record<string, unknown>).password))).toBe('Abcdef123456!')
  })

  it('maps a credential rejection to a stable error code', async () => {
    const fetchMock = vi.fn(async () => json({ code: 200004, message: 'phone_or_password_verify_error' }, 400))
    try {
      await raccoonLoginWithPassword({
        phone: '13800000000',
        password: 'x',
        fetchImpl: fetchMock as unknown as typeof fetch,
      })
      throw new Error('expected a rejection')
    } catch (error) {
      expect(error).toBeInstanceOf(LoginError)
      expect((error as LoginError).code).toBe('BAD_CREDENTIALS')
      expect((error as Error).message).toBe('手机号或密码错误。')
    }
  })
})
