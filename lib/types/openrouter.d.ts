/**
 * Live capability lookup from OpenRouter's public model catalog.
 *
 * Raccoon's own catalog does not expose reasoning-effort levels, and both
 * providers carry names the model vendor spells differently (`GLM-5-3` vs
 * `GLM 5.3`). OpenRouter publishes `reasoning.supported_efforts` and
 * `architecture.input_modalities`, so this module fetches that catalog on
 * demand and matches entries by normalized name.
 *
 * The data is fetched at runtime, refreshed by the plugin's scheduler, and kept
 * on disk, so a temporary outage keeps the last successful snapshot instead of
 * silently dropping every capability control.
 *
 * @module dsh-llm-adapters/openrouter
 */
export interface OpenRouterModel {
    id: string;
    name: string;
    inputModalities: readonly string[];
    /** Supported effort ids in OpenRouter's preferred display order. */
    efforts?: readonly string[];
    defaultEffort?: string;
    /** The model rejects `none` and must always reason. */
    mandatory: boolean;
}
export interface OpenRouterIndex {
    readonly models: readonly OpenRouterModel[];
    /**
     * Match one upstream model. `name` is the normalized product name; `id` is
     * the upstream id. Exact keys win, then a wildcard containment check.
     */
    match(name: string, id?: string): OpenRouterModel | undefined;
}
export interface OpenRouterLookup {
    models(fresh?: boolean): Promise<OpenRouterIndex>;
    invalidate(): void;
}
/** What the settings page may read without triggering a network request. */
export interface OpenRouterStatus {
    models: number;
    at?: number;
    error?: string;
    syncing: boolean;
}
/** One explicit sync attempt; `ok` is false only when new data was not stored. */
export interface OpenRouterSyncResult extends OpenRouterStatus {
    ok: boolean;
}
export declare const EMPTY_OPENROUTER_INDEX: OpenRouterIndex;
export declare function buildOpenRouterIndex(models: readonly OpenRouterModel[]): OpenRouterIndex;
/** Parse the subset of `GET /api/v1/models` this plugin uses. */
export declare function parseOpenRouterModels(payload: unknown): OpenRouterModel[];
/**
 * A persistent, atomically-replaced OpenRouter snapshot.
 *
 * `models()` never triggers a network request once a snapshot exists: refreshes
 * are driven by {@link sync}, which the plugin calls on a schedule and the
 * settings page can trigger. A failed sync leaves both the in-memory and the
 * on-disk copy untouched, so an offline start still has the last known levels
 * and modalities.
 */
export declare class OpenRouterCatalog implements OpenRouterLookup {
    private readonly fetchImpl;
    private readonly options;
    private snapshot;
    private inflight;
    private lastError;
    constructor(fetchImpl?: typeof fetch, options?: {
        cacheFile?: string;
    });
    private loadFromDisk;
    /** Replace the cache file only after the new document is complete (tmp + rename). */
    private persist;
    private fetchAndReplace;
    /**
     * Fetch and replace the snapshot. Concurrent callers share one request, and
     * a failure keeps the previous snapshot and reports why.
     */
    sync(): Promise<OpenRouterSyncResult>;
    models(fresh?: boolean): Promise<OpenRouterIndex>;
    /** A read-only reading for the settings card; never starts a request. */
    status(): OpenRouterStatus;
    /** Drop the in-memory copy; the next read refetches (the file stays). */
    invalidate(): void;
}
