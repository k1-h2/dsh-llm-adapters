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
import z from '@deepseek-ai/schemastery';
import type { TraeRegion } from './brand.ts';
export interface Config {
    loomyEnabled?: boolean;
    raccoonEnabled?: boolean;
    traeEnabled?: boolean;
    traeRegion?: string;
    codeartsEnabled?: boolean;
    loomyDisplayName?: string;
    raccoonDisplayName?: string;
    traeDisplayName?: string;
    codeartsDisplayName?: string;
    loomyDisabledModels?: string[];
    raccoonDisabledModels?: string[];
    traeDisabledModels?: string[];
    codeartsDisabledModels?: string[];
    loomyModelContextWindows?: Record<string, number>;
    raccoonModelContextWindows?: Record<string, number>;
    traeModelContextWindows?: Record<string, number>;
    codeartsModelContextWindows?: Record<string, number>;
    loomyModelAliases?: Record<string, string>;
    raccoonModelAliases?: Record<string, string>;
    traeModelAliases?: Record<string, string>;
    codeartsModelAliases?: Record<string, string>;
    loomyVisionModelIds?: string[];
    loomyTextOnlyModelIds?: string[];
    raccoonVisionModelIds?: string[];
    raccoonTextOnlyModelIds?: string[];
    traeVisionModelIds?: string[];
    traeTextOnlyModelIds?: string[];
    codeartsVisionModelIds?: string[];
    codeartsTextOnlyModelIds?: string[];
    defaultMaxTokens?: number;
    modelCacheTtlSeconds?: number;
    catalogFetchTimeoutSeconds?: number;
    /** Minutes between automatic OpenRouter syncs; 0 disables the schedule. */
    openRouterSyncMinutes?: number;
    /** Minutes between Raccoon daily-point checks; 0 disables the monitor. */
    raccoonCheckinMinutes?: number;
}
export declare const Config: z<Schemastery.ObjectS<NoInfer<{
    loomyEnabled: z<boolean, boolean, "volatile-defined">;
    raccoonEnabled: z<boolean, boolean, "volatile-defined">;
    traeEnabled: z<boolean, boolean, "volatile-defined">;
    traeRegion: z<string, string, "volatile-defined">;
    codeartsEnabled: z<boolean, boolean, "volatile-defined">;
    loomyDisplayName: z<string, string, "volatile-defined">;
    raccoonDisplayName: z<string, string, "volatile-defined">;
    traeDisplayName: z<string, string, "volatile-defined">;
    codeartsDisplayName: z<string, string, "volatile-defined">;
    loomyDisabledModels: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    raccoonDisabledModels: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    traeDisabledModels: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    codeartsDisabledModels: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    loomyModelContextWindows: z<NoInfer<import("@deepseek-ai/cosmokit").Dict<number, string>>, NoInfer<import("@deepseek-ai/cosmokit").Dict<number, string>>, "volatile-defined">;
    raccoonModelContextWindows: z<NoInfer<import("@deepseek-ai/cosmokit").Dict<number, string>>, NoInfer<import("@deepseek-ai/cosmokit").Dict<number, string>>, "volatile-defined">;
    traeModelContextWindows: z<NoInfer<import("@deepseek-ai/cosmokit").Dict<number, string>>, NoInfer<import("@deepseek-ai/cosmokit").Dict<number, string>>, "volatile-defined">;
    codeartsModelContextWindows: z<NoInfer<import("@deepseek-ai/cosmokit").Dict<number, string>>, NoInfer<import("@deepseek-ai/cosmokit").Dict<number, string>>, "volatile-defined">;
    loomyModelAliases: z<NoInfer<import("@deepseek-ai/cosmokit").Dict<string, string>>, NoInfer<import("@deepseek-ai/cosmokit").Dict<string, string>>, "volatile-defined">;
    raccoonModelAliases: z<NoInfer<import("@deepseek-ai/cosmokit").Dict<string, string>>, NoInfer<import("@deepseek-ai/cosmokit").Dict<string, string>>, "volatile-defined">;
    traeModelAliases: z<NoInfer<import("@deepseek-ai/cosmokit").Dict<string, string>>, NoInfer<import("@deepseek-ai/cosmokit").Dict<string, string>>, "volatile-defined">;
    codeartsModelAliases: z<NoInfer<import("@deepseek-ai/cosmokit").Dict<string, string>>, NoInfer<import("@deepseek-ai/cosmokit").Dict<string, string>>, "volatile-defined">;
    loomyVisionModelIds: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    loomyTextOnlyModelIds: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    raccoonVisionModelIds: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    raccoonTextOnlyModelIds: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    traeVisionModelIds: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    traeTextOnlyModelIds: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    codeartsVisionModelIds: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    codeartsTextOnlyModelIds: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    defaultMaxTokens: z<number, number, "volatile-defined">;
    modelCacheTtlSeconds: z<number, number, "volatile-defined">;
    catalogFetchTimeoutSeconds: z<number, number, "volatile-defined">;
    openRouterSyncMinutes: z<number, number, "volatile-defined">;
    raccoonCheckinMinutes: z<number, number, "volatile-defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    loomyEnabled: z<boolean, boolean, "volatile-defined">;
    raccoonEnabled: z<boolean, boolean, "volatile-defined">;
    traeEnabled: z<boolean, boolean, "volatile-defined">;
    traeRegion: z<string, string, "volatile-defined">;
    codeartsEnabled: z<boolean, boolean, "volatile-defined">;
    loomyDisplayName: z<string, string, "volatile-defined">;
    raccoonDisplayName: z<string, string, "volatile-defined">;
    traeDisplayName: z<string, string, "volatile-defined">;
    codeartsDisplayName: z<string, string, "volatile-defined">;
    loomyDisabledModels: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    raccoonDisabledModels: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    traeDisabledModels: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    codeartsDisabledModels: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    loomyModelContextWindows: z<NoInfer<import("@deepseek-ai/cosmokit").Dict<number, string>>, NoInfer<import("@deepseek-ai/cosmokit").Dict<number, string>>, "volatile-defined">;
    raccoonModelContextWindows: z<NoInfer<import("@deepseek-ai/cosmokit").Dict<number, string>>, NoInfer<import("@deepseek-ai/cosmokit").Dict<number, string>>, "volatile-defined">;
    traeModelContextWindows: z<NoInfer<import("@deepseek-ai/cosmokit").Dict<number, string>>, NoInfer<import("@deepseek-ai/cosmokit").Dict<number, string>>, "volatile-defined">;
    codeartsModelContextWindows: z<NoInfer<import("@deepseek-ai/cosmokit").Dict<number, string>>, NoInfer<import("@deepseek-ai/cosmokit").Dict<number, string>>, "volatile-defined">;
    loomyModelAliases: z<NoInfer<import("@deepseek-ai/cosmokit").Dict<string, string>>, NoInfer<import("@deepseek-ai/cosmokit").Dict<string, string>>, "volatile-defined">;
    raccoonModelAliases: z<NoInfer<import("@deepseek-ai/cosmokit").Dict<string, string>>, NoInfer<import("@deepseek-ai/cosmokit").Dict<string, string>>, "volatile-defined">;
    traeModelAliases: z<NoInfer<import("@deepseek-ai/cosmokit").Dict<string, string>>, NoInfer<import("@deepseek-ai/cosmokit").Dict<string, string>>, "volatile-defined">;
    codeartsModelAliases: z<NoInfer<import("@deepseek-ai/cosmokit").Dict<string, string>>, NoInfer<import("@deepseek-ai/cosmokit").Dict<string, string>>, "volatile-defined">;
    loomyVisionModelIds: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    loomyTextOnlyModelIds: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    raccoonVisionModelIds: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    raccoonTextOnlyModelIds: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    traeVisionModelIds: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    traeTextOnlyModelIds: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    codeartsVisionModelIds: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    codeartsTextOnlyModelIds: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    defaultMaxTokens: z<number, number, "volatile-defined">;
    modelCacheTtlSeconds: z<number, number, "volatile-defined">;
    catalogFetchTimeoutSeconds: z<number, number, "volatile-defined">;
    openRouterSyncMinutes: z<number, number, "volatile-defined">;
    raccoonCheckinMinutes: z<number, number, "volatile-defined">;
}>>, "plain">;
export interface ResolvedConfig {
    loomyEnabled: boolean;
    raccoonEnabled: boolean;
    traeEnabled: boolean;
    traeRegion: TraeRegion;
    codeartsEnabled: boolean;
    loomyDisplayName: string;
    raccoonDisplayName: string;
    traeDisplayName: string;
    codeartsDisplayName: string;
    loomyDisabledModels: readonly string[];
    raccoonDisabledModels: readonly string[];
    traeDisabledModels: readonly string[];
    codeartsDisabledModels: readonly string[];
    loomyModelContextWindows: Readonly<Record<string, number>>;
    raccoonModelContextWindows: Readonly<Record<string, number>>;
    traeModelContextWindows: Readonly<Record<string, number>>;
    codeartsModelContextWindows: Readonly<Record<string, number>>;
    loomyModelAliases: Readonly<Record<string, string>>;
    raccoonModelAliases: Readonly<Record<string, string>>;
    traeModelAliases: Readonly<Record<string, string>>;
    codeartsModelAliases: Readonly<Record<string, string>>;
    loomyVisionModelIds: readonly string[];
    loomyTextOnlyModelIds: readonly string[];
    raccoonVisionModelIds: readonly string[];
    raccoonTextOnlyModelIds: readonly string[];
    traeVisionModelIds: readonly string[];
    traeTextOnlyModelIds: readonly string[];
    codeartsVisionModelIds: readonly string[];
    codeartsTextOnlyModelIds: readonly string[];
    defaultMaxTokens: number;
    modelCacheTtlMs: number;
    catalogFetchTimeoutMs: number;
    openRouterSyncMinutes: number;
    raccoonCheckinMinutes: number;
}
export type ParsedConfig = {
    readonly [K in keyof Config]?: unknown;
};
export type LiveConfig = {
    readonly [K in keyof ResolvedConfig]: () => ResolvedConfig[K];
};
export declare function liveConfig(config: ParsedConfig | undefined): LiveConfig;
export declare function resolveConfig(config: ParsedConfig | undefined): ResolvedConfig;
