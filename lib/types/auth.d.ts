/**
 * Credential state for every provider.
 *
 * Sign-in happens in the provider's own web page, so credentials exist in
 * exactly one place: the plugin's own account store. No desktop client file is
 * discovered, read, or written, and no token leaves this module in errors or
 * display fields.
 *
 * @module dsh-llm-adapters/auth
 */
import type { AccountStore } from './account-store.ts';
import type { TraeRegion } from './brand.ts';
import type { CodeArtsCredential } from './codearts-oauth.ts';
export interface LocalAccount {
    name?: string;
    phone?: string;
    userId?: string;
    ownerType?: string;
    sessionId?: string;
}
export interface AuthStatus {
    signedIn: boolean;
    loginAt?: number;
    expiresAt?: number;
    /** The stored credential is past its own expiry. */
    possiblyExpired?: boolean;
    account?: LocalAccount;
    error?: string;
}
export declare class LoomyAuth {
    private readonly store;
    constructor(store: AccountStore);
    status(): Promise<AuthStatus>;
    /** The bearer session, or undefined when there is no stored login. */
    session(): Promise<string | undefined>;
    logout(): Promise<void>;
}
export interface JwtFacts {
    expiresAt?: number;
    name?: string;
    phone?: string;
    ownerType?: string;
    sessionId?: string;
}
/** Read non-secret JWT claims; malformed tokens simply yield no facts. */
export declare function decodeJwtFacts(token: string): JwtFacts;
export declare class RaccoonAuth {
    private readonly store;
    constructor(store: AccountStore);
    status(): Promise<AuthStatus>;
    /**
     * The stored access token.
     *
     * A QR login has no refresh flow. `force` marks a gateway 401, so the only
     * honest answer then is to ask for a new scan.
     */
    accessToken(force?: boolean): Promise<string>;
    logout(): Promise<void>;
}
/**
 * Trae's web login, one per region.
 *
 * The `Cloud-IDE-JWT` the website issues lives about eight hours, but the
 * website session behind it lives about fourteen days. The cookies captured at
 * sign-in are replayed against `GetUserToken` to renew the short token silently;
 * only when the session itself dies does the user have to sign in again.
 */
export declare class TraeAuth {
    private readonly store;
    private readonly currentRegion;
    private readonly fetchImpl;
    private readonly inflight;
    private lastError;
    constructor(store: AccountStore, currentRegion: () => TraeRegion, fetchImpl?: typeof fetch);
    region(): TraeRegion;
    status(): Promise<AuthStatus>;
    /**
     * The bearer token, or an actionable error when there is none.
     *
     * A token near its expiry is renewed first; `force` means the gateway already
     * rejected it, so the renewal is attempted even if the clock disagrees.
     */
    accessToken(force?: boolean): Promise<string>;
    /** Renew the eight-hour JWT with the stored website cookies. */
    private refresh;
    /** The fingerprints captured from the web session, replayed on every call. */
    identity(): Promise<{
        deviceId: string;
        machineId: string;
        userId?: string;
    }>;
    logout(): Promise<void>;
}
/**
 * CodeArts credentials.
 *
 * There is no bearer token: the gateway verifies a signature over each request,
 * so what this class hands out is the AK/SK/security-token triple. The STS token
 * lives two hours and is renewed with the refresh token; both the PKCE verifier
 * and the DPoP private key from the original login have to be reused, or Huawei
 * rejects the renewal.
 */
export declare class CodeArtsAuth {
    private readonly store;
    private inflight;
    private lastError;
    constructor(store: AccountStore);
    status(): Promise<AuthStatus>;
    /** A usable triple, renewed first when it is close to expiring. */
    credential(): Promise<CodeArtsCredential>;
    /**
     * Renew the triple.
     *
     * `force` is used when the gateway rejected a signature the local clock still
     * considered valid (revoked or rotated token). A single in-flight renewal is
     * shared, so parallel requests do not each spend a refresh.
     */
    refresh(force: boolean): Promise<CodeArtsCredential>;
    logout(): Promise<void>;
}
