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

export interface Config {
  loomyEnabled?: boolean
  raccoonEnabled?: boolean
  loomyDisplayName?: string
  raccoonDisplayName?: string
  /** Explicit credential path; empty means auto-discover the app's login. */
  loomyAuthFile?: string
  raccoonAuthFile?: string
  loomyDisabledModels?: string[]
  raccoonDisabledModels?: string[]
  loomyModelContextWindows?: Record<string, number>
  raccoonModelContextWindows?: Record<string, number>
  loomyModelAliases?: Record<string, string>
  raccoonModelAliases?: Record<string, string>
  loomyVisionModelIds?: string[]
  loomyTextOnlyModelIds?: string[]
  raccoonVisionModelIds?: string[]
  raccoonTextOnlyModelIds?: string[]
  defaultMaxTokens?: number
  modelCacheTtlSeconds?: number
  catalogFetchTimeoutSeconds?: number
}

export const Config = z.object({
  loomyEnabled: z.boolean().default(true).description('启用 Loomy。关闭后该设置页、模型列表与 provider 路由都会移除；登录态与模型选择会保留。').volatile(),
  raccoonEnabled: z.boolean().default(true).description('启用商汤小浣熊。关闭后该设置页、模型列表与 provider 路由都会移除；登录态与模型选择会保留。').volatile(),

  loomyDisplayName: z.string().default('Loomy').description('模型选择器里 Loomy 分组的名称。').volatile(),
  raccoonDisplayName: z.string().default('商汤小浣熊').description('模型选择器里小浣熊分组的名称。').volatile(),

  loomyAuthFile: z.string().default('').description('Loomy 客户端登录态文件路径（可选）。留空则自动查找 userData/auth-session.json；使用浏览器扫码登录时无需填写。').volatile(),
  raccoonAuthFile: z.string().default('').description('小浣熊客户端登录态文件路径（可选）。留空则读取 ~/.box-agent/config/auth.json；也可用 BOX_AGENT_CONFIG_DIR / RACCOON_AUTH_FILE 指定。使用浏览器扫码登录时无需填写。').volatile(),

  loomyDisabledModels: z.array(z.string()).default([]).description('Loomy 已关闭的模型 ID 列表。关闭的模型不会出现在模型选择器里。').volatile(),
  raccoonDisabledModels: z.array(z.string()).default([]).description('小浣熊已关闭的模型 ID 列表。').volatile(),
  loomyModelContextWindows: z.dict(z.number()).default({}).description('Loomy 按模型指定上下文窗口（token 数）。未指定的模型使用上游声明的窗口。').volatile(),
  raccoonModelContextWindows: z.dict(z.number()).default({}).description('小浣熊按模型指定上下文窗口（token 数）。').volatile(),
  loomyModelAliases: z.dict(z.string()).default({}).description('Loomy 模型别名映射：DSH 侧名称 → 上游模型 ID。').volatile(),
  raccoonModelAliases: z.dict(z.string()).default({}).description('小浣熊模型别名映射：DSH 侧名称 → 上游模型 ID。').volatile(),

  loomyVisionModelIds: z.array(z.string()).default([]).description('Loomy 强制按“能读图”声明的模型 ID，优先级高于目录标签。').volatile(),
  loomyTextOnlyModelIds: z.array(z.string()).default([]).description('Loomy 强制按“纯文本”声明的模型 ID，优先级最高。').volatile(),
  raccoonVisionModelIds: z.array(z.string()).default([]).description('小浣熊强制按“能读图”声明的模型 ID。用于纠正上游标签错误。').volatile(),
  raccoonTextOnlyModelIds: z.array(z.string()).default([]).description('小浣熊强制按“纯文本”声明的模型 ID，优先级最高。').volatile(),

  defaultMaxTokens: z.number().step(1).min(1).default(32_000).description('模型目录未声明输出上限时使用的输出上限。').volatile(),
  modelCacheTtlSeconds: z.number().step(1).min(10).max(86_400).default(120).description('模型列表缓存时长（秒）。调小可更快看到账号侧变化。').volatile(),
  catalogFetchTimeoutSeconds: z.number().step(1).min(1).max(300).default(20).description('读取模型目录、额度等请求的时限（秒）。').volatile(),
})

