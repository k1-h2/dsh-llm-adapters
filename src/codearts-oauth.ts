/**
 * CodeArts login: PKCE + DPoP against Huawei's STS, and the credential shape
 * that survives a restart.
 *
 * The portal hands the local callback a one-time `code`; exchanging it needs two
 * proofs that no other provider in this plugin uses:
 *
 * - **PKCE** (`S256`) ties the code to the process that asked for it.
 * - **DPoP** (`ES256`, `typ: dpop+jwt`) ties the token request to a key pair.
 *   The private key is stored with the credential because every refresh has to
 *   sign with the *same* key — a new one is rejected.
 *
 * Both are implemented on `node:crypto` (no dependency): a JWS signature is the
 * raw 64-byte `R||S` pair, which `dsaEncoding: 'ieee-p1363'` produces directly.
 *
 * @module dsh-llm-adapters/codearts-oauth
 */

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import type { KeyObject } from 'node:crypto'
import {
  CODEARTS_CLIENT_ID, CODEARTS_PORTAL_AUTHORIZE, CODEARTS_PORTAL_LOGIN, CODEARTS_REDIRECT_PATH,
  CODEARTS_STS_TOKEN_URL,
} from './codearts-endpoints.ts'

/** The credential the gateway signs with, plus everything a refresh needs. */
export interface CodeArtsCredential {
  accessKeyId: string
  secretAccessKey: string
  securityToken: string
  /** Epoch ms; the STS token lives two hours. */
  expiresAt?: number
  refreshToken?: string
  codeVerifier?: string
  dpopPrivateJwk?: DpopPrivateJwk
}

export interface PkcePair {
  codeVerifier: string
  codeChallenge: string
}

export interface DpopPublicJwk {
  kty: 'EC'
  crv: 'P-256'
  x: string
  y: string
}

export interface DpopPrivateJwk extends DpopPublicJwk {
  d: string
}

export interface DpopKeyPair {
  privateKeyJwk: DpopPrivateJwk
  publicKeyJwk: DpopPublicJwk
}

interface TokenResponse {
  credentials?: {
    access_key_id?: string
    secret_access_key?: string
    security_token?: string
    expiration?: string
  }
  refresh_token?: string
  error?: string
  error_code?: string
  error_msg?: string
}

/** The refresh token itself is gone; only a new login helps. */
export class RefreshTokenExpiredError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RefreshTokenExpiredError'
  }
}

export function generatePkcePair(): PkcePair {
  const codeVerifier = randomBytes(48).toString('base64url')
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url')
  return { codeVerifier, codeChallenge }
}

export function generateDpopKeyPair(): DpopKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const privateKeyJwk = privateKey.export({ format: 'jwk' }) as unknown as DpopPrivateJwk
  const publicKeyJwk = publicKey.export({ format: 'jwk' }) as unknown as DpopPublicJwk
  return {
    privateKeyJwk: { kty: 'EC', crv: 'P-256', x: privateKeyJwk.x, y: privateKeyJwk.y, d: privateKeyJwk.d },
    publicKeyJwk: { kty: 'EC', crv: 'P-256', x: publicKeyJwk.x, y: publicKeyJwk.y },
  }
}

/** Rebuild the key pair from the stored private JWK (the public half is in it). */
export function keyPairFromStoredJwk(jwk: DpopPrivateJwk): DpopKeyPair {
  return {
    privateKeyJwk: jwk,
    publicKeyJwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y },
  }
}

function privateKeyOf(keyPair: DpopKeyPair): KeyObject {
  return createPrivateKey({ key: keyPair.privateKeyJwk as unknown as Record<string, unknown>, format: 'jwk' })
}

/** A `dpop+jwt` proof binding this request method and URL to the key pair. */
export function signDpopJws(keyPair: DpopKeyPair, htm: string, htu: string): string {
  const header = { alg: 'ES256', typ: 'dpop+jwt', jwk: keyPair.publicKeyJwk }
  const payload = {
    htm,
    htu,
    iat: Math.floor(Date.now() / 1000),
    jti: randomBytes(32).toString('hex'),
  }
  const signingInput = `${Buffer.from(JSON.stringify(header)).toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`
  const signature = sign('sha256', Buffer.from(signingInput), {
    key: privateKeyOf(keyPair),
    dsaEncoding: 'ieee-p1363',
  })
  return `${signingInput}.${signature.toString('base64url')}`
}

/** Read `exp` from a JWT without verifying it (scheduling only, never trust). */
export function readJwtExpiry(token: string): number | undefined {
  const parts = token.split('.')
  if (parts.length !== 3) return undefined
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as Record<string, unknown>
    const exp = payload.exp
    if (typeof exp !== 'number' || !Number.isFinite(exp)) return undefined
    const ms = exp * 1000
    return Math.abs(ms) > 1e14 ? undefined : ms
  } catch {
    return undefined
  }
}

