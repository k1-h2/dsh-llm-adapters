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

import { createHash, createHmac } from 'node:crypto'

export function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex')
}

export function hmacSha256Hex(key: string, data: string): string {
  return createHmac('sha256', key).update(data).digest('hex')
}

/** Huawei's timestamp form: `20261026T133000Z`. */
export function sdkDateStamp(now: Date = new Date()): string {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
}

/**
 * Sign one request and return every header that must accompany it.
 *
 * The returned map still contains `host`; callers drop it before calling
 * `fetch`, because a hand-set `Host` is either ignored or rejected.
 */
export async function signRequestHuawei(
  ak: string,
  sk: string,
  securityToken: string,
  method: string,
  urlStr: string,
  body: Uint8Array | string = '',
  extraHeaders?: Readonly<Record<string, string>>,
): Promise<Map<string, string>> {
  const url = new URL(urlStr)
  let uri = url.pathname
  if (!uri.endsWith('/')) uri += '/'
  const query = url.search.slice(1)
  const dateStamp = sdkDateStamp()
  const payload = typeof body === 'string' ? body : Buffer.from(body)
  const payloadHash = sha256Hex(payload)

  const headers = new Map<string, string>()
  headers.set('host', url.host)
  headers.set('x-sdk-date', dateStamp)
  headers.set('x-sdk-content-sha256', payloadHash)
  headers.set('x-security-token', securityToken)
  if (extraHeaders !== undefined) {
    for (const [key, value] of Object.entries(extraHeaders)) headers.set(key, value)
  }
  // A GET carries no body, so it carries no content-type either.
  if (method.toUpperCase() !== 'GET') headers.set('content-type', 'application/json')

  const signedHeaders = [...headers.keys()].sort()
  const canonical = [
    method.toUpperCase(),
    uri,
    query,
    signedHeaders.map(key => `${key}:${headers.get(key) ?? ''}`).join('\n'),
    '',
    signedHeaders.join(';'),
    payloadHash,
  ].join('\n')
  const stringToSign = `SDK-HMAC-SHA256\n${dateStamp}\n${sha256Hex(canonical)}`
  const signature = hmacSha256Hex(sk, stringToSign)
  headers.set(
    'Authorization',
    `SDK-HMAC-SHA256 Access=${ak},SignedHeaders=${signedHeaders.join(';')},Signature=${signature}`,
  )
  return headers
}

/** The signed headers minus `host`, ready to merge into a request. */
export function headersForFetch(signed: Map<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of signed) {
    if (key === 'host') continue
    out[key] = value
  }
  return out
}
