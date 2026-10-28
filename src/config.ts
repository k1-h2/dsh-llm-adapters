/**
 * The plugin's configuration surface.
 *
 * DSH renders this schema in the generated part of the settings UI and, more
 * importantly, treats every `.volatile()` field as an in-place edit: changing
 * it must never restart the plugin. The adapters therefore read values through
 * thunks from {@link liveConfig}.
 *
 * @module dsh-llm-adapters/config
 */

import { isVolatile } from '@deepseek-ai/cosmokit'
import z from '@deepseek-ai/schemastery'
import type { TraeRegion } from './brand.ts'
import { normalizeTraeRegion } from './brand.ts'

export interface Config {
  loomyEnabled?: boolean
  raccoonEnabled?: boolean
  traeEnabled?: boolean
  traeRegion?: string
  codeartsEnabled?: boolean
  loomyDisplayName?: string
  raccoonDisplayName?: string
  traeDisplayName?: string
  codeartsDisplayName?: string
  loomyDisabledModels?: string[]
  raccoonDisabledModels?: string[]
  traeDisabledModels?: string[]
  codeartsDisabledModels?: string[]
  loomyModelContextWindows?: Record<string, number>
  raccoonModelContextWindows?: Record<string, number>
  traeModelContextWindows?: Record<string, number>
  codeartsModelContextWindows?: Record<string, number>
  loomyModelAliases?: Record<string, string>
  raccoonModelAliases?: Record<string, string>
  traeModelAliases?: Record<string, string>
  codeartsModelAliases?: Record<string, string>
  loomyVisionModelIds?: string[]
  loomyTextOnlyModelIds?: string[]
  raccoonVisionModelIds?: string[]
  raccoonTextOnlyModelIds?: string[]
  traeVisionModelIds?: string[]
  traeTextOnlyModelIds?: string[]
  codeartsVisionModelIds?: string[]
  codeartsTextOnlyModelIds?: string[]
  defaultMaxTokens?: number
  modelCacheTtlSeconds?: number
  catalogFetchTimeoutSeconds?: number
  /** Minutes between automatic OpenRouter syncs; 0 disables the schedule. */
  openRouterSyncMinutes?: number
  /** Minutes between Raccoon daily-point checks; 0 disables the monitor. */
  raccoonCheckinMinutes?: number
}