/** The portal URL the browser opens; the callback is on loopback. */
export function buildAuthorizeUrl(port: number, pkce: PkcePair, ticketId: string): string {
  return `${CODEARTS_PORTAL_AUTHORIZE}?theme=2&locale=zh-cn`
    + `&uri_scheme=${CODEARTS_CLIENT_ID}&client_id=${CODEARTS_CLIENT_ID}&port=${port}`
    // The real plugin sends `SHA-256`, not the RFC's `S256`; the portal uses the
    // spelling to tell OAuth apart from the legacy ticket flow.
    + `&code_challenge=${pkce.codeChallenge}&code_challenge_method=SHA-256`
    + `&ticket_id=${ticketId}&plugin-name=snap_AIIDE&plugin-version=5.2.0`
}

/** Where the browser lands after a successful or failed exchange. */
export function buildLoginResultUrl(succeeded: boolean): string {
  return `${CODEARTS_PORTAL_LOGIN}?login_succeed=${succeeded}&uri_scheme=${CODEARTS_CLIENT_ID}&locale=zh-cn`
}

export function redirectUri(port: number): string {
  return `http://127.0.0.1:${port}${CODEARTS_REDIRECT_PATH}`
}

async function requestToken(
  body: Record<string, string>,
  keyPair: DpopKeyPair,
  fetcher: typeof fetch,
): Promise<TokenResponse> {
  const response = await fetcher(CODEARTS_STS_TOKEN_URL, {
    method: 'POST',
    headers: {
      DPoP: signDpopJws(keyPair, 'POST', CODEARTS_STS_TOKEN_URL),
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(60_000),
  })
  let data: TokenResponse | null = null
  try {
    data = await response.json() as TokenResponse
  } catch {
    data = null
  }
  if (!response.ok || data?.credentials === undefined) {
    const message = `CodeArts 令牌请求失败：HTTP ${response.status}${data === null ? '' : ` ${JSON.stringify(data)}`}`
    // Only these two mean the refresh token is dead. A DPoP rejection is a
    // per-request fact (clock skew, replay window) and must not mark the account
    // unusable, which is what the reference implementation had to fix.
    if (data?.error === 'invalid_grant' || String(data?.error_code ?? '').includes('ExpiredRefreshToken')) {
      throw new RefreshTokenExpiredError(message)
    }
    throw new Error(message)
  }
  return data
}

export async function exchangeAuthorizationCode(
  code: string,
  codeVerifier: string,
  port: number,
  keyPair: DpopKeyPair,
  fetcher: typeof fetch = fetch,
): Promise<CodeArtsCredential> {
  const token = await requestToken({
    client_id: CODEARTS_CLIENT_ID,
    code,
    code_verifier: codeVerifier,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri(port),
  }, keyPair, fetcher)
  return credentialFrom(token, codeVerifier, keyPair)
}

export async function exchangeRefreshToken(
  refreshToken: string,
  codeVerifier: string,
  keyPair: DpopKeyPair,
  fetcher: typeof fetch = fetch,
): Promise<CodeArtsCredential> {
  const token = await requestToken({
    client_id: CODEARTS_CLIENT_ID,
    code_verifier: codeVerifier,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  }, keyPair, fetcher)
  const credential = credentialFrom(token, codeVerifier, keyPair)
  // A refresh response may omit the rotated refresh token; keep the old one so
  // the next refresh is still possible.
  return { ...credential, refreshToken: credential.refreshToken ?? refreshToken }
}

function credentialFrom(token: TokenResponse, codeVerifier: string, keyPair: DpopKeyPair): CodeArtsCredential {
  const credentials = token.credentials ?? {}
  const expiration = credentials.expiration
  const expiresAt = expiration === undefined ? undefined : Date.parse(expiration)
  return {
    accessKeyId: credentials.access_key_id ?? '',
    secretAccessKey: credentials.secret_access_key ?? '',
    securityToken: credentials.security_token ?? '',
    ...expiresAt === undefined || Number.isNaN(expiresAt) ? {} : { expiresAt },
    ...token.refresh_token === undefined ? {} : { refreshToken: token.refresh_token },
    codeVerifier,
    dpopPrivateJwk: keyPair.privateKeyJwk,
  }
}

/** Whether a credential carries everything a signed request needs. */
export function credentialUsable(credential: CodeArtsCredential | undefined): credential is CodeArtsCredential {
  return credential !== undefined
    && credential.accessKeyId.length > 0
    && credential.secretAccessKey.length > 0
    && credential.securityToken.length > 0
}

/** Exported for tests: the public half must be derivable from the private JWK. */
export function publicKeyOf(jwk: DpopPrivateJwk): KeyObject {
  return createPublicKey({ key: jwk as unknown as Record<string, unknown>, format: 'jwk' })
}
