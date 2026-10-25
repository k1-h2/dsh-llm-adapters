import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

interface ClientExports {
  apply: unknown
  inject: string[]
  name: string
  __test: {
    BRANDS: { id: string }[]
    FIELDS: Record<string, Record<string, string>>
    zh: Record<string, unknown>
    en: Record<string, unknown>
    css: Record<string, Record<string, unknown>>
    windowLabel: (value: number) => string
    creditsOf: (value: number) => string
    priceText: (t: (key: string) => string, factor: number) => string
    ownerLabel: (t: (key: string) => string, owner: string) => string
    dateLabel: (value: number) => string
  }
}

function loadClient(): ClientExports {
  const source = readFileSync(path.join(process.cwd(), 'client.js'), 'utf8')
  let definition: { factory: (require: (id: string) => unknown) => ClientExports } | undefined
  const window = {
    __ModuleLoader__: {
      load(value: typeof definition) { definition = value },
    },
  }
  const document = { baseURI: 'http://127.0.0.1:3080/' }
  const React = {
    createElement: () => null,
    useState: () => undefined,
    useEffect: () => undefined,
    useCallback: () => undefined,
    useMemo: () => undefined,
    useRef: () => undefined,
    useSyncExternalStore: () => undefined,
  }
  const run = new Function('window', 'document', source)
  run(window, document)
  if (definition === undefined) throw new Error('client bundle did not register')
  return definition.factory(() => React)
}

describe('client bundle', () => {
  const exports = loadClient()

  it('declares the two settings sections and matching config fields', () => {
    expect(exports.name).toBe('dsh-llm-adapters')
    expect(exports.inject).toEqual(['slots', 'locale', 'configForms'])
    expect(exports.__test.BRANDS.map(brand => brand.id)).toEqual(['loomy', 'raccoon'])
    expect(exports.__test.FIELDS.loomy.enabled).toBe('loomyEnabled')
    expect(exports.__test.FIELDS.raccoon.enabled).toBe('raccoonEnabled')
  })

  it('has the same top-level copy keys in Chinese and English', () => {
    expect(Object.keys(exports.__test.zh).sort()).toEqual(Object.keys(exports.__test.en).sort())
  })

  it('ships browser sign-in copy for both providers', () => {
    expect(exports.__test.zh.browserOpen).toBe('打开浏览器登录')
    expect(exports.__test.zh.sourceAccount).toBe('插件账号登录')
    expect(exports.__test.zh.browserPolling).toContain('自动接回')
    expect(exports.__test.en.browserOpen).toBe('Open browser to sign in')
    expect(exports.__test.en.sourceAccount).toBe('Plugin account')
    expect(exports.__test.zh.loginSubmit).toBeUndefined()
  })

  it('keeps the primary button dark with white text on both themes', () => {
    expect(exports.__test.css.btnPrimary).toMatchObject({ background: '#0b0b0b', color: '#fff' })
  })

  it('formats windows, credits and prices for the cards', () => {
    expect(exports.__test.windowLabel(1_000_000)).toBe('1M')
    expect(exports.__test.windowLabel(256_000)).toBe('256K')
    expect(exports.__test.windowLabel(999)).toBe('999')
    expect(exports.__test.creditsOf(1234.5)).toContain('1,234.5')
    expect(exports.__test.priceText(() => '免费', 0)).toBe('免费')
    expect(exports.__test.priceText(() => '免费', 0.75)).toBe('x0.75')
    expect(exports.__test.priceText(() => '免费', undefined as never)).toBe('')
    const ownerText = (key: string) => key === 'ownerEnterprise' ? '企业' : '个人'
    expect(exports.__test.ownerLabel(ownerText, 'users')).toBe('个人')
    expect(exports.__test.ownerLabel(ownerText, 'org')).toBe('企业')
  })
})