export const Config = z.object({
  loomyEnabled: z.boolean().default(true).description('启用 Loomy。关闭后该设置页、模型列表与 provider 路由都会移除；登录态与模型选择会保留。').volatile(),
  raccoonEnabled: z.boolean().default(true).description('启用商汤小浣熊。关闭后该设置页、模型列表与 provider 路由都会移除；登录态与模型选择会保留。').volatile(),
  traeEnabled: z.boolean().default(true).description('启用 Trae。关闭后该设置页、模型列表与 provider 路由都会移除；两个区域的登录态与模型选择会保留。').volatile(),
  traeRegion: z.string().default('cn').description('Trae 登录区域：cn（国内版 trae.cn）或 global（国际版 trae.ai）。两个区域各自保存账号，切换后立即恢复对应账号。').volatile(),
  codeartsEnabled: z.boolean().default(true).description('启用华为云 CodeArts。关闭后该设置页、模型列表与 provider 路由都会移除；登录态与模型选择会保留。').volatile(),

  loomyDisplayName: z.string().default('Loomy').description('模型选择器里 Loomy 分组的名称。').volatile(),
  raccoonDisplayName: z.string().default('商汤小浣熊').description('模型选择器里小浣熊分组的名称。').volatile(),
  traeDisplayName: z.string().default('Trae').description('模型选择器里 Trae 分组的名称。').volatile(),
  codeartsDisplayName: z.string().default('华为云 CodeArts').description('模型选择器里 CodeArts 分组的名称。').volatile(),

  loomyDisabledModels: z.array(z.string()).default([]).description('Loomy 已关闭的模型 ID 列表。关闭的模型不会出现在模型选择器里。').volatile(),
  raccoonDisabledModels: z.array(z.string()).default([]).description('小浣熊已关闭的模型 ID 列表。').volatile(),
  traeDisabledModels: z.array(z.string()).default([]).description('Trae 已关闭的模型 ID 列表。').volatile(),
  codeartsDisabledModels: z.array(z.string()).default([]).description('CodeArts 已关闭的模型 ID 列表。').volatile(),
  loomyModelContextWindows: z.dict(z.number()).default({}).description('Loomy 按模型指定上下文窗口（token 数）。未指定的模型使用上游声明的窗口。').volatile(),
  raccoonModelContextWindows: z.dict(z.number()).default({}).description('小浣熊按模型指定上下文窗口（token 数）。').volatile(),
  traeModelContextWindows: z.dict(z.number()).default({}).description('Trae 按模型指定上下文窗口（token 数）。').volatile(),
  codeartsModelContextWindows: z.dict(z.number()).default({}).description('CodeArts 按模型指定上下文窗口（token 数）。上游不下发窗口，默认使用 IDE 配置里的实测值。').volatile(),
  loomyModelAliases: z.dict(z.string()).default({}).description('Loomy 模型别名映射：DSH 侧名称 → 上游模型 ID。').volatile(),
  raccoonModelAliases: z.dict(z.string()).default({}).description('小浣熊模型别名映射：DSH 侧名称 → 上游模型 ID。').volatile(),
  traeModelAliases: z.dict(z.string()).default({}).description('Trae 模型别名映射：DSH 侧名称 → 上游模型 ID。').volatile(),
  codeartsModelAliases: z.dict(z.string()).default({}).description('CodeArts 模型别名映射：DSH 侧名称 → 上游模型 ID。').volatile(),

  loomyVisionModelIds: z.array(z.string()).default([]).description('Loomy 强制按“能读图”声明的模型 ID，优先级高于目录标签。').volatile(),
  loomyTextOnlyModelIds: z.array(z.string()).default([]).description('Loomy 强制按“纯文本”声明的模型 ID，优先级最高。').volatile(),
  raccoonVisionModelIds: z.array(z.string()).default([]).description('小浣熊强制按“能读图”声明的模型 ID。用于纠正上游标签错误。').volatile(),
  raccoonTextOnlyModelIds: z.array(z.string()).default([]).description('小浣熊强制按“纯文本”声明的模型 ID，优先级最高。').volatile(),
  traeVisionModelIds: z.array(z.string()).default([]).description('Trae 强制按“能读图”声明的模型 ID。目录标注 multimodal 的模型会自动启用。').volatile(),
  traeTextOnlyModelIds: z.array(z.string()).default([]).description('Trae 强制按“纯文本”声明的模型 ID，优先级最高。').volatile(),
  codeartsVisionModelIds: z.array(z.string()).default([]).description('CodeArts 的“强制读图”列表。所有模型都能接收图片（文本模型先由 VL 模型转述，设置页只给原生多模态模型标“读图”）；要关掉某个模型的读图能力请用下面的“纯文本”列表。').volatile(),
  codeartsTextOnlyModelIds: z.array(z.string()).default([]).description('CodeArts 强制按“纯文本”声明的模型 ID，优先级最高。').volatile(),

  defaultMaxTokens: z.number().step(1).min(1).default(32_000).description('模型目录未声明输出上限时使用的输出上限。').volatile(),
  modelCacheTtlSeconds: z.number().step(1).min(10).max(86_400).default(120).description('模型列表缓存时长（秒）。调小可更快看到账号侧变化。').volatile(),
  catalogFetchTimeoutSeconds: z.number().step(1).min(1).max(300).default(20).description('读取模型目录、额度等请求的时限（秒）。').volatile(),
  openRouterSyncMinutes: z.number().step(1).min(0).max(43_200).default(60).description('OpenRouter 模型元数据的自动同步间隔（分钟）。0 表示关闭自动同步；缓存保存在本机，连不上时继续使用上次成功同步的数据。').volatile(),
  raccoonCheckinMinutes: z.number().step(1).min(0).max(1_440).default(30).description('小浣熊每日积分自动监测间隔（分钟）：到点核对积分流水，未到账时按网页方式尝试触发。0 表示关闭自动监测；「打开网页签到」入口始终保留。').volatile(),
})

