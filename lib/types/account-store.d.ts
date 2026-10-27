/**
 * Plugin-owned credentials for account login.
 *
 * Sign-in happens in the provider's own web page. The resulting session or
 * token is stored here — the only credential source. The file is written
 * atomically and restricted to the current user; tokens are never logged or
 * returned to the browser.
 *
 * Trae keeps one account per region: switching regions must restore that
 * region's own login instead of overwriting the other one.
 *
 * @module dsh-llm-adapters/account-store
 */
import type { BrandId, TraeRegion } from './brand.ts';
export interface LoomyAccountRecord {
    session: string;
    userId?: string;
    phone?: string;
    name?: string;
    /** Stable per-user device id sent to the account service. */
    deviceId: string;
    loginAt: number;
    expiresAt: number;
}
export interface RaccoonAccountRecord {
    accessToken: string;
    phone?: string;
    name?: string;
    ownerType?: string;
    loginAt: number;
}
/**
 * One Trae web login.
 *
 * `accessToken` is the `Cloud-IDE-JWT` the website itself uses. `deviceId` and
 * `machineId` are the fingerprints captured from that web session — this
 * plugin never reads a desktop install — and are replayed on chat, quota and
 * check-in requests.
 */
export interface TraeAccountRecord {
    accessToken: string;
    region: TraeRegion;
    deviceId: string;
    machineId: string;
    userId?: string;
    name?: string;
    loginAt: number;
    /** The `Cloud-IDE-JWT` expiry (about 8 hours); absent when the JWT carries none. */
    expiresAt?: number;
    /**
     * Cookies captured from the sign-in browser.
     *
     * `GetUserToken` accepts these instead of a password, so the short-lived JWT
     * can be renewed silently until the web session itself expires.
     */
    cookies?: string;
    /** The website session's expiry, read from the login response (about 14 days). */
    sessionExpiresAt?: number;
}
/**
 * One CodeArts sign-in.
 *
 * The gateway takes no bearer token: every request is signed with the AK/SK
 * pair plus the STS security token. `refreshToken`, `codeVerifier` and the DPoP
 * private key are kept because a refresh has to reuse the same PKCE verifier and
 * the same key — a fresh pair is rejected.
 */
export interface CodeArtsAccountRecord {
    accessKeyId: string;
    secretAccessKey: string;
    securityToken: string;
    /** Epoch ms; the STS token lasts two hours. */
    expiresAt?: number;
    refreshToken?: string;
    codeVerifier?: string;
    dpopPrivateJwk?: {
        kty: 'EC';
        crv: 'P-256';
        x: string;
        y: string;
        d: string;
    };
    userName?: string;
    /**
     * Models the account answered `InferHub.4004.200` for.
     *
     * The verdict is worth persisting: asking with `maas_type: benefit` spends
     * one of the three chat slots the plan allows per minute, even though the
     * call cannot succeed.
     */
    noBenefit?: string[];
    loginAt: number;
}
export interface StoredAccounts {
    loomy?: LoomyAccountRecord;
    raccoon?: RaccoonAccountRecord;
    trae?: Partial<Record<TraeRegion, TraeAccountRecord>>;
    codearts?: CodeArtsAccountRecord;
}
export declare class AccountStore {
    private readonly root;
    private writeChain;
    constructor(root?: () => string);
    path(): string;
    /** The plugin's own data directory (also holds the OpenRouter snapshot). */
    directory(): string;
    read(): Promise<StoredAccounts>;
    loomy(): Promise<LoomyAccountRecord | undefined>;
    raccoon(): Promise<RaccoonAccountRecord | undefined>;
    trae(region: TraeRegion): Promise<TraeAccountRecord | undefined>;
    codearts(): Promise<CodeArtsAccountRecord | undefined>;
    saveLoomy(record: LoomyAccountRecord): Promise<void>;
    saveRaccoon(record: RaccoonAccountRecord): Promise<void>;
    saveTrae(record: TraeAccountRecord): Promise<void>;
    saveCodearts(record: CodeArtsAccountRecord): Promise<void>;
    clear(brand: BrandId, region?: TraeRegion): Promise<void>;
    /**
     * A device id for the Loomy account service.
     *
     * Generated once and reused, so an account keeps looking like one device
     * across logins; `traceid` remains per-request.
     */
    loomyDeviceId(): Promise<string>;
    /**
     * Read-modify-write inside the write queue.
     *
     * The read has to happen there too: a token refresh and a login landing at
     * the same time would otherwise both read the same old file and the second
     * write would drop the first one's brand.
     */
    private update;
    private writeFile;
}
