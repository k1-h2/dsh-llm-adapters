import { describe, expect, it, vi } from 'vitest'
import { apply } from '../src/index.ts'

function fakeContext() {
  const routes: string[] = []
  const directories: unknown[][] = []
  const apiPaths: string[] = []
  const disposers: (() => void)[] = []
  const events = new Map<string, (...args: unknown[]) => void>()
  const ctx = {
    llm: {
      registerAdapter(providers: string[]) {
        routes.push(...providers)
        return () => undefined
      },
      registerConfigurableProviders(entries: unknown[]) {
        directories.push(entries)
        return Object.assign(() => undefined, { replace: (next: unknown[]) => { directories.push(next) } })
      },
    },
    inject(names: string[], callback: (scope: Record<string, unknown>) => void) {
      const scope: Record<string, unknown> = {
        effect(fn: () => () => void) {
          const off = fn()
          disposers.push(off)
        },
      }
      if (names.includes('webServer')) {
        scope.webServer = {
          register(route: { path: string }) {
            apiPaths.push(route.path)
            return () => undefined
          },
        }
      }
      if (names.includes('attachments')) scope.attachments = undefined
      callback(scope)
    },
    effect(fn: () => () => void) {
      const off = fn()
      disposers.push(off)
    },
    on(name: string, handler: (...args: unknown[]) => void) { events.set(name, handler) },
    logger: { info: vi.fn(), warn: vi.fn() },
  }
  return { ctx, routes, directories, apiPaths, disposers, events }
}

describe('plugin host wiring', () => {
  it('registers both provider routes, the directory and the settings API', () => {
    const fake = fakeContext()
    apply(fake.ctx as never, {})
    expect(fake.routes).toEqual(['loomy', 'raccoon'])
    expect(fake.directories.at(-1)).toMatchObject([
      { provider: 'loomy', displayName: 'Loomy', settingsNs: 'llm-adapters', settingsPath: [] },
      { provider: 'raccoon', displayName: '商汤小浣熊', settingsNs: 'llm-adapters', settingsPath: [] },
    ])
    expect(fake.apiPaths).toEqual(['/api/llm-adapters'])
    expect(fake.events.has('loader/volatile-update')).toBe(true)
    expect(fake.disposers.length).toBeGreaterThanOrEqual(2)
  })

  it('registers nothing when both providers are switched off', () => {
    const fake = fakeContext()
    apply(fake.ctx as never, { loomyEnabled: false, raccoonEnabled: false })
    expect(fake.routes).toEqual([])
    expect(fake.directories).toEqual([])
    expect(fake.apiPaths).toEqual(['/api/llm-adapters'])
  })

  it('uses configured display names in the provider directory', () => {
    const fake = fakeContext()
    apply(fake.ctx as never, { loomyDisplayName: '讯飞 Loomy', raccoonDisplayName: '小浣熊 Pro' })
    expect(fake.directories.at(-1)).toMatchObject([
      { displayName: '讯飞 Loomy' },
      { displayName: '小浣熊 Pro' },
    ])
  })
})