export interface ResolvedConfig {
  loomyEnabled: boolean
  raccoonEnabled: boolean
  traeEnabled: boolean
  traeRegion: TraeRegion
  codeartsEnabled: boolean
  loomyDisplayName: string
  raccoonDisplayName: string
  traeDisplayName: string
  codeartsDisplayName: string
  loomyDisabledModels: readonly string[]
  raccoonDisabledModels: readonly string[]
  traeDisabledModels: readonly string[]
  codeartsDisabledModels: readonly string[]
  loomyModelContextWindows: Readonly<Record<string, number>>
  raccoonModelContextWindows: Readonly<Record<string, number>>
  traeModelContextWindows: Readonly<Record<string, number>>
  codeartsModelContextWindows: Readonly<Record<string, number>>
  loomyModelAliases: Readonly<Record<string, string>>
  raccoonModelAliases: Readonly<Record<string, string>>
  traeModelAliases: Readonly<Record<string, string>>
  codeartsModelAliases: Readonly<Record<string, string>>
  loomyVisionModelIds: readonly string[]
  loomyTextOnlyModelIds: readonly string[]
  raccoonVisionModelIds: readonly string[]
  raccoonTextOnlyModelIds: readonly string[]
  traeVisionModelIds: readonly string[]
  traeTextOnlyModelIds: readonly string[]
  codeartsVisionModelIds: readonly string[]
  codeartsTextOnlyModelIds: readonly string[]
  defaultMaxTokens: number
  modelCacheTtlMs: number
  catalogFetchTimeoutMs: number
  openRouterSyncMinutes: number
  raccoonCheckinMinutes: number
}

export type ParsedConfig = { readonly [K in keyof Config]?: unknown }
export type LiveConfig = { readonly [K in keyof ResolvedConfig]: () => ResolvedConfig[K] }

export function liveConfig(config: ParsedConfig | undefined): LiveConfig {
  const source = (config ?? {}) as Record<string, unknown>
  const field = (key: keyof Config): unknown => {
    const value = source[key]
    return isVolatile(value) ? value.get() : value
  }

  return {
    loomyEnabled: () => bool(field('loomyEnabled'), true),
    raccoonEnabled: () => bool(field('raccoonEnabled'), true),
    traeEnabled: () => bool(field('traeEnabled'), true),
    traeRegion: () => normalizeTraeRegion(field('traeRegion')),
    codeartsEnabled: () => bool(field('codeartsEnabled'), true),
    loomyDisplayName: () => nonEmpty(field('loomyDisplayName'), 'Loomy'),
    raccoonDisplayName: () => nonEmpty(field('raccoonDisplayName'), '商汤小浣熊'),
    traeDisplayName: () => nonEmpty(field('traeDisplayName'), 'Trae'),
    codeartsDisplayName: () => nonEmpty(field('codeartsDisplayName'), '华为云 CodeArts'),
    loomyDisabledModels: () => stringList(field('loomyDisabledModels')),
    raccoonDisabledModels: () => stringList(field('raccoonDisabledModels')),
    traeDisabledModels: () => stringList(field('traeDisabledModels')),
    codeartsDisabledModels: () => stringList(field('codeartsDisabledModels')),
    loomyModelContextWindows: () => numberMap(field('loomyModelContextWindows')),
    raccoonModelContextWindows: () => numberMap(field('raccoonModelContextWindows')),
    traeModelContextWindows: () => numberMap(field('traeModelContextWindows')),
    codeartsModelContextWindows: () => numberMap(field('codeartsModelContextWindows')),
    loomyModelAliases: () => stringMap(field('loomyModelAliases')),
    raccoonModelAliases: () => stringMap(field('raccoonModelAliases')),
    traeModelAliases: () => stringMap(field('traeModelAliases')),
    codeartsModelAliases: () => stringMap(field('codeartsModelAliases')),
    loomyVisionModelIds: () => stringList(field('loomyVisionModelIds')),
    loomyTextOnlyModelIds: () => stringList(field('loomyTextOnlyModelIds')),
    raccoonVisionModelIds: () => stringList(field('raccoonVisionModelIds')),
    raccoonTextOnlyModelIds: () => stringList(field('raccoonTextOnlyModelIds')),
    traeVisionModelIds: () => stringList(field('traeVisionModelIds')),
    traeTextOnlyModelIds: () => stringList(field('traeTextOnlyModelIds')),
    codeartsVisionModelIds: () => stringList(field('codeartsVisionModelIds')),
    codeartsTextOnlyModelIds: () => stringList(field('codeartsTextOnlyModelIds')),
    defaultMaxTokens: () => positive(field('defaultMaxTokens'), 32_000),
    modelCacheTtlMs: () => positive(field('modelCacheTtlSeconds'), 120) * 1_000,
    catalogFetchTimeoutMs: () => positive(field('catalogFetchTimeoutSeconds'), 20) * 1_000,
    openRouterSyncMinutes: () => nonNegative(field('openRouterSyncMinutes'), 60),
    raccoonCheckinMinutes: () => nonNegative(field('raccoonCheckinMinutes'), 30),
  }
}

