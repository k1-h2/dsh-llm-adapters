/**
 * Settings-page data source.
 *
 * Catalog and quota live behind an HTTP route because they come from the
 * upstream account, not from the stored config form. Writes still go through
 * the host's own `configForms` revision fence.
 *
 * @module dsh-llm-adapters/api
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { LocalAdapter } from './adapter.ts';
import type { BrandId } from './brand.ts';
import type { OpenRouterStatus, OpenRouterSyncResult } from './openrouter.ts';
export declare const API_PREFIX = "/api/llm-adapters";
export interface ModelRow {
    id: string;
    name: string;
    description?: string;
    labels?: readonly string[];
    enabled: boolean;
    vision: boolean;
    contextWindow: number;
    /** Widest window the model offers; the row's `<select>` may go up to it. */
    maxContextWindow?: number;
    contextWindows: number[];
    defaultContextWindow: number;
    override?: number;
    priceFactor?: number;
    badge?: string;
    reasoning: boolean;
}
export type AdapterMap = Readonly<Record<BrandId, LocalAdapter>>;
/** The shared router snapshot behind the settings card's sync controls. */
export interface OpenRouterAdmin {
    status(): OpenRouterStatus;
    sync(): Promise<OpenRouterSyncResult>;
}
export declare function buildRows(adapter: LocalAdapter): Promise<ModelRow[]>;
export declare function handleApi(req: IncomingMessage, res: ServerResponse, adapters: AdapterMap, openRouter?: OpenRouterAdmin): Promise<void>;
