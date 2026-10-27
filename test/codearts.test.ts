import { describe, expect, it, vi } from 'vitest'
import { createPublicKey, verify } from 'node:crypto'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import {
  CODEARTS_EFFORTS, CodeArtsProvider, clampMaxTokens, codeartsEfforts, normalizeCodeArtsModelId,
  parseCodeArtsPackage, parseCodeArtsRoster, pickActiveCredit, priceFactorOfLabel,
} from '../src/codearts.ts'
import {
  CODEARTS_EFFORT_LEVELS, CODEARTS_FALLBACK_CONTEXT_WINDOW, codeartsContextWindow,
} from '../src/codearts-endpoints.ts'
import { headersForFetch, sdkDateStamp, sha256Hex, signRequestHuawei } from '../src/codearts-sign.ts'
import { CodeArtsSessionWindow } from '../src/codearts-window.ts'
import { EMPTY_OPENROUTER_INDEX, buildOpenRouterIndex } from '../src/openrouter.ts'
import type { OpenRouterIndex } from '../src/openrouter.ts'
import {
  RefreshTokenExpiredError, buildAuthorizeUrl, exchangeRefreshToken, generateDpopKeyPair, generatePkcePair,
  readJwtExpiry, readUserProfile, signDpopJws,
} from '../src/codearts-oauth.ts'
import { ProviderHttpError } from '../src/wire.ts'

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const chunk of stream) out.push(chunk)
  return out
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

function sse(frames: readonly string[]): Response {
  const body = frames.map(frame => `data: ${frame}\n\n`).join('')
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body))
      controller.close()
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

describe('CodeArts signing', () => {
  it('signs the canonical request and leaves host out of the sent headers', async () => {
    const signed = await signRequestHuawei('AK', 'SK', 'ST', 'GET', 'https://example.com/v1/model/builtin')
    const auth = signed.get('Authorization') ?? ''
    expect(auth).toMatch(/^SDK-HMAC-SHA256 Access=AK,SignedHeaders=/)
    // The path gains a trailing slash and `host` participates but is not sent.
    expect(auth).toContain('host;x-sdk-content-sha256;x-sdk-date;x-security-token')
    expect(signed.get('x-sdk-content-sha256')).toBe(sha256Hex(''))
    expect(signed.has('content-type')).toBe(false)
    expect(headersForFetch(signed).host).toBeUndefined()
  })

  it('adds content-type for a POST and signs extra headers', async () => {
    const signed = await signRequestHuawei(
      'AK', 'SK', 'ST', 'POST', 'https://example.com/api/v2/chat/completions', '{"a":1}',
      { maas_type: 'benefit' },
    )
    expect(signed.get('content-type')).toBe('application/json')
    expect(signed.get('maas_type')).toBe('benefit')
    expect(signed.get('Authorization')).toContain('maas_type')
    expect(signed.get('x-sdk-content-sha256')).toBe(sha256Hex('{"a":1}'))
  })

  it('changes the signature when the body changes', async () => {
    const first = await signRequestHuawei('AK', 'SK', 'ST', 'POST', 'https://example.com/x', '{"a":1}')
    const second = await signRequestHuawei('AK', 'SK', 'ST', 'POST', 'https://example.com/x', '{"a":2}')
    expect(first.get('Authorization')).not.toBe(second.get('Authorization'))
  })

  it('writes the timestamp in Huawei form', () => {
    expect(sdkDateStamp(new Date('2026-10-26T13:30:00Z'))).toBe('20261026T133000Z')
  })
})

