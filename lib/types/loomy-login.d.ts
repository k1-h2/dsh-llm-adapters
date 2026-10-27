/**
 * Loomy WeChat QR sign-in.
 *
 * The Loomy client intercepts the WeChat redirect inside Electron and never
 * loads the callback page; that page is 404 for everyone else. The host mirrors
 * the client's actual account API instead: fetch the WeChat authorization page,
 * read the QR uuid out of it, long-poll the QR status, and exchange the
 * confirmed `code` through the signed iFlytek account endpoints.
 *
 * The QR image is inlined into the local page, so the page needs no network of
 * its own beyond the host it came from.
 *
 * @module dsh-llm-adapters/loomy-login
 */
import { type LoginStatus } from './login-page.ts';
export declare const LOOMY_ACCOUNT_BASE = "https://account.xfinfr.com";
export declare const LOOMY_WECHAT_APP_ID = "wx18d60be432287cf8";
export declare const LOOMY_WECHAT_REDIRECT_URI = "https://loomy.xunfei.cn/oauth/wechat/callback";
export interface LoomyLoginAccount {
    token: string;
    userId?: string;
    phone?: string;
    name?: string;
}
export interface LoomyLoginOptions {
    save(account: LoomyLoginAccount): Promise<void>;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
}
interface WechatPoll {
    status: 'waiting' | 'scanned' | 'confirmed' | 'cancelled' | 'expired' | 'error';
    code: string;
    errcode: string;
}
/** The nine-line string iFlytek signs; the last two lines are empty here. */
export declare function buildLoomySigningString(input: {
    accessKeyId: string;
    accessKeySecret: string;
    method: string;
    path: string;
    body?: string;
    contentType?: string;
    date: string;
    nonce: string;
}): string;
/** Headers for one signed iFlytek account request. */
export declare function loomyAccountHeaders(input: {
    method: string;
    path: string;
    body: string;
    contentType?: string;
}): Record<string, string>;
/** WeChat open-platform authorization URL; the redirect page itself is never loaded. */
export declare function buildLoomyWechatAuthUrl(state: string): string;
/** Read the QR uuid out of the authorization page HTML. */
export declare function extractWechatUuid(html: string): string;
/** Fetch the authorization page and return its QR uuid. */
export declare function fetchLoomyWechatUuid(state: string, fetchImpl?: typeof fetch): Promise<string>;
/** Download the QR image and inline it as a data URL. */
export declare function fetchLoomyWechatQr(uuid: string, fetchImpl?: typeof fetch): Promise<string>;
/** One long poll; 405 carries the one-time authorization code. */
export declare function pollLoomyWechat(uuid: string, lastErrcode: string, fetchImpl?: typeof fetch): Promise<WechatPoll>;
/** First WeChat step: exchange a code for `rcode` and learn whether a phone is bound. */
export declare function bindLoomyThirdAccount(code: string, fetchImpl: typeof fetch): Promise<{
    bind: boolean;
    rcode: string;
    nickname?: string;
}>;
export declare function sendLoomyBindSms(rcode: string, phone: string, fetchImpl: typeof fetch): Promise<string>;
export declare function verifyLoomyBindSms(rcode: string, code: string, msgid: string, fetchImpl: typeof fetch): Promise<{
    session: string;
    userid: string;
    phone: string;
}>;
export declare function skipLoomyBind(rcode: string, fetchImpl: typeof fetch): Promise<{
    session: string;
    userid: string;
}>;
/** One running Loomy QR login. */
export declare class LoomyQrLogin {
    private readonly options;
    private handle;
    private failure;
    constructor(options: LoomyLoginOptions);
    status(): LoginStatus;
    start(): Promise<LoginStatus>;
    cancel(): Promise<void>;
}
export {};
