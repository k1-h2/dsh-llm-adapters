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
    OPENROUTER_INTERVALS: { value: number, labelKey: string }[]
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

  it('declares one settings section per provider and matching config fields', () => {
    expect(exports.name).toBe('dsh-llm-adapters')
    expect(exports.inject).toEqual(['slots', 'locale', 'configForms'])
    expect(exports.__test.BRANDS.map(brand => brand.id)).toEqual(['loomy', 'raccoon', 'trae'])
    expect(exports.__test.FIELDS.loomy.enabled).toBe('loomyEnabled')
    expect(exports.__test.FIELDS.raccoon.enabled).toBe('raccoonEnabled')
    expect(exports.__test.FIELDS.trae.enabled).toBe('traeEnabled')
    expect(exports.__test.FIELDS.trae.region).toBe('traeRegion')
  })

  it('keeps Trae as one card with a region switch and a check-in button', () => {
    const { zh, en, REGIONS, regionOf } = exports.__test as unknown as {
      zh: Record<string, string>
      en: Record<string, string>
      REGIONS: { id: string }[]
      regionOf: (value: unknown) => string
    }
    expect(REGIONS.map(region => region.id)).toEqual(['cn', 'global'])
    expect(regionOf('global')).toBe('global')
    expect(regionOf(undefined)).toBe('cn')
    expect(regionOf('mars')).toBe('cn')
    expect(zh.regionCn).toContain('trae.cn')
    expect(zh.regionGlobal).toContain('trae.ai')
    expect(en.regionCn).toContain('trae.cn')
    expect(zh.checkinClaim).toBe('签到领积分')
    expect(zh.checkinClaimed).toBe('今日已签到')
    // The device flag and the account flag must never share a label.
    expect(zh.checkinDevice).not.toBe(zh.checkinClaimed)
    expect(zh.browserOpenTrae).toBe('打开浏览器登录')
    expect(zh.packUsage).toBe('已用 / 总额')
    // Collapsed is the default: one summary row plus a details toggle.
    expect(zh.packNearest).toBe('最近到期')
    expect(zh.packDetail).toBe('详细信息')
    expect(zh.packCollapse).toBe('收起')
    expect(zh.packExpand).toBeUndefined()
    expect(en.packUsage).toBe('used / total')
  })

  it('has the same top-level copy keys in Chinese and English', () => {
    expect(Object.keys(exports.__test.zh).sort()).toEqual(Object.keys(exports.__test.en).sort())
  })

  it('ships QR sign-in copy without a desktop credential path', () => {
    expect(exports.__test.zh.browserOpen).toBe('打开扫码登录')
    expect(exports.__test.zh.browserPolling).toContain('自动接回')
    expect(exports.__test.en.browserOpen).toBe('Open QR sign-in')
    expect(exports.__test.zh.loginSubmit).toBeUndefined()
    expect(exports.__test.zh.authFile).toBeUndefined()
    expect(exports.__test.zh.loginFileSourceNote).toBeUndefined()
    expect(exports.__test.zh.advancedFields.authFile).toBeUndefined()
  })

  it('exposes the OpenRouter sync choices in both languages', () => {
    const { zh, en, OPENROUTER_INTERVALS } = exports.__test
    expect(OPENROUTER_INTERVALS.map(option => option.value)).toEqual([0, 15, 60, 360, 1440])
    expect(zh.openRouterSyncNow).toBe('立即同步')
    expect(en.openRouterSyncNow).toBe('Sync now')
    expect(zh.openRouterOff).toBe('关闭自动同步')
    expect(zh.openRouterSyncFailed).toBe('同步失败')
    expect(en.openRouterSyncFailed).toBe('Sync failed')
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
