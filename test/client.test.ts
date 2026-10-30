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
    CHECKIN_INTERVALS: { value: number, labelKey: string }[]
    windowLabel: (value: number) => string
    creditsOf: (value: number) => string
    meterPercentOf: (quota: Record<string, unknown> | undefined) => number | undefined
    percentLabel: (value: number) => string
    priceText: (t: (key: string) => string, factor: number) => string
    ownerLabel: (t: (key: string) => string, owner: string) => string
    dateLabel: (value: number) => string
    amountText: (quota: Record<string, unknown> | undefined, value: number | undefined) => string
    writeCache: (brand: string, kind: string, value: unknown) => void
    AccountCard: (props: Record<string, unknown>) => unknown
    SettingsPage: (props: Record<string, unknown>) => unknown
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
  else if (Array.isArray(node)) {
    for (const child of node) textOf(child, out)
  } else if (node !== null && typeof node === 'object') {
    for (const child of (node as Element).props?.children ?? []) textOf(child, out)
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

  it('keeps Trae as one card with a region switch', () => {
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
    expect(zh.browserOpenTrae).toBe('打开浏览器登录')
    expect(zh.packUsage).toBe('已用 / 总额')
    // Collapsed is the default: one summary row plus a details toggle.
    expect(zh.packNearest).toBe('最近到期')
    expect(zh.packDetail).toBe('详细信息')
    expect(zh.packCollapse).toBe('收起')
    expect(zh.packExpand).toBeUndefined()
    expect(en.packUsage).toBe('used / total')
  })

  it('keeps the account and device check-in labels apart', () => {
    const { zh } = exports.__test
    expect(zh.checkinClaim).toBe('签到领积分')
    expect(zh.checkinClaimed).toBe('今日已签到')
    // The device flag and the account flag must never share a label.
    expect(zh.checkinDevice).not.toBe(zh.checkinClaimed)
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

  it('offers a switchable Raccoon check-in monitor interval', () => {
    const { zh, en, CHECKIN_INTERVALS } = exports.__test
    expect(CHECKIN_INTERVALS.map(option => option.value)).toEqual([0, 15, 30, 60, 120])
    expect(zh.checkinMonitorOff).toContain('关闭')
    expect(zh.checkinEvery30).toContain('30')
    expect(en.checkinMonitorOff).toBe('Monitor off')
    expect(en.checkinEvery30).toContain('30')
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
    expect(exports.__test.zh.raccoonHint).toContain('30 天')
    expect(exports.__test.zh.raccoonHint).toContain('每日积分')
    expect(exports.__test.en.raccoonHint).toContain('30 days')
    expect(exports.__test.en.raccoonHint).toContain('Daily points')
  })

  it('explains the CodeArts image relay below the model list', () => {
    const { zh, en } = exports.__test as unknown as {
      zh: Record<string, string>
      en: Record<string, string>
    }
    expect(zh.codeartsVisionHint).toContain('原生')
    expect(zh.codeartsVisionHint).toContain('转述')
    expect(en.codeartsVisionHint).toContain('native')
    expect(en.codeartsVisionHint).toContain('transcribes')
  })

  it('marks native vision only and hints at the relay below the list', () => {
    const tree = loadClient(TREE_REACT)
    const { writeCache, SettingsPage, zh } = tree.__test
    writeCache('codearts', 'models', {
      signedIn: true,
      rows: [
        {
          id: 'glm-5.2', name: 'GLM-5.2', enabled: false, vision: true, visionRelay: true,
          reasoning: true, contextWindows: [200_000], defaultContextWindow: 200_000,
        },
        {
          id: 'kimi-k2.6-vl', name: 'Kimi-K2.6-VL', enabled: false, vision: true,
          reasoning: false, contextWindows: [262_144], defaultContextWindow: 262_144,
        },
      ],
      at: Date.now(),
    })
    const ctx = {
      configForms: {
        get: () => ({
          getSnapshot: () => ({ value: {}, writable: true }),
          subscribe: () => () => undefined,
          set: async () => undefined,
          unset: async () => undefined,
        }),
      },
    }
    const rendered = SettingsPage({
      ctx,
      t: (key: string) => (zh as Record<string, string>)[key] ?? key,
      brand: { id: 'codearts', titleKey: 'codeartsTitle', introKey: 'codeartsIntro' },
    })
    const tags: string[] = []
    walk(rendered, element => {
      if (element.type === 'span' && textOf(element).join('') === '读图') tags.push('读图')
    })
    const text = textOf(rendered).join(' ')
    // The relayed row carries no native tag; only the VL model does.
    expect(tags).toHaveLength(1)
    expect(text).toContain('「读图」只标记模型原生支持图片')
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

  it('shows the Raccoon check-in panel and its web fallback', () => {
    const tree = loadClient(TREE_REACT)
    const { writeCache, AccountCard, zh } = tree.__test
    writeCache('raccoon', 'status', {
      signedIn: true,
      loginAt: Date.now(),
      quota: { total: 8029, available: 8029, at: Date.now() },
      checkin: {
        available: true,
        claimed: false,
        deviceClaimed: false,
        message: '每日积分在当天首次打开网页时发放',
        url: 'https://xiaohuanxiong.com/work/home',
      },
    })
    const rendered = AccountCard({
      t: (key: string) => (zh as Record<string, string>)[key] ?? key,
      brand: { id: 'raccoon' },
      region: 'cn',
      onRegionChange: () => undefined,
      reloadSignal: 0,
      onStatus: () => undefined,
      onAfterRefresh: () => undefined,
    })
    const text = textOf(rendered).join(' ')
    expect(text).toContain('签到领积分')
    expect(text).toContain('每日积分在当天首次打开网页时发放')
    expect(text).toContain('打开网页签到')
    const links: Element[] = []
    walk(rendered, element => {
      if (element.type === 'a') links.push(element)
    })
    expect(links.some(link => (link.props as { href?: string }).href === 'https://xiaohuanxiong.com/work/home')).toBe(true)
  })

  it('labels a received Raccoon grant as credited and keeps the manual link', () => {
    const tree = loadClient(TREE_REACT)
    const { writeCache, AccountCard, zh } = tree.__test
    const grantedAt = Date.now() - 5 * 60_000
    writeCache('raccoon', 'status', {
      signedIn: true,
      loginAt: Date.now(),
      quota: { total: 8329, available: 8329, at: Date.now() },
      checkin: {
        available: true,
        claimed: true,
        deviceClaimed: false,
        reward: 300,
        grantedAt,
        url: 'https://xiaohuanxiong.com/work/home',
      },
    })
    const rendered = AccountCard({
      t: (key: string) => (zh as Record<string, string>)[key] ?? key,
      brand: { id: 'raccoon' },
      region: 'cn',
      onRegionChange: () => undefined,
      reloadSignal: 0,
      onStatus: () => undefined,
      onAfterRefresh: () => undefined,
    })
    const text = textOf(rendered).join(' ')
    expect(text).toContain('今日已签到')
    expect(text).toContain('已到账 +300 积分')
    // The issuance time answers "was this yesterday's grant?".
    expect(text).toContain('到账时间')
    // Claimed or not, the web page stays one click away.
    expect(text).toContain('打开网页签到')
    const links: Element[] = []
    walk(rendered, element => {
      if (element.type === 'a') links.push(element)
    })
    expect(links.some(link => (link.props as { href?: string }).href === 'https://xiaohuanxiong.com/work/home')).toBe(true)
  })

  it('formats dollar quotas without credits and shows the reset date', () => {
    const tree = loadClient(TREE_REACT)
    const { writeCache, AccountCard, zh, amountText } = tree.__test
    expect(amountText({ unit: 'usd' }, 0)).toBe('$0.00')
    expect(amountText({ unit: 'usd' }, 1.25)).toBe('$1.25')
    expect(amountText({}, 300)).toBe('300')
    writeCache('trae:global', 'status', {
      signedIn: true,
      loginAt: Date.now(),
      account: { name: 'user52845450213' },
      quota: {
        plan: 'Free plan',
        unit: 'usd',
        total: 1,
        used: 0,
        resetAt: Date.parse('2026-11-01T08:00:00+08:00'),
        trialEndsAt: Date.parse('2026-10-29T07:45:00+08:00'),
        at: Date.now(),
      },
    })
    const rendered = AccountCard({
      t: (key: string) => (zh as Record<string, string>)[key] ?? key,
      brand: { id: 'trae' },
      region: 'global',
      onRegionChange: () => undefined,
      reloadSignal: 0,
      onStatus: () => undefined,
      onAfterRefresh: () => undefined,
    })
    const text = textOf(rendered).join(' ')
    expect(text).toContain('Free plan')
    expect(text).toContain('$0.00 / $1.00')
    expect(text).toContain('重置时间')
    expect(text).not.toContain('$0.00 / $1.00 积分')
  })
})
