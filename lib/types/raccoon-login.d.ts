/**
 * Raccoon QR sign-in.
 *
 * The official desktop client receives its authorization through the
 * `office-raccoon://auth/callback` protocol, which a host-side Node process
 * cannot receive, and the web page's callback address is fixed. The current
 * website instead asks the server for a QR session, renders the returned
 * `scan_path`, and polls the same session until the phone confirms it.
 *
 * The QR code is single-use and server-issued: a locally invented code looks
 * fine while polling but the scan landing page rejects it as expired or
 * already used. Nothing here may fabricate the code.
 *
 * @module dsh-llm-adapters/raccoon-login
 */
import { type LoginStatus } from './login-page.ts';
/** IAM endpoints that create and poll the QR session. */
export declare const RACCOON_IAM_BASE = "https://xiaohuanxiong.com/api/iam/v1";
/** Origin the server-issued `scan_path` is resolved against. */
export declare const RACCOON_QR_ORIGIN = "https://xiaohuanxiong.com";
/** Name shown by the scan landing page; the website sends exactly this value. */
export declare const RACCOON_QR_APP_NAME = "\u5546\u6C64\u5C0F\u6D63\u718A";
export interface RaccoonLoginAccount {
    token: string;
    name?: string;
    phone?: string;
    ownerType?: string;
}
export interface RaccoonLoginOptions {
    save(account: RaccoonLoginAccount): Promise<void>;
    /** Gateway catalog probe; a token is only saved when this returns true. */
    validate(token: string): Promise<boolean>;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
}
/** A server-issued QR session. */
export interface RaccoonQrSession {
    code: string;
    scanPath: string;
    expiresIn: number;
    pollInterval: number;
}
export interface RaccoonQrPoll {
    status: 'pending' | 'logging' | 'canceled' | 'success' | 'expired' | 'error';
    accessToken?: string;
    expiresIn?: number;
    pollInterval?: number;
    message?: string;
}
/** A failed IAM call; `code` is the server's error code when there is one. */
export declare class RaccoonIamError extends Error {
    readonly code: string;
    readonly status: number;
    constructor(code: string, message: string, status?: number);
}
/** Ask the server for a new single-use QR session. */
export declare function createRaccoonQr(fetchImpl?: typeof fetch): Promise<RaccoonQrSession>;
/** The exact URL the website encodes into its own QR. */
export declare function raccoonQrContent(session: RaccoonQrSession): string;
/**
 * One poll. Expiry is reported as its own state; ordinary network hiccups stay
 * pending so a transient failure cannot kill a login the user is completing.
 */
export declare function pollRaccoonQr(code: string, fetchImpl?: typeof fetch): Promise<RaccoonQrPoll>;
/**
 * One running Raccoon QR login. `start()` resolves once the local page is
 * listening; the user completes the scan in that page.
 */
export declare class RaccoonQrLogin {
    private readonly options;
    private handle;
    private failure;
    constructor(options: RaccoonLoginOptions);
    status(): LoginStatus;
    start(): Promise<LoginStatus>;
    cancel(): Promise<void>;
}
