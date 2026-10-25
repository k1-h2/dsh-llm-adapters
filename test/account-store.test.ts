import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { AccountStore } from '../src/account-store.ts'

function makeStore(): { store: AccountStore, root: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'llm-adapters-store-'))
  return { store: new AccountStore(() => root), root }
}

const loomy = {
  session: 'loomy-session',
  deviceId: 'web-1234567890abcdef',
  loginAt: 1,
  expiresAt: 2,
  phone: '13800000000',
}

const raccoon = {
  accessToken: 'access-1',
  loginAt: 1,
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('AccountStore', () => {
  it('round-trips both providers and leaves no temp file behind', async () => {
    const { store, root } = makeStore()
    await store.saveLoomy(loomy)
    await store.saveRaccoon(raccoon)
    expect(await store.read()).toEqual({ loomy, raccoon })
    const files = await fs.readdir(root)
    expect(files).toEqual(['accounts.json'])
    const parsed = JSON.parse(await fs.readFile(store.path(), 'utf8')) as Record<string, unknown>
    expect(parsed.loomy).toMatchObject({ session: 'loomy-session', phone: '13800000000' })
    expect(parsed.raccoon).toMatchObject({ accessToken: 'access-1' })
  })

  it('serializes concurrent writes so neither brand is lost', async () => {
    const { store } = makeStore()
    await Promise.all([store.saveLoomy(loomy), store.saveRaccoon(raccoon)])
    const value = await store.read()
    expect(value.loomy?.session).toBe('loomy-session')
    expect(value.raccoon?.accessToken).toBe('access-1')
  })

  it('clears one brand without touching the other', async () => {
    const { store } = makeStore()
    await store.saveLoomy(loomy)
    await store.saveRaccoon(raccoon)
    await store.clear('raccoon')
    const value = await store.read()
    expect(value.loomy).toBeDefined()
    expect(value.raccoon).toBeUndefined()
  })

  it('keeps a generated device id stable across saves', async () => {
    const { store } = makeStore()
    const deviceId = await store.loomyDeviceId()
    expect(deviceId).toMatch(/^web-[0-9a-f]{16}$/)
    await store.saveLoomy({ ...loomy, deviceId })
    expect(await store.loomyDeviceId()).toBe(deviceId)
  })

  it('treats a corrupt or missing file as signed out', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'llm-adapters-bad-'))
    await fs.writeFile(path.join(root, 'accounts.json'), '{not json')
    const store = new AccountStore(() => root)
    expect(await store.read()).toEqual({})
    expect(await store.loomy()).toBeUndefined()
  })

  it('honours DSH_LLM_ADAPTERS_HOME when no root is given', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'llm-adapters-home-'))
    vi.stubEnv('DSH_LLM_ADAPTERS_HOME', root)
    const store = new AccountStore()
    expect(store.path()).toBe(path.join(root, 'accounts.json'))
  })
})
