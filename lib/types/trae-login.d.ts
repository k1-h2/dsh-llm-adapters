/**
 * Trae sign-in through the provider's own website.
 *
 * The plugin does not read a desktop install: it opens a dedicated browser
 * profile, lets the user sign in on trae.cn / trae.ai, and then takes the
 * session the website itself created. Two things come out of that session:
 *
 *  - the `Cloud-IDE-JWT` token, fetched with the page's own cookies through
 *    `/cloudide/api/v3/common/GetUserToken` — the same call the site makes;
 *  - the device fingerprint (`__msuuid__` from the page, or one generated in
 *    the page), which Trae's check-in route requires and which therefore must
 *    belong to this web session rather than to a machine install.
 *
 * Cookies are captured over the DevTools protocol and kept in the plugin's own
 * account store so the short-lived JWT can be renewed later; the dedicated
 * browser profile stays on disk and is reused for subsequent sign-ins.
 *
 * @module dsh-llm-adapters/trae-login
 */
import type { TraeRegion } from './brand.ts';
import type { LoginStatus } from './login-page.ts';
export interface TraeLoginAccount {
    accessToken: string;
    deviceId: string;
    machineId: string;
    userId?: string;
    name?: string;
    /** The JWT expiry, not the longer website-session expiry. */
    expiresAt?: number;
    cookies?: string;
    sessionExpiresAt?: number;
}
export interface TraeWebLoginOptions {
    region: TraeRegion;
    /** Keep this profile across sign-ins so the device looks stable to Trae. */
    profileDir?: string;
    save(account: TraeLoginAccount): Promise<void>;
    timeoutMs?: number;
    logger?: (message: string) => void;
}
export declare function machineIdOf(deviceId: string): string;
/**
 * One browser-backed Trae login.
 *
 * A flow is single-use: after it settles, start a new one for another login.
 */
export declare class TraeWebLogin {
    private readonly options;
    private phase;
    private message;
    private startedAt;
    private finishedAt;
    private error;
    private signedIn;
    private browser;
    private profile;
    private persistentProfile;
    private cdp;
    private timer;
    private deadline;
    private closed;
    private polling;
    private failures;
    constructor(options: TraeWebLoginOptions);
    private get timeoutMs();
    status(): LoginStatus;
    start(): Promise<LoginStatus>;
    cancel(): Promise<void>;
    close(): Promise<void>;
    private reset;
    private launch;
    private cookies;
    private tick;
    private readName;
    private settle;
    private fail;
    private cleanup;
}