describe('CodeArts OAuth', () => {
  it('builds a PKCE pair whose challenge is the S256 of the verifier', () => {
    const pkce = generatePkcePair()
    expect(pkce.codeVerifier.length).toBeGreaterThan(40)
    const expected = new URL(`http://x/?c=${pkce.codeVerifier}`).searchParams.get('c')!
    expect(pkce.codeChallenge).toBe(
      Buffer.from(sha256Hex(expected), 'hex').toString('base64url'),
    )
  })

  it('signs a DPoP proof the public key verifies', () => {
    const keyPair = generateDpopKeyPair()
    const jws = signDpopJws(keyPair, 'POST', 'https://sts.example/tokens')
    const [header, payload, signature] = jws.split('.')
    const decodedHeader = JSON.parse(Buffer.from(header!, 'base64url').toString('utf8'))
    const decodedPayload = JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8'))
    expect(decodedHeader).toMatchObject({ alg: 'ES256', typ: 'dpop+jwt' })
    expect(decodedHeader.jwk).toMatchObject({ kty: 'EC', crv: 'P-256' })
    expect(decodedPayload).toMatchObject({ htm: 'POST', htu: 'https://sts.example/tokens' })
    const publicKey = createPublicKey({ key: decodedHeader.jwk, format: 'jwk' })
    const ok = verify('sha256', Buffer.from(`${header}.${payload}`), {
      key: publicKey,
      dsaEncoding: 'ieee-p1363',
    }, Buffer.from(signature!, 'base64url'))
    expect(ok).toBe(true)
  })

  it('builds the portal URL without the parameter that forces the legacy flow', () => {
    const url = buildAuthorizeUrl(12_345, generatePkcePair(), 'ticket-1')
    const parsed = new URL(url)
    expect(parsed.searchParams.get('client_id')).toBe('codearts-agent')
    expect(parsed.searchParams.get('port')).toBe('12345')
    // The real plugin omits this on purpose; sending it makes the portal fall
    // back to the ticket flow.
    expect(parsed.searchParams.get('auth_callback_url')).toBeNull()
    expect(parsed.searchParams.get('code_challenge_method')).toBe('SHA-256')
  })

  it('reads exp from a JWT without trusting it', () => {
    const payload = Buffer.from(JSON.stringify({ exp: 1_792_965_206 })).toString('base64url')
    expect(readJwtExpiry(`a.${payload}.c`)).toBe(1_792_965_206_000)
    expect(readJwtExpiry('nope')).toBeUndefined()
  })

  it('marks only a dead refresh token as terminal', async () => {
    const keyPair = generateDpopKeyPair()
    const fetchMock = vi.fn(async () => json({ error: 'invalid_grant', error_code: 'ExpiredRefreshToken' }))
    await expect(exchangeRefreshToken('rt', 'verifier', keyPair, fetchMock as unknown as typeof fetch))
      .rejects.toBeInstanceOf(RefreshTokenExpiredError)

    const dpopRejected = vi.fn(async () => json({ error: 'InvalidDPoPHeader' }))
    const error = await exchangeRefreshToken('rt', 'verifier', keyPair, dpopRejected as unknown as typeof fetch)
      .catch((caught: unknown) => caught)
    // A DPoP rejection is per-request; treating it as terminal would lock the
    // account until the user logs in again.
    expect(error).not.toBeInstanceOf(RefreshTokenExpiredError)
  })
})

