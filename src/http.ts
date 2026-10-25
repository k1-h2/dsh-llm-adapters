/** JSON request helpers shared by the two provider clients. @module dsh-llm-adapters/http */

import { attributionHeaders } from '@deepseek-ai/dsh-llm'
import { ProviderHttpError } from './wire.ts'

async function responseError(response: Response): Promise<string> {
  const text = await response.text().catch(() => '')
  if (text === '') return `HTTP ${response.status}`
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed !== null && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>
      const nested = record.error
      if (typeof nested === 'string' && nested.length > 0) return nested
      if (nested !== null && typeof nested === 'object') {
        const message = (nested as Record<string, unknown>).message
        if (typeof message === 'string' && message.length > 0) return message
      }
      if (typeof record.message === 'string' && record.message.length > 0) return record.message
    }
  } catch {
    /* plain text */
  }
  return text.slice(0, 400)
}

export interface JsonRequest {
  method?: string
  headers?: Record<string, string>
  body?: unknown
  signal?: AbortSignal
  timeoutMs?: number
  fetchImpl?: typeof fetch
  /** Attribution is on by default; token-refresh calls can opt out. */
  attribution?: boolean
}

export async function fetchJson<T>(url: string, request: JsonRequest = {}): Promise<T> {
  const timeout = AbortSignal.timeout(request.timeoutMs ?? 20_000)
  const signal = request.signal === undefined ? timeout : AbortSignal.any([request.signal, timeout])
  let response: Response
  try {
    response = await (request.fetchImpl ?? fetch)(url, {
      method: request.method ?? 'GET',
      headers: {
        ...request.attribution === false ? {} : attributionHeaders(),
        accept: 'application/json',
        ...request.body === undefined ? {} : { 'content-type': 'application/json' },
        ...request.headers,
      },
      ...request.body === undefined ? {} : { body: JSON.stringify(request.body) },
      signal,
    })
  } catch (error) {
    if (timeout.aborted) throw new ProviderHttpError(`请求超时（${Math.round((request.timeoutMs ?? 20_000) / 1000)} 秒）`, 504)
    throw error
  }
  if (!response.ok) throw new ProviderHttpError(await responseError(response), response.status)
  try {
    return await response.json() as T
  } catch {
    throw new ProviderHttpError('上游返回的不是 JSON', 502)
  }
}

export { responseError }