export function resolveConfig(config: ParsedConfig | undefined): ResolvedConfig {
  const live = liveConfig(config)
  return {
    loomyEnabled: live.loomyEnabled(),
    raccoonEnabled: live.raccoonEnabled(),
    traeEnabled: live.traeEnabled(),
    traeRegion: live.traeRegion(),
    codeartsEnabled: live.codeartsEnabled(),
    loomyDisplayName: live.loomyDisplayName(),
    raccoonDisplayName: live.raccoonDisplayName(),
    traeDisplayName: live.traeDisplayName(),
    codeartsDisplayName: live.codeartsDisplayName(),
    loomyDisabledModels: live.loomyDisabledModels(),
    raccoonDisabledModels: live.raccoonDisabledModels(),
    traeDisabledModels: live.traeDisabledModels(),
    codeartsDisabledModels: live.codeartsDisabledModels(),
    loomyModelContextWindows: live.loomyModelContextWindows(),
    raccoonModelContextWindows: live.raccoonModelContextWindows(),
    traeModelContextWindows: live.traeModelContextWindows(),
    codeartsModelContextWindows: live.codeartsModelContextWindows(),
    loomyModelAliases: live.loomyModelAliases(),
    raccoonModelAliases: live.raccoonModelAliases(),
    traeModelAliases: live.traeModelAliases(),
    codeartsModelAliases: live.codeartsModelAliases(),
    loomyVisionModelIds: live.loomyVisionModelIds(),
    loomyTextOnlyModelIds: live.loomyTextOnlyModelIds(),
    raccoonVisionModelIds: live.raccoonVisionModelIds(),
    raccoonTextOnlyModelIds: live.raccoonTextOnlyModelIds(),
    traeVisionModelIds: live.traeVisionModelIds(),
    traeTextOnlyModelIds: live.traeTextOnlyModelIds(),
    codeartsVisionModelIds: live.codeartsVisionModelIds(),
    codeartsTextOnlyModelIds: live.codeartsTextOnlyModelIds(),
    defaultMaxTokens: live.defaultMaxTokens(),
    modelCacheTtlMs: live.modelCacheTtlMs(),
    catalogFetchTimeoutMs: live.catalogFetchTimeoutMs(),
    openRouterSyncMinutes: live.openRouterSyncMinutes(),
    raccoonCheckinMinutes: live.raccoonCheckinMinutes(),
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function nonEmpty(value: unknown, fallback: string): string {
  const valueText = text(value)
  return valueText.length > 0 ? valueText : fallback
}

function positive(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

function nonNegative(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function stringList(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0).map(entry => entry.trim())
}

function numberMap(value: unknown): Readonly<Record<string, number>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Record<string, number> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'number' && Number.isFinite(entry) && entry > 0) out[key] = entry
  }
  return out
}

function stringMap(value: unknown): Readonly<Record<string, string>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string' && entry.trim().length > 0) out[key] = entry.trim()
  }
  return out
}