describe('CodeArts catalogue', () => {
  it('strips the dated suffix, keeps the image models and drops duplicates', () => {
    expect(normalizeCodeArtsModelId('deepseek-v4-flash-0731')).toBe('deepseek-v4-flash')
    expect(normalizeCodeArtsModelId('glm-5.3-flash')).toBe('glm-5.3-flash')
    const rows = parseCodeArtsRoster([
      { model_id: 'glm-5.3', model_name: 'GLM-5.3' },
      { model_id: 'GLM-5.3', model_name: 'GLM-5.3 duplicate' },
      { model_id: 'kimi-k2.6-vl', model_name: 'Kimi K2.6 VL', supports_images: true },
      { model_id: 'deepseek-v4-flash-0731', model_name: 'DeepSeek-V4-Flash' },
    ])
    expect(rows.map(row => row.id)).toEqual(['glm-5.3', 'kimi-k2.6-vl', 'deepseek-v4-flash'])
    expect(rows[0]?.images).toBeUndefined()
    expect(rows[1]?.images).toBe(true)
  })

  it('shows the credit slot that is active now', () => {
    const entry = {
      credit: [
        { ratio: '0.05', ratio_display: '0.18x', time_slot_id: 'default' },
        { ratio: '0.05', ratio_display: '0.09x', time_slot_id: 'off_peak' },
      ],
      time_slots: {
        off_peak: { schedule: '0 0 21 * * *', duration: 11, timeunit: 'hour' },
        default: { schedule: null },
      },
    }
    const offPeak = new Date('2026-10-26T13:30:00Z').getTime()
    const midday = new Date('2026-10-26T04:00:00Z').getTime()
    expect(pickActiveCredit(entry.credit, entry.time_slots, offPeak)).toMatchObject({ ratio_display: '0.09x' })
    expect(pickActiveCredit(entry.credit, entry.time_slots, midday)).toMatchObject({ ratio_display: '0.18x' })
    // Crossing midnight keeps the window open (21:00 + 11h ends at 07:59).
    const afterMidnight = new Date('2026-10-26T20:00:00Z').getTime()
    expect(pickActiveCredit(entry.credit, entry.time_slots, afterMidnight)).toMatchObject({ ratio_display: '0.09x' })
  })

  it('reads the multiplier only from the display string', () => {
    expect(priceFactorOfLabel('0.7x')).toBe(0.7)
    expect(priceFactorOfLabel('0.18x')).toBe(0.18)
    expect(priceFactorOfLabel('free')).toBeUndefined()
    expect(priceFactorOfLabel(undefined)).toBeUndefined()
  })

  it('uses the IDE window table and a conservative fallback', () => {
    expect(codeartsContextWindow('GLM-5.3')).toBe(1_048_576)
    expect(codeartsContextWindow('glm-5.2-sft-harmony')).toBe(202_752)
    expect(codeartsContextWindow('some-new-model')).toBe(CODEARTS_FALLBACK_CONTEXT_WINDOW)
  })
})

describe('CodeArts identity', () => {
  function refreshToken(profile: Record<string, unknown>): string {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
    return `${encode({ alg: 'RS256' })}.${encode({ exp: 1_792_751_133, user_profile: encode(profile) })}.sig`
  }

  it('reads the account name out of the refresh token profile', () => {
    const token = refreshToken({
      account_id: '27c94208359d4f50b93a4852dd193797c',
      account_name: 'why15855103187',
      principal_id: 'ffe45f95fe6f4f199b7dbed365215cbc',
    })
    expect(readUserProfile(token)).toEqual({
      userName: 'why15855103187',
      userId: 'ffe45f95fe6f4f199b7dbed365215cbc',
      domainId: '27c94208359d4f50b93a4852dd193797c',
    })
  })

  it('stays empty when the token carries no profile', () => {
    expect(readUserProfile(undefined)).toBeUndefined()
    expect(readUserProfile('opaque')).toBeUndefined()
    expect(readUserProfile(refreshToken({}))).toBeUndefined()
  })

  it('carries the name into the credential a renewal produces', async () => {
    const fetcher = vi.fn(async () => json({
      credentials: { access_key_id: 'AK', secret_access_key: 'SK', security_token: 'ST' },
      refresh_token: refreshToken({ account_name: 'alice' }),
    }))
    const credential = await exchangeRefreshToken(
      'old.token.sig', 'verifier', generateDpopKeyPair(), fetcher as unknown as typeof fetch,
    )
    expect(credential.userName).toBe('alice')
  })
})

