/**
 * CodeArts browser sign-in: a loopback callback server plus the portal handoff.
 *
 * The flow is two-legged and both legs matter:
 *
 * 1. The settings page asks the host to start; the host opens a loopback server
 *    on a port ≥ 10000 (the portal refuses lower ones) and returns the portal
 *    URL. The page opens that URL in a normal browser tab.
 * 2. Huawei redirects to `http://127.0.0.1:<port>/oauth/callback?code=…`; the
 *    host exchanges the code (PKCE + DPoP), stores the credential and closes the
 *    server. The page polls `/account/browser` and adopts the account.
 *
 * The portal can also answer the *legacy* way, with `?secret=` instead of a
 * code. That branch polls the ticket endpoint for a plain AK/SK/ST triple: it
 * still signs correctly, but it carries no refresh token, so the account lasts
 * two hours and then needs another sign-in. Both branches are reported as
 * success — hiding the second one would leave users stuck on a page that says
 * "waiting" forever.
 *
 * @module dsh-llm-adapters/codearts-login
 */
import type { LoginStatus } from './login-page.ts';
import type { CodeArtsCredential } from './codearts-oauth.ts';
/** What the store keeps after a successful sign-in. */
export interface CodeArtsLoginAccount extends CodeArtsCredential {
    userName?: string;
    loginAt: number;
}
export interface CodeArtsLoginOptions {
    save: (account: CodeArtsLoginAccount) => Promise<void>;
    timeoutMs?: number;
    fetcher?: typeof fetch;
    logger?: (message: string) => void;
}
/**
 * One in-flight sign-in.
 *
 * A second `start()` while one is running returns the existing status: two
 * callback servers would race for the same credential and the losing one would
 * report a spurious timeout.
 */
export declare class CodeArtsLogin {
    private readonly options;
    private server;
    private state;
    private timer;
    private ticketId;
    private keyPair;
    private pkce;
    constructor(options: CodeArtsLoginOptions);
    private get fetcher();
    status(): LoginStatus;
    start(): Promise<LoginStatus>;
    private handle;
    private finish;
    private fail;
    cancel(): Promise<void>;
    close(): Promise<void>;
    private dispose;
}
/** Render the page a browser tab shows when the user lands on the callback. */
export declare function loginLandingPage(ok: boolean): string;
