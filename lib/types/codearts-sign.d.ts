/**
 * Huawei `SDK-HMAC-SHA256` request signing.
 *
 * The gateway verifies a canonical request built from the method, the path
 * (with a trailing slash), the raw query string, a sorted set of headers and
 * the SHA-256 of the body. Two details are easy to get wrong and both fail as a
 * generic `APIG.0301 verify ak sk signature fail`:
 *
 * 1. The path must end with `/` even when the URL does not.
 * 2. `host` participates in the signature but must not be sent as a header —
 *    `fetch` derives it from the URL.
 *
 * `extraHeaders` (only `maas_type: benefit` in practice) **does** participate:
 * dropping it from the signed set makes the gateway reject the request.
 *
 * @module dsh-llm-adapters/codearts-sign
 */
export declare function sha256Hex(data: Uint8Array | string): string;
export declare function hmacSha256Hex(key: string, data: string): string;
/** Huawei's timestamp form: `20261026T133000Z`. */
export declare function sdkDateStamp(now?: Date): string;
/**
 * Sign one request and return every header that must accompany it.
 *
 * The returned map still contains `host`; callers drop it before calling
 * `fetch`, because a hand-set `Host` is either ignored or rejected.
 */
export declare function signRequestHuawei(ak: string, sk: string, securityToken: string, method: string, urlStr: string, body?: Uint8Array | string, extraHeaders?: Readonly<Record<string, string>>): Promise<Map<string, string>>;
/** The signed headers minus `host`, ready to merge into a request. */
export declare function headersForFetch(signed: Map<string, string>): Record<string, string>;