describe('CodeArts quota', () => {
  const metrics = [
    { name: 'usageTotalPackageCredit', package_credit_amount: 25_500, package_credit_used: 1_000, package_credit_remain: 24_500 },
    { name: 'usageBasicPackageCredit', package_credit_amount: 500, package_credit_used: 0, package_credit_remain: 500 },
    { name: 'usageBonusPackageCredit', package_credit_amount: 25_000, package_credit_used: 1_000, package_credit_remain: 24_000 },
  ]

  it('keeps the total row out of the pack list but keeps its figures', () => {
    const info = parseCodeArtsPackage({
      package: { is_credit_package: true, package_name_cn: '个人体验版', status: 'NORMAL' },
      end_date: '2026-10-27',
      metrics,
    })
    expect(info.isCreditPackage).toBe(true)
    expect(info.packageName).toBe('个人体验版')
    // The summary row is the only place that reports the allowance and the
    // spend together, which is exactly what a used/total bar needs.
    expect(info.credit).toMatchObject({ amount: 25_500, used: 1_000, remaining: 24_500 })
    // Summing the summary row with its own categories would double the credits.
    expect(info.credit.packs.map(pack => pack.label)).toEqual(['基础积分包', '赠送积分包'])
    expect(info.credit.packs[0]!.expiresAt).toBe(Date.parse('2026-10-27'))
    // Bonus credits expire per grant; borrowing the subscription date is a lie.
    expect(info.credit.packs[1]!.expiresAt).toBeUndefined()
  })

  it('adds the categories up when the gateway omits the summary row', () => {
    const info = parseCodeArtsPackage({ metrics: metrics.slice(1) })
    expect(info.credit).toMatchObject({ amount: 25_500, used: 1_000, remaining: 24_500 })
  })
})

describe('CodeArts reasoning levels', () => {
  it('keeps the two-state switch and drops levels the gateway rejects', () => {
    expect(codeartsEfforts()).toEqual([...CODEARTS_EFFORTS])
    // `none` is this route's spelling of `off`, and `minimal` is editor-only.
    expect(codeartsEfforts({ efforts: ['none', 'minimal', 'low', 'high'] })).toEqual(['off', 'on', 'low', 'high'])
    expect(codeartsEfforts({ efforts: [...CODEARTS_EFFORT_LEVELS].reverse() })).toEqual(CODEARTS_EFFORTS)
    expect(codeartsEfforts({ efforts: [] })).toEqual(['off', 'on'])
  })
})

