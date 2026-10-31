/**
 * Trae sign-in through the provider's own website.
 *
 * This flow does not read a desktop install: it opens a dedicated browser
 * profile, lets the user sign in on trae.cn / trae.ai, and then takes the
 * session the website itself created. Two things come out of that session:
 *
 *  - the `Cloud-IDE-JWT` token, fetched with the page's own cookies through
 *    `/cloudide/api/v3/common/GetUserToken` — the same call the site makes;
 *  - the device fingerprint (`__msuuid__` from the page, or one generated in
 *    the page), stored with the web login.
 *
 * The check-in route does not accept this web fingerprint, so check-in is
 * enabled only for the separate client-login import in `trae-client.ts`.
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
/** The port a browser wrote to `DevToolsActivePort`, live or not. */
export declare function devToolsPortOf(profile: string): number | undefined;
/**
 * A live browser left over from an earlier attempt, or `undefined` after
 * clearing the dead port file.
 *
 * A browser killed on Windows leaves `DevToolsActivePort` behind. Reading that
 * stale file made the next launch connect to a dead port, wait 25 s for a page
 * that could never appear, and then close the window it had just opened. The
 * two cases are now told apart: a port that answers is reused, anything else is
 * a leftover and is removed before the new browser starts.
 */
export declare function existingDevToolsPort(profile: string): Promise<number | undefined>;
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
    private port;
    /** True only for a browser this flow started; a reused one must survive. */
    private ownsBrowser;
    private cleanupTask;
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
    /**
     * Decide what a failed status check means.
     *
     * Giving up after three consecutive errors is six seconds of a redirect or a
     * flaky network — and ending the flow used to close the very window the user
     * was signing in on. Only a dead DevTools connection or a dead browser is
     * fatal now; everything else retries until the deadline.
     */
    private recover;
    private readName;
    private settle;
    private fail;
    /** One cleanup per flow; a new start waits for it before opening a browser. */
    private shutdown;
    private cleanup;
}
