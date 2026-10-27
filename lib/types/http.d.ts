/** JSON request helpers shared by the two provider clients. @module dsh-llm-adapters/http */
declare function responseError(response: Response): Promise<string>;
export interface JsonRequest {
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
    signal?: AbortSignal;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
    /** Attribution is on by default; token-refresh calls can opt out. */
    attribution?: boolean;
}
export declare function fetchJson<T>(url: string, request?: JsonRequest): Promise<T>;
export { responseError };
