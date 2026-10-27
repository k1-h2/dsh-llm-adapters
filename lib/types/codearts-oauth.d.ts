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
import type { KeyObject } from 'node:crypto';
/** The credential the gateway signs with, plus everything a refresh needs. */
export interface CodeArtsCredential {
    accessKeyId: string;
    secretAccessKey: string;
    securityToken: string;
    /** Epoch ms; the STS token lives two hours. */
    expiresAt?: number;
    refreshToken?: string;
    codeVerifier?: string;
    dpopPrivateJwk?: DpopPrivateJwk;
    /** Display only, from the refresh token's profile; never used for signing. */
    userName?: string;
}
/** Who the credential belongs to, as the portal encoded it in the token. */
export interface CodeArtsUserProfile {
    userId?: string;
    userName?: string;
    domainId?: string;
}
export interface PkcePair {
    codeVerifier: string;
    codeChallenge: string;
}
export interface DpopPublicJwk {
    kty: 'EC';
    crv: 'P-256';
    x: string;
    y: string;
}
export interface DpopPrivateJwk extends DpopPublicJwk {
    d: string;
}
export interface DpopKeyPair {
    privateKeyJwk: DpopPrivateJwk;
    publicKeyJwk: DpopPublicJwk;
}
/** The refresh token itself is gone; only a new login helps. */
export declare class RefreshTokenExpiredError extends Error {
    constructor(message: string);
}
export declare function generatePkcePair(): PkcePair;
export declare function generateDpopKeyPair(): DpopKeyPair;
/** Rebuild the key pair from the stored private JWK (the public half is in it). */
export declare function keyPairFromStoredJwk(jwk: DpopPrivateJwk): DpopKeyPair;
/** A `dpop+jwt` proof binding this request method and URL to the key pair. */
export declare function signDpopJws(keyPair: DpopKeyPair, htm: string, htu: string): string;
/** Read `exp` from a JWT without verifying it (scheduling only, never trust). */
export declare function readJwtExpiry(token: string): number | undefined;
/**
 * Read the account identity out of a refresh token.
 *
 * The STS response carries no profile — `credentials` is the AK/SK/token triple
 * and nothing else — so a card built from it alone has nothing to put next to
 * 账号. The portal does name the user, but only inside the refresh token: its
 * `user_profile` claim is a second base64 JSON blob holding `account_name`,
 * `principal_id` and `account_id`. Decoding it is read-only and needs no extra
 * request; without it the field stays empty and the page says so.
 */
export declare function readUserProfile(token: string | undefined): CodeArtsUserProfile | undefined;
/** The portal URL the browser opens; the callback is on loopback. */
export declare function buildAuthorizeUrl(port: number, pkce: PkcePair, ticketId: string): string;
/** Where the browser lands after a successful or failed exchange. */
export declare function buildLoginResultUrl(succeeded: boolean): string;
export declare function redirectUri(port: number): string;
export declare function exchangeAuthorizationCode(code: string, codeVerifier: string, port: number, keyPair: DpopKeyPair, fetcher?: typeof fetch): Promise<CodeArtsCredential>;
export declare function exchangeRefreshToken(refreshToken: string, codeVerifier: string, keyPair: DpopKeyPair, fetcher?: typeof fetch): Promise<CodeArtsCredential>;
/** Whether a credential carries everything a signed request needs. */
export declare function credentialUsable(credential: CodeArtsCredential | undefined): credential is CodeArtsCredential;
/** Exported for tests: the public half must be derivable from the private JWK. */
export declare function publicKeyOf(jwk: DpopPrivateJwk): KeyObject;
