import { describe, expect, it, vi } from 'vitest'
import {
  BrowserLoginFlow, browserCandidates, tokensFromAuthResponses,
} from '../src/browser-login.ts'
import type { BrowserDriver, BrowserLauncher } from '../src/browser-login.ts'

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('condition not reached')
}

function fakeDriver(overrides: Partial<BrowserDriver> = {}): BrowserDriver {
  let closed = false
  const driver: BrowserDriver = {
    get closed() { return closed },
    pages: async () => [{ targetId: 'page-1', url: 'https://loomy.xunfei.cn/chat' }],
    attach: async () => 'session-1',
    evaluate: async () => ({ tokens: [], profile: {}, ready: false }),
    cookies: async () => [],
    authResponses: () => [],
    close: async () => { closed = true },
    ...overrides,
  }
  return driver
}

function launcher(driver: BrowserDriver): BrowserLauncher {
  return vi.fn(async () => driver)
}

const spec = {
  hosts: ['xunfei.cn'],
  cookieDomains: ['xunfei.cn'],
  loginUrl: 'https://loomy.xunfei.cn/login',
  probe: 'probe',
  timeoutMs: 2_000,
  resolve: async ({ tokens, profile }: {
    tokens: readonly string[]
    profile?: { name?: string, phone?: string, userId?: string }
  }) => tokens.includes('gateway-session-123456')
    ? {
        token: 'gateway-session-123456',
        ...profile?.name === undefined ? {} : { name: profile.name },
        ...profile?.phone === undefined ? {} : { phone: profile.phone },
        ...profile?.userId === undefined ? {} : { userId: profile.userId },
      }
    : undefined,
  save: async () => undefined,
}

describe('tokensFromAuthResponses', () => {
  it('collects token-ish fields at any depth', () => {
    const tokens = tokensFromAuthResponses([
      { text: JSON.stringify({ data: { access_token: 'access-token-value', refresh_token: 'refresh-token-value' } }) },
      { text: JSON.stringify({ session: 'a-session-value-123' }) },
      { text: 'not json' },
    ])
    expect(tokens).toContain('access-token-value')
    expect(tokens).toContain('refresh-token-value')
    expect(tokens).toContain('a-session-value-123')
  })

  it('ignores short and whitespace-bearing values', () => {
    expect(tokensFromAuthResponses([{ text: JSON.stringify({ token: 'short', other: 'has space inside value' }) }])).toEqual([])
  })
})

describe('browserCandidates', () => {
  it('puts an explicit path first and knows Windows browser layouts', () => {
    const candidates = browserCandidates('win32', {
      DSH_LLM_ADAPTERS_BROWSER: 'D:\\Browsers\\chrome.exe',
      ProgramFiles: 'C:\\Program Files',
      'ProgramFiles(x86)': 'C:\\Program Files (x86)',
      LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
    })
    expect(candidates[0]).toBe('D:\\Browsers\\chrome.exe')
    expect(candidates.some(entry => entry.endsWith('msedge.exe'))).toBe(true)
    expect(candidates.some(entry => entry.endsWith('chrome.exe'))).toBe(true)
  })

  it('deduplicates candidates', () => {
    const candidates = browserCandidates('linux', {})
    expect(new Set(candidates).size).toBe(candidates.length)
  })
})

describe('BrowserLoginFlow', () => {
  it('adopts the token a signed-in page leaves behind and closes the window', async () => {
    const close = vi.fn(async () => undefined)
    const evaluate = vi.fn(async () => ({
      tokens: ['gateway-session-123456'],
      profile: { name: 'Alice', phone: '13800000000', userId: 'u1' },
      ready: true,
    }))
    const driver = fakeDriver({ evaluate, close })
    const save = vi.fn(async () => undefined)
    const flow = new BrowserLoginFlow({ ...spec, save }, {
      launch: launcher(driver),
      findExecutable: () => 'fake-browser',
      pollMs: 10,
    })
    const started = flow.start()
    expect(started.running).toBe(true)
    expect(started.url).toBe(spec.loginUrl)
    await waitFor(() => flow.status().running === false)
    expect(flow.status()).toMatchObject({ phase: 'done', signedIn: true })
    expect(save).toHaveBeenCalledWith({
      token: 'gateway-session-123456',
      name: 'Alice',
      phone: '13800000000',
      userId: 'u1',
    })
    expect(close).toHaveBeenCalled()
  })

  it('also considers cookies from the provider domain', async () => {
    const evaluate = vi.fn(async () => ({ tokens: [], ready: true }))
    const cookies = vi.fn(async () => [
      { name: 'other', value: 'x'.repeat(32), domain: '.example.com' },
      { name: 'raccoon_token', value: 'gateway-session-123456', domain: '.xunfei.cn' },
    ])
    const driver = fakeDriver({
      pages: async () => [{ targetId: 'p', url: 'https://loomy.xunfei.cn/chat' }],
      evaluate,
      cookies,
    })
    const save = vi.fn(async () => undefined)
    const flow = new BrowserLoginFlow({ ...spec, save }, {
      launch: launcher(driver),
      findExecutable: () => 'fake-browser',
      pollMs: 5,
    })
    flow.start()
    await waitFor(() => flow.status().running === false)
    expect(flow.status()).toMatchObject({ phase: 'done', signedIn: true })
    expect(save).toHaveBeenCalledWith({ token: 'gateway-session-123456' })
  })

  it('reports a timeout when the page never yields a gateway credential', async () => {
    const driver = fakeDriver({ evaluate: async () => ({ tokens: [], ready: true }) })
    const flow = new BrowserLoginFlow({ ...spec, timeoutMs: 40 }, {
      launch: launcher(driver),
      findExecutable: () => 'fake-browser',
      pollMs: 5,
    })
    flow.start()
    await waitFor(() => flow.status().running === false)
    expect(flow.status().phase).toBe('timeout')
    expect(flow.status().error).toContain('没有拿到可用的模型调用凭据')
  })

  it('stops when cancelled', async () => {
    const close = vi.fn(async () => undefined)
    const driver = fakeDriver({ close })
    const flow = new BrowserLoginFlow(spec, {
      launch: launcher(driver),
      findExecutable: () => 'fake-browser',
      pollMs: 5,
    })
    flow.start()
    await waitFor(() => flow.status().phase === 'waiting')
    flow.cancel()
    expect(flow.status()).toMatchObject({ running: false, phase: 'cancelled' })
    await waitFor(() => close.mock.calls.length > 0)
  })

  it('fails with an actionable message when no browser is installed', () => {
    const flow = new BrowserLoginFlow(spec, { findExecutable: () => undefined })
    expect(() => flow.start()).toThrow(/Chromium/)
    expect(flow.status().running).toBe(false)
  })
})