describe('CodeArts provider', () => {
  const options: GenerateOptions = {
    provider: 'codearts',
    model: 'glm-5.3',
    messages: [{
      role: 'user',
      id: 'u' as never,
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'hi' }],
    }],
    maxTokens: 200_000,
  }

  function make(
    auth: Record<string, unknown>,
    fetchImpl: typeof fetch,
    window = new CodeArtsSessionWindow(),
    openRouter: OpenRouterIndex = EMPTY_OPENROUTER_INDEX,
  ): CodeArtsProvider {
    return new CodeArtsProvider({
      auth: auth as never,
      store: { saveCodearts: vi.fn(), codearts: async () => undefined } as never,
      ttlMs: () => 60_000,
      timeoutMs: () => 1_000,
      textOnly: () => new Set(),
      forceVision: () => new Set(),
      openRouter: { models: async () => openRouter, invalidate: () => {} },
      fetchImpl,
      window,
    })
  }

  it('reports the allowance and the spend so the card can draw a bar', async () => {
    const provider = make({
      status: async () => ({ signedIn: true }),
      credential: async () => ({ accessKeyId: 'AK', secretAccessKey: 'SK', securityToken: 'ST' }),
      refresh: async () => ({ accessKeyId: 'AK', secretAccessKey: 'SK', securityToken: 'ST' }),
      logout: async () => undefined,
    }, (async () => json({
      package: { is_credit_package: true, package_name_cn: '体验版' },
      metrics: [
        { name: 'usageTotalPackageCredit', package_credit_amount: 21_500, package_credit_used: 13.05, package_credit_remain: 21_486.95 },
        { name: 'usageBonusPackageCredit', package_credit_amount: 21_000, package_credit_used: 13.05, package_credit_remain: 20_986.95 },
      ],
    })) as unknown as typeof fetch)

    expect(await provider.quota(true)).toMatchObject({ total: 21_500, used: 13.05, plan: '体验版' })
  })

  it('sends a signed chat request with thinking off and a clamped budget', async () => {
    const seen: { headers: Record<string, string>, body: Record<string, unknown> }[] = []
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      seen.push({
        headers: init.headers as Record<string, string>,
        body: JSON.parse(String(init.body)) as Record<string, unknown>,
      })
      return sse([
        JSON.stringify({ choices: [{ delta: { content: 'hi' } }] }),
        JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
        '[DONE]',
      ])
    })
    const provider = make({
      status: async () => ({ signedIn: true }),
      credential: async () => ({ accessKeyId: 'AK', secretAccessKey: 'SK', securityToken: 'ST' }),
      refresh: async () => ({ accessKeyId: 'AK', secretAccessKey: 'SK', securityToken: 'ST' }),
      logout: async () => undefined,
    }, fetchMock as unknown as typeof fetch)

    const chunks = await collect(provider.stream({ ...options, reasoningEffort: 'off' as never }, 'glm-5.3', undefined, () => undefined))
    expect(chunks.some(chunk => chunk.type === 'text-delta')).toBe(true)
    expect(seen).toHaveLength(1)
    const headers = seen[0]!.headers
    expect(headers.Authorization ?? headers.authorization).toMatch(/^SDK-HMAC-SHA256 Access=AK/)
    expect(headers['chat-id']).toBeTruthy()
    expect(headers['session-id']).toBeTruthy()
    const body = seen[0]!.body
    expect(body).toMatchObject({
      model: 'glm-5.3',
      stream: true,
      tool_stream: true,
      thinking: { type: 'disabled' },
      // 200K is over the gateway's cap; sending it verbatim is a hard 4xx.
      max_tokens: 65_536,
    })
    expect(body.tools).toBeUndefined()
  })

  it('forwards a reasoning level without disturbing the two-state switch', async () => {
    const bodies: Record<string, unknown>[] = []
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>)
      return sse([
        JSON.stringify({ choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }] }),
        '[DONE]',
      ])
    })
    const provider = make({
      status: async () => ({ signedIn: true }),
      credential: async () => ({ accessKeyId: 'AK', secretAccessKey: 'SK', securityToken: 'ST' }),
      refresh: async () => ({ accessKeyId: 'AK', secretAccessKey: 'SK', securityToken: 'ST' }),
      logout: async () => undefined,
    }, fetchMock as unknown as typeof fetch)

    await collect(provider.stream({ ...options, reasoningEffort: 'high' as never }, 'glm-5.3', undefined, () => undefined))
    expect(bodies[0]).toMatchObject({ reasoning_effort: 'high' })
    expect(bodies[0]!.thinking).toBeUndefined()

    // `on` is what old saved selections hold; it still sends neither field.
    await collect(provider.stream({ ...options, reasoningEffort: 'on' as never }, 'glm-5.3', undefined, () => undefined))
    expect(bodies[1]!.reasoning_effort).toBeUndefined()
    expect(bodies[1]!.thinking).toBeUndefined()
  })

  it('retries without maas_type when the account has no benefit pack', async () => {
    const bodies: Record<string, unknown>[] = []
    const headers: Record<string, string>[] = []
    let call = 0
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      call++
      headers.push(init.headers as Record<string, string>)
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>)
      if (call === 1) return json({ error_code: 'InferHub.4004.200', error_msg: 'not registered' }, 404)
      return sse([JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }), '[DONE]'])
    })
    const provider = make({
      status: async () => ({ signedIn: true }),
      credential: async () => ({ accessKeyId: 'AK', secretAccessKey: 'SK', securityToken: 'ST' }),
      refresh: async () => ({ accessKeyId: 'AK', secretAccessKey: 'SK', securityToken: 'ST' }),
      logout: async () => undefined,
    }, fetchMock as unknown as typeof fetch)

    await collect(provider.stream(options, 'glm-5.3-flash', undefined, () => undefined))
    expect(call).toBe(2)
    // First attempt carries the signed benefit header, the retry does not.
    expect(headers[0]!.maas_type).toBe('benefit')
    expect(headers[1]!.maas_type).toBeUndefined()
    expect(bodies[1]!.model).toBe('glm-5.3-flash')
  })

  it('renews the credential once when the gateway rejects the signature', async () => {
    const tokens: string[] = []
    let call = 0
    // The auth layer persists the renewed triple, so the next `credential()`
    // returns the new security token — the provider must re-sign with it.
    let current = 'ST'
    const refresh = vi.fn(async () => {
      current = 'ST2'
      return { accessKeyId: 'AK', secretAccessKey: 'SK', securityToken: current }
    })
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      call++
      tokens.push((init.headers as Record<string, string>)['x-security-token']!)
      if (call === 1) return json({ error_code: 'APIG.0602', error_msg: 'Invalid token' }, 401)
      return sse([JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }), '[DONE]'])
    })
    const provider = make({
      status: async () => ({ signedIn: true }),
      credential: async () => ({ accessKeyId: 'AK', secretAccessKey: 'SK', securityToken: current }),
      refresh,
      logout: async () => undefined,
    }, fetchMock as unknown as typeof fetch)

    await collect(provider.stream(options, 'glm-5.3', undefined, () => undefined))
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(tokens).toEqual(['ST', 'ST2'])
  })

  it('reports an unregistered model as a request error', async () => {
    const fetchMock = vi.fn(async () => json({ error_code: 'InferHub.002002009.404', error_msg: 'not registered' }, 400))
    const provider = make({
      status: async () => ({ signedIn: true }),
      credential: async () => ({ accessKeyId: 'AK', secretAccessKey: 'SK', securityToken: 'ST' }),
      refresh: async () => ({ accessKeyId: 'AK', secretAccessKey: 'SK', securityToken: 'ST' }),
      logout: async () => undefined,
    }, fetchMock as unknown as typeof fetch)

    const error = await collect(provider.stream(options, 'nope', undefined, () => undefined))
      .catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ProviderHttpError)
    expect((error as ProviderHttpError).status).toBe(400)
  })

  it('merges both rosters into one catalogue with the IDE windows', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('gateway/config')) {
        return json({ result: { models: [{ model_id: 'glm-5.3-flash', model_name: 'GLM-5.3-Flash' }] } })
      }
      return json({
        builtinModels: [
          { model_id: 'GLM-5.2', model_name: 'GLM-5.2', credit: [{ ratio: '0.05', ratio_display: '0.7x' }] },
          { model_id: 'kimi-k2.6-vl', model_name: 'Kimi K2.6 VL', supports_images: true },
          { model_id: 'openpangu-2.0-pro', model_name: 'openPangu-2.0-Pro' },
        ],
      })
    })
    const provider = make({
      status: async () => ({ signedIn: true }),
      credential: async () => ({ accessKeyId: 'AK', secretAccessKey: 'SK', securityToken: 'ST' }),
      refresh: async () => ({ accessKeyId: 'AK', secretAccessKey: 'SK', securityToken: 'ST' }),
      logout: async () => undefined,
    }, fetchMock as unknown as typeof fetch)

    const models = await provider.models(true)
    expect(models.map(model => model.id)).toEqual(['glm-5.3-flash', 'GLM-5.2', 'kimi-k2.6-vl', 'openpangu-2.0-pro'])
    expect(models[0]).toMatchObject({ reasoningEfforts: CODEARTS_EFFORTS, defaultReasoningEffort: 'on' })
    expect(CODEARTS_EFFORTS).toEqual(['off', 'on', 'low', 'medium', 'high', 'xhigh', 'max'])
    expect(models[1]).toMatchObject({ contextWindow: 1_048_576, priceFactor: 0.7 })
    // The image models are hidden from the IDE's own menu but still served.
    expect(models[2]).toMatchObject({ contextWindow: 262_144, vision: true })
    expect(models[3]!.contextWindow).toBe(524_288)
    // Everything else answers `InferHub.001001020.406` when handed an image.
    expect(models.filter(model => model.vision === true).map(model => model.id)).toEqual(['kimi-k2.6-vl'])
  })

  it('narrows the graded levels to what OpenRouter says the model accepts', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('gateway/config')) {
        return json({ result: { models: [{ model_id: 'deepseek-v4.1-flash-1017', model_name: 'DeepSeek-V4.1-Flash' }] } })
      }
      return json({ builtinModels: [] })
    })
    const provider = make({
      status: async () => ({ signedIn: true }),
      credential: async () => ({ accessKeyId: 'AK', secretAccessKey: 'SK', securityToken: 'ST' }),
      refresh: async () => ({ accessKeyId: 'AK', secretAccessKey: 'SK', securityToken: 'ST' }),
      logout: async () => undefined,
    }, fetchMock as unknown as typeof fetch, new CodeArtsSessionWindow(), buildOpenRouterIndex([
      {
        id: 'deepseek/deepseek-v4.1-flash',
        name: 'DeepSeek V4.1 Flash',
        inputModalities: ['text'],
        efforts: ['none', 'minimal', 'low', 'medium', 'high'],
        mandatory: false,
      },
    ]))

    const models = await provider.models(true)
    expect(models[0]!.id).toBe('deepseek-v4.1-flash')
    expect(models[0]!.reasoningEfforts).toEqual(['off', 'on', 'low', 'medium', 'high'])
  })

  it('retries without maas_type when the first frame reports no benefit pack', async () => {
    const headers: Record<string, string>[] = []
    let call = 0
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      call++
      headers.push(init.headers as Record<string, string>)
      // The real gateway answers HTTP 200 and puts the failure in the stream.
      if (call === 1) {
        return sse([JSON.stringify({ error_code: 'InferHub.4004.200', error_msg: 'benefit not found' })])
      }
      return sse([JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }), '[DONE]'])
    })
    const provider = make({
      status: async () => ({ signedIn: true }),
      credential: async () => ({ accessKeyId: 'AK', secretAccessKey: 'SK', securityToken: 'ST' }),
      refresh: async () => ({ accessKeyId: 'AK', secretAccessKey: 'SK', securityToken: 'ST' }),
      logout: async () => undefined,
    }, fetchMock as unknown as typeof fetch)

    const chunks = await collect(provider.stream(options, 'deepseek-v4.1-flash', undefined, () => undefined))
    expect(call).toBe(2)
    expect(headers[0]!.maas_type).toBe('benefit')
    expect(headers[1]!.maas_type).toBeUndefined()
    expect(chunks.some(chunk => chunk.type === 'text-delta')).toBe(true)
  })

  it('reads the check-in list from the data envelope and confirms the claim', async () => {
    const calls: string[] = []
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${url.replace(/^https?:\/\/[^/]+/, '')}`)
      if (url.includes('/v1/ops/delivery')) {
        return json({
          code: 0,
          message: 'ok',
          data: {
            channel: 'IDE',
            items: [{
              campaignId: 1,
              type: 'USER_LOGIN',
              title: '每日签到领积分',
              claimable: true,
              status: 'ELIGIBLE',
              benefitAmount: 1000,
            }],
          },
        })
      }
      if (url.includes('/v1/ops/claim')) {
        return json({ code: 0, message: 'ok', data: { id: 994_376, totalAmount: 1000 } })
      }
      if (url.includes('/v1/ops/confirm')) return json({ code: 0, message: 'ok', data: { id: 2 } })
      return json({ package: { is_credit_package: true, package_name_cn: '体验版' }, metrics: [] })
    })
    const provider = make({
      status: async () => ({ signedIn: true }),
      credential: async () => ({ accessKeyId: 'AK', secretAccessKey: 'SK', securityToken: 'ST' }),
      refresh: async () => ({ accessKeyId: 'AK', secretAccessKey: 'SK', securityToken: 'ST' }),
      logout: async () => undefined,
    }, fetchMock as unknown as typeof fetch)

    expect(await provider.checkinStatus()).toMatchObject({ available: true, claimed: false, reward: 1000 })
    expect(await provider.claimCheckin()).toMatchObject({ claimed: true, reward: 1000 })
    // The claim is booked only after the confirm call, and it carries the same
    // numeric campaign id the list handed out.
    expect(calls.filter(entry => entry.startsWith('POST'))).toEqual([
      'POST /v1/ops/claim',
      'POST /v1/ops/confirm',
    ])
  })

  it('waits out the per-minute session cap instead of failing the turn', async () => {
    vi.useFakeTimers()
    try {
      let calls = 0
      const fetchMock = vi.fn(async () => {
        calls++
        if (calls === 1) {
          return new Response(JSON.stringify({ error_code: 'TM.00001041', error_msg: '并发会话数已达上限(3个)' }), {
            status: 429,
            headers: { 'content-type': 'application/json' },
          })
        }
        return sse([JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }), '[DONE]'])
      })
      const provider = make({
        status: async () => ({ signedIn: true }),
        credential: async () => ({ accessKeyId: 'AK', secretAccessKey: 'SK', securityToken: 'ST' }),
        refresh: async () => ({ accessKeyId: 'AK', secretAccessKey: 'SK', securityToken: 'ST' }),
        logout: async () => undefined,
      }, fetchMock as unknown as typeof fetch)

      const pending = collect(provider.stream(options, 'glm-5.3', undefined, () => undefined))
      // The cap is a rate limit, so the retry must not fire immediately.
      await vi.advanceTimersByTimeAsync(19_000)
      expect(calls).toBe(1)
      await vi.advanceTimersByTimeAsync(2_000)
      const chunks = await pending
      expect(calls).toBe(2)
      expect(chunks.some(chunk => chunk.type === 'text-delta')).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports a cap that never lifts as a readable error', async () => {
    vi.useFakeTimers()
    try {
      const fetchMock = vi.fn(async () => new Response(
        JSON.stringify({ error_code: 'TM.00001041', error_msg: '并发会话数已达上限(3个)' }),
        { status: 429, headers: { 'content-type': 'application/json' } },
      ))
      // A wide window keeps this test about the retry budget, not the wait.
      const provider = make({
        status: async () => ({ signedIn: true }),
        credential: async () => ({ accessKeyId: 'AK', secretAccessKey: 'SK', securityToken: 'ST' }),
        refresh: async () => ({ accessKeyId: 'AK', secretAccessKey: 'SK', securityToken: 'ST' }),
        logout: async () => undefined,
      }, fetchMock as unknown as typeof fetch, new CodeArtsSessionWindow(100, 60_000))

      const pending = collect(provider.stream(options, 'glm-5.3', undefined, () => undefined))
        .catch((caught: unknown) => caught)
      await vi.advanceTimersByTimeAsync(120_000)
      const error = await pending
      expect(error).toBeInstanceOf(ProviderHttpError)
      expect((error as ProviderHttpError).status).toBe(429)
      expect((error as ProviderHttpError).message).toContain('3 个会话')
      expect(fetchMock).toHaveBeenCalledTimes(4)
    } finally {
      vi.useRealTimers()
    }
  })

  it('caps the output budget at the gateway limit', () => {
    expect(clampMaxTokens(undefined)).toBe(65_536)
    expect(clampMaxTokens(4_096)).toBe(4_096)
    expect(clampMaxTokens(999_999)).toBe(65_536)
    expect(clampMaxTokens(-5)).toBe(65_536)
  })
})