export interface ResolvedConfig {
  loomyEnabled: boolean
  raccoonEnabled: boolean
  loomyDisplayName: string
  raccoonDisplayName: string
  loomyAuthFile: string
  raccoonAuthFile: string
  loomyDisabledModels: readonly string[]
  raccoonDisabledModels: readonly string[]
  loomyModelContextWindows: Readonly<Record<string, number>>
  raccoonModelContextWindows: Readonly<Record<string, number>>
  loomyModelAliases: Readonly<Record<string, string>>
  raccoonModelAliases: Readonly<Record<string, string>>
  loomyVisionModelIds: readonly string[]
  loomyTextOnlyModelIds: readonly string[]
  raccoonVisionModelIds: readonly string[]
  raccoonTextOnlyModelIds: readonly string[]
  defaultMaxTokens: number
  modelCacheTtlMs: number
  catalogFetchTimeoutMs: number
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
    loomyDisplayName: () => nonEmpty(field('loomyDisplayName'), 'Loomy'),
    raccoonDisplayName: () => nonEmpty(field('raccoonDisplayName'), '商汤小浣熊'),
    loomyAuthFile: () => text(field('loomyAuthFile')),
    raccoonAuthFile: () => text(field('raccoonAuthFile')),
    loomyDisabledModels: () => stringList(field('loomyDisabledModels')),
    raccoonDisabledModels: () => stringList(field('raccoonDisabledModels')),
    loomyModelContextWindows: () => numberMap(field('loomyModelContextWindows')),
    raccoonModelContextWindows: () => numberMap(field('raccoonModelContextWindows')),
    loomyModelAliases: () => stringMap(field('loomyModelAliases')),
    raccoonModelAliases: () => stringMap(field('raccoonModelAliases')),
    loomyVisionModelIds: () => stringList(field('loomyVisionModelIds')),
    loomyTextOnlyModelIds: () => stringList(field('loomyTextOnlyModelIds')),
    raccoonVisionModelIds: () => stringList(field('raccoonVisionModelIds')),
    raccoonTextOnlyModelIds: () => stringList(field('raccoonTextOnlyModelIds')),
    defaultMaxTokens: () => positive(field('defaultMaxTokens'), 32_000),
    modelCacheTtlMs: () => positive(field('modelCacheTtlSeconds'), 120) * 1_000,
    catalogFetchTimeoutMs: () => positive(field('catalogFetchTimeoutSeconds'), 20) * 1_000,
  }
}

export function resolveConfig(config: ParsedConfig | undefined): ResolvedConfig {
  const live = liveConfig(config)
  return {
    loomyEnabled: live.loomyEnabled(),
    raccoonEnabled: live.raccoonEnabled(),
    loomyDisplayName: live.loomyDisplayName(),
    raccoonDisplayName: live.raccoonDisplayName(),
    loomyAuthFile: live.loomyAuthFile(),
    raccoonAuthFile: live.raccoonAuthFile(),
    loomyDisabledModels: live.loomyDisabledModels(),
    raccoonDisabledModels: live.raccoonDisabledModels(),
    loomyModelContextWindows: live.loomyModelContextWindows(),
    raccoonModelContextWindows: live.raccoonModelContextWindows(),
    loomyModelAliases: live.loomyModelAliases(),
    raccoonModelAliases: live.raccoonModelAliases(),
    loomyVisionModelIds: live.loomyVisionModelIds(),
    loomyTextOnlyModelIds: live.loomyTextOnlyModelIds(),
    raccoonVisionModelIds: live.raccoonVisionModelIds(),
    raccoonTextOnlyModelIds: live.raccoonTextOnlyModelIds(),
    defaultMaxTokens: live.defaultMaxTokens(),
    modelCacheTtlMs: live.modelCacheTtlMs(),
    catalogFetchTimeoutMs: live.catalogFetchTimeoutMs(),
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
