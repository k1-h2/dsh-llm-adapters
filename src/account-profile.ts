/**
 * Non-secret account facts for the settings card.
 *
 * Browser login stores the credentials; this lookup only adds a display name,
 * phone and account type. Failures are ignored — they must never turn a
 * successful login into a failed one.
 *
 * @module dsh-llm-adapters/account-profile
 */

import { attributionHeaders } from '@deepseek-ai/dsh-llm'

export const RACCOON_WEB_BASE = 'https://xiaohuanxiong.com/api/web'

const REQUEST_TIMEOUT_MS = 15_000

function textField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

export async function raccoonAccountInfo(
  input: { accessToken: string, fetchImpl?: typeof fetch },
): Promise<{ name?: string, phone?: string, ownerType?: string }> {
  const fetchImpl = input.fetchImpl ?? fetch
  try {
    const response = await fetchImpl(`${RACCOON_WEB_BASE}/auth/v1/user_info`, {
      method: 'GET',
      headers: { ...attributionHeaders(), accept: 'application/json', authorization: `Bearer ${input.accessToken}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!response.ok) return {}
    const parsed: unknown = JSON.parse(await response.text())
    if (parsed === null || typeof parsed !== 'object') return {}
    const root = parsed as Record<string, unknown>
    const data = root.data !== null && typeof root.data === 'object' && !Array.isArray(root.data)
      ? root.data as Record<string, unknown>
      : {}
    const name = textField(data.name) ?? textField(data.nickname)
    const ownerType = textField(data.owner_type)
      ?? (Array.isArray(data.orgs) && data.orgs.length === 0 ? 'personal' : undefined)
    return {
      ...name === undefined ? {} : { name },
      ...textField(data.phone) === undefined ? {} : { phone: textField(data.phone)! },
      ...ownerType === undefined ? {} : { ownerType },
    }
  } catch {
    return {}
  }
}
