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
    meterPercentOf: (quota: Record<string, unknown> | undefined) => number | undefined
    percentLabel: (value: number) => string
    priceText: (t: (key: string) => string, factor: number) => string
    ownerLabel: (t: (key: string) => string, owner: string) => string
    dateLabel: (value: number) => string
    writeCache: (brand: string, kind: string, value: unknown) => void
    AccountCard: (props: Record<string, unknown>) => unknown
  }
}

function loadClient(react?: Record<string, unknown>): ClientExports {
  const source = readFileSync(path.join(process.cwd(), 'client.js'), 'utf8')
  let definition: { factory: (require: (id: string) => unknown) => ClientExports } | undefined
  const window = {
    __ModuleLoader__: {
      load(value: typeof definition) { definition = value },
    },
    localStorage: { getItem: () => null, setItem: () => undefined },
  }
  const document = { baseURI: 'http://127.0.0.1:3080/' }
  const React = react ?? {
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

/** The smallest React that renders a tree instead of nothing. */
const TREE_REACT = {
  createElement: (type: string, props: unknown, ...children: unknown[]) => ({
    type,
    props: { ...(props ?? {}) as object, children },
  }),
  useState: (value: unknown) => [typeof value === 'function' ? (value as () => unknown)() : value, () => undefined],
  useEffect: () => undefined,
  useCallback: (fn: unknown) => fn,
  useMemo: (fn: () => unknown) => fn(),
  useRef: (value: unknown) => ({ current: value }),
  useSyncExternalStore: (_subscribe: unknown, get: () => unknown) => get(),
}

interface Element {
  type: string
  props: { style?: Record<string, unknown>, children?: unknown[] }
}

function walk(node: unknown, visit: (element: Element) => void): void {
  if (node === null || node === undefined || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  const element = node as Element
  visit(element)
  for (const child of element.props.children ?? []) walk(child, visit)
}

function textOf(node: unknown, out: string[] = []): string[] {
  if (typeof node === 'string' || typeof node === 'number') out.push(String(node))
  else if (node !== null && typeof node === 'object') {
    for (const child of (node as Element).props.children ?? []) textOf(child, out)
  }
  return out
}

describe('client bundle', () => {
  const exports = loadClient()

  it('declares one settings section per provider and matching config fields', () => {
    expect(exports.name).toBe('dsh-llm-adapters')
    expect(exports.inject).toEqual(['slots', 'locale', 'configForms'])
    expect(exports.__test.BRANDS.map(brand => brand.id)).toEqual(['loomy', 'raccoon', 'trae', 'codearts'])
    expect(exports.__test.FIELDS.loomy.enabled).toBe('loomyEnabled')
    expect(exports.__test.FIELDS.raccoon.enabled).toBe('raccoonEnabled')
    expect(exports.__test.FIELDS.trae.enabled).toBe('traeEnabled')
    expect(exports.__test.FIELDS.trae.region).toBe('traeRegion')
    expect(exports.__test.FIELDS.codearts.enabled).toBe('codeartsEnabled')
    expect(exports.__test.FIELDS.codearts.windows).toBe('codeartsModelContextWindows')
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

  it('draws a credit bar only when both the spend and the allowance are known', () => {
    const { meterPercentOf, percentLabel } = exports.__test
    // CodeArts and Trae CN report both halves; Loomy and Raccoon only what is left.
    expect(meterPercentOf({ used: 13.05, total: 21_500 })).toBeCloseTo(0.0607, 4)
    expect(meterPercentOf({ used: 50, total: 200 })).toBe(25)
    expect(meterPercentOf({ total: 1_000 })).toBeUndefined()
    expect(meterPercentOf({ used: 10 })).toBeUndefined()
    expect(meterPercentOf({ used: 10, total: 0 })).toBeUndefined()
    expect(meterPercentOf(undefined)).toBeUndefined()
    expect(percentLabel(0.0607)).toBe('0.06%')
    expect(percentLabel(25)).toBe('25%')
    expect(percentLabel(100)).toBe('100%')
  })

  it('keeps the Raccoon card free of the thinking-level note', () => {
    expect(exports.__test.zh.raccoonHint).toBe('小浣熊扫码登录的令牌约 30 天有效，到期后重新扫码即可。')
    expect(exports.__test.en.raccoonHint).toBe('A Raccoon QR login lasts about 30 days; scan again when it expires.')
  })

  it('renders the credit bar and the account name on the CodeArts card', () => {
    const tree = loadClient(TREE_REACT)
    const { writeCache, AccountCard, zh, css } = tree.__test
    writeCache('codearts', 'status', {
      signedIn: true,
      loginAt: Date.now(),
      account: { name: 'why15855103187' },
      quota: {
        total: 21_500,
        used: 13.05,
        plan: '体验版',
        packs: [
          { label: '基础积分包', total: 500, used: 0 },
          { label: '赠送积分包', total: 21_000, used: 13.05 },
        ],
        at: Date.now(),
      },
    })
    const rendered = AccountCard({
      t: (key: string) => (zh as Record<string, string>)[key] ?? key,
      brand: { id: 'codearts' },
      region: 'cn',
      onRegionChange: () => undefined,
      reloadSignal: 0,
      onStatus: () => undefined,
      onAfterRefresh: () => undefined,
    })
    const text = textOf(rendered).join(' ')
    expect(text).toContain('why15855103187')
    expect(text).toContain('13.05 / 21,500 积分')
    expect(text).toContain('0.06%')
    // Exactly one bar, filled to the smallest visible width: 0.06% would not
    // render at all, and a bar that looks empty reads as "untouched".
    const bars: Element[] = []
    walk(rendered, element => {
      if (element.props.style === css.meter) bars.push(element)
    })
    expect(bars).toHaveLength(1)
    expect((bars[0]!.props.children?.[0] as Element).props.style).toMatchObject({ width: '1.5%' })
  })
})
