import { afterEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { LoomyAuth, RaccoonAuth, decodeJwtFacts } from '../src/auth.ts'

function jwt(expiresAt: number, extras: Record<string, unknown> = {}): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify({ exp: Math.floor(expiresAt / 1000), ...extras })).toString('base64url')
  return `${header}.${body}.sig`
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('LoomyAuth', () => {
  it('discovers the newest client session under Public/Loomy', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'loomy-auth-'))
    vi.stubEnv('PUBLIC', root)
    vi.stubEnv('LOCALAPPDATA', path.join(root, 'empty-local'))
    vi.stubEnv('APPDATA', path.join(root, 'empty-roaming'))
    const file = path.join(root, 'Loomy', 'install-a', 'userData', 'auth-session.json')
    await writeJson(file, { session: 'session-a', userid: 'u1', phone: '13800000000', nickname: 'Alice' })
    const auth = new LoomyAuth(() => '')
    const status = await auth.status()
    expect(status).toMatchObject({
      signedIn: true,
      source: file,
      account: { phone: '13800000000', name: 'Alice', userId: 'u1' },
    })
    expect(await auth.session()).toBe('session-a')
    expect(status.expiryEstimated).toBe(true)
  })

  it('prefers the explicit path and admits a missing file', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'loomy-explicit-'))
    const file = path.join(root, 'auth.json')
    await writeJson(file, { session: 'explicit-session' })
    const auth = new LoomyAuth(() => file)
    expect((await auth.status()).signedIn).toBe(true)
    expect(await auth.session()).toBe('explicit-session')

    const missing = new LoomyAuth(() => path.join(root, 'nope.json'))
    const status = await missing.status()
    expect(status.signedIn).toBe(false)
    expect(status.error).toContain('登录态')
  })

  it('treats an old file as a possibly expired session', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'loomy-old-'))
    const file = path.join(root, 'auth-session.json')
    await writeJson(file, { session: 'old-session' })
    const old = new Date(Date.now() - 15 * 24 * 3600 * 1000)
    await fs.utimes(file, old, old)
    const status = await new LoomyAuth(() => file).status()
    expect(status.possiblyExpired).toBe(true)
    expect(status.expiresAt).toBeLessThan(Date.now())
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
  it('reports signed-in account and refresh needs from the local auth file', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'raccoon-status-'))
    vi.stubEnv('BOX_AGENT_CONFIG_DIR', root)
    await writeJson(path.join(root, 'auth.json'), {
      access_token: jwt(Date.now() + 3600_000, { name: 'Carol', owner_type: 'users' }),
      refresh_token: jwt(Date.now() + 30 * 24 * 3600_000),
    })
    const status = await new RaccoonAuth(() => '').status()
    expect(status).toMatchObject({
      signedIn: true,
      account: { name: 'Carol', ownerType: 'users' },
    })
    expect(status.needsRefresh).toBe(false)
  })

  it('reports a refreshable expired access token', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'raccoon-expired-'))
    vi.stubEnv('BOX_AGENT_CONFIG_DIR', root)
    await writeJson(path.join(root, 'auth.json'), {
      access_token: jwt(Date.now() - 1000),
      refresh_token: jwt(Date.now() + 3600_000),
    })
    const status = await new RaccoonAuth(() => '').status()
    expect(status.signedIn).toBe(true)
    expect(status.needsRefresh).toBe(true)
    expect(status.possiblyExpired).toBeUndefined()
  })

  it('refreshes a single-use token and writes the rotated pair back atomically', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'raccoon-refresh-'))
    vi.stubEnv('BOX_AGENT_CONFIG_DIR', root)
    const file = path.join(root, 'auth.json')
    const oldRefresh = jwt(Date.now() + 3600_000)
    await writeJson(file, {
      access_token: jwt(Date.now() - 1000),
      refresh_token: oldRefresh,
      office_identity: 'personal',
    })
    const nextAccess = jwt(Date.now() + 3 * 3600_000)
    const nextRefresh = jwt(Date.now() + 30 * 24 * 3600_000)
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({ refresh_token: oldRefresh })
      return new Response(JSON.stringify({
        code: 0,
        data: { access_token: nextAccess, refresh_token: nextRefresh },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetchMock)

    expect(await new RaccoonAuth(() => '').accessToken()).toBe(nextAccess)
    expect(fetchMock).toHaveBeenCalledOnce()
    const stored = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>
    expect(stored.access_token).toBe(nextAccess)
    expect(stored.refresh_token).toBe(nextRefresh)
    expect(stored.office_identity).toBe('personal')
  })

  it('does not touch the file when the access token is healthy', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'raccoon-healthy-'))
    vi.stubEnv('BOX_AGENT_CONFIG_DIR', root)
    const file = path.join(root, 'auth.json')
    const access = jwt(Date.now() + 3600_000)
    await writeJson(file, { access_token: access, refresh_token: jwt(Date.now() + 3600_000) })
    const before = await fs.stat(file)
    vi.stubGlobal('fetch', vi.fn())
    expect(await new RaccoonAuth(() => '').accessToken()).toBe(access)
    expect(fetch).not.toHaveBeenCalled()
    expect((await fs.stat(file)).mtimeMs).toBe(before.mtimeMs)
  })

  it('does not retry a conflicted refresh token', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'raccoon-conflict-'))
    vi.stubEnv('BOX_AGENT_CONFIG_DIR', root)
    await writeJson(path.join(root, 'auth.json'), {
      access_token: jwt(Date.now() - 1000),
      refresh_token: jwt(Date.now() + 3600_000),
    })
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      code: 200822,
      message: 'refresh_conflict',
    }), { status: 400, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(new RaccoonAuth(() => '').accessToken()).rejects.toThrow('刷新令牌')
    expect(fetchMock).toHaveBeenCalledOnce()
  })
})
