import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { LoomyAuth, RaccoonAuth, decodeJwtFacts } from '../src/auth.ts'
import { AccountStore } from '../src/account-store.ts'

function jwt(expiresAt: number, extras: Record<string, unknown> = {}): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify({ exp: Math.floor(expiresAt / 1000), ...extras })).toString('base64url')
  return `${header}.${body}.sig`
}

function store(): AccountStore {
  const root = mkdtempSync(path.join(tmpdir(), 'llm-adapters-auth-'))
  return new AccountStore(() => root)
}

describe('LoomyAuth', () => {
  it('reports the stored account and returns its session', async () => {
    const accounts = store()
    await accounts.saveLoomy({
      session: 'account-session',
      deviceId: 'web-1',
      loginAt: 1,
      expiresAt: Date.now() + 3600_000,
      name: 'Alice',
      phone: '13800000000',
      userId: 'u1',
    })
    const auth = new LoomyAuth(accounts)
    expect(await auth.status()).toEqual({
      signedIn: true,
      loginAt: 1,
      expiresAt: expect.any(Number),
      account: { name: 'Alice', phone: '13800000000', userId: 'u1' },
    })
    expect(await auth.session()).toBe('account-session')
  })

  it('treats an expired session as signed out but keeps the account visible', async () => {
    const accounts = store()
    await accounts.saveLoomy({
      session: 'old-session',
      deviceId: 'web-1',
      loginAt: 1,
      expiresAt: Date.now() - 1_000,
      name: 'Alice',
    })
    const status = await new LoomyAuth(accounts).status()
    expect(status.signedIn).toBe(false)
    expect(status.possiblyExpired).toBe(true)
    expect(status.account?.name).toBe('Alice')
    expect(status.error).toContain('过期')
  })

  it('reports signed out when nothing is stored and clears on logout', async () => {
    const accounts = store()
    const auth = new LoomyAuth(accounts)
    expect((await auth.status()).signedIn).toBe(false)
    expect(await auth.session()).toBeUndefined()

    await accounts.saveLoomy({
      session: 'account-session',
      deviceId: 'web-1',
      loginAt: 1,
      expiresAt: Date.now() + 3600_000,
    })
    await auth.logout()
    expect(await auth.session()).toBeUndefined()
    expect((await auth.status()).signedIn).toBe(false)
  })
})

describe('decodeJwtFacts', () => {
  it('reads only display-safe claims', () => {
    expect(decodeJwtFacts(jwt(Date.now() + 60_000, {
      name: 'Bob', owner_type: 'users', sid: 'web1',
    }))).toMatchObject({ name: 'Bob', ownerType: 'users', sessionId: 'web1' })
    expect(decodeJwtFacts('not-a-jwt')).toEqual({})
  })
})

describe('RaccoonAuth', () => {
  it('reports the stored account and the token expiry', async () => {
    const accounts = store()
    const expiresAt = Date.now() + 30 * 24 * 3600_000
    await accounts.saveRaccoon({
      accessToken: jwt(expiresAt),
      loginAt: 1,
      name: 'Carol',
      phone: '13900000000',
    })
    const status = await new RaccoonAuth(accounts).status()
    expect(status).toMatchObject({
      signedIn: true,
      loginAt: 1,
      expiresAt: expect.any(Number),
      account: { name: 'Carol', phone: '13900000000', ownerType: 'personal' },
    })
    expect(status.error).toBeUndefined()
  })

  it('asks for a new scan once the token expires', async () => {
    const accounts = store()
    await accounts.saveRaccoon({ accessToken: jwt(Date.now() - 1_000), loginAt: 1 })
    const status = await new RaccoonAuth(accounts).status()
    expect(status.signedIn).toBe(false)
    expect(status.possiblyExpired).toBe(true)
    expect(status.error).toContain('重新扫码')
  })

  it('accepts an opaque token until the gateway rejects it', async () => {
    const accounts = store()
    await accounts.saveRaccoon({
      accessToken: 'opaque-token-1234567890',
      name: 'RaccoonBenjamin',
      phone: '13800138000',
      ownerType: 'personal',
      loginAt: 1,
    })
    const auth = new RaccoonAuth(accounts)
    const status = await auth.status()
    expect(status).toMatchObject({
      signedIn: true,
      account: { name: 'RaccoonBenjamin', phone: '13800138000', ownerType: 'personal' },
    })
    expect(status.expiresAt).toBeUndefined()
    expect(await auth.accessToken()).toBe('opaque-token-1234567890')
  })

  it('returns a healthy token, refuses a forced retry, and refuses an expired one', async () => {
    const accounts = store()
    const healthy = jwt(Date.now() + 3600_000)
    await accounts.saveRaccoon({ accessToken: healthy, loginAt: 1 })
    const auth = new RaccoonAuth(accounts)
    expect(await auth.accessToken()).toBe(healthy)
    await expect(auth.accessToken(true)).rejects.toThrow('失效')

    await accounts.saveRaccoon({ accessToken: jwt(Date.now() - 1_000), loginAt: 1 })
    await expect(auth.accessToken()).rejects.toThrow('过期')
  })

  it('signs out of the stored account', async () => {
    const accounts = store()
    await accounts.saveRaccoon({ accessToken: jwt(Date.now() + 3600_000), loginAt: 1 })
    const auth = new RaccoonAuth(accounts)
    await auth.logout()
    expect((await auth.status()).signedIn).toBe(false)
    await expect(auth.accessToken()).rejects.toThrow('尚未登录')
  })
})
