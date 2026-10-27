/**
 * Host-side login page for the two QR sign-in flows.
 *
 * The provider's own web login cannot hand a credential back to this plugin:
 * the page has no callback we can receive. So the host serves a small page on
 * `127.0.0.1`, renders the QR there, and polls the provider itself. The browser
 * window is only a display; credentials never pass through the page.
 *
 * The page is bound to a random loopback port and a random path prefix, so no
 * other local process can drive the login state by guessing URLs. It loads no
 * external resources.
 *
 * @module dsh-llm-adapters/login-page
 */
export type LoginPhase = 'idle' | 'preparing' | 'waiting' | 'scanned' | 'binding' | 'done' | 'error' | 'cancelled' | 'expired';
/** What the settings page may see. */
export interface LoginStatus {
    running: boolean;
    phase: LoginPhase;
    url?: string;
    error?: string;
    signedIn?: boolean;
    startedAt?: number;
    finishedAt?: number;
    /** Human-readable progress; browser-driven flows use it instead of a QR. */
    message?: string;
}
/** One poll result from a provider flow. */
export interface LoginPoll {
    phase: 'waiting' | 'scanned' | 'binding' | 'done' | 'error' | 'cancelled' | 'expired';
    message?: string;
    /** Replacement QR markup, when the provider rotates the code. */
    qr?: string;
}
/** Optional second step for providers that must bind a phone to a social login. */
export interface LoginBindingSpec {
    hint: string;
    send(phone: string): Promise<void>;
    verify(phone: string, code: string): Promise<void>;
}
export interface LoginPageSpec {
    title: string;
    heading: string;
    subtitle: string;
    /** Called once after the page is listening; returns inline QR markup. */
    prepare(): Promise<{
        qr: string;
    }>;
    /** One provider-side step. May take as long as the provider does (30–40 s). */
    poll(): Promise<LoginPoll>;
    /** Persist the account once {@link poll} reports `done`. */
    finish?(): Promise<void>;
    binding?: LoginBindingSpec;
    timeoutMs?: number;
}
export interface LoginPageHandle {
    url: string;
    result: Promise<void>;
    status(): LoginStatus;
    close(): Promise<void>;
}
/**
 * Start the page and the host-side poll loop. Resolves as soon as the loopback
 * server listens; the QR may still be preparing, and the page polls for it.
 */
export declare function startLoginPage(spec: LoginPageSpec): Promise<LoginPageHandle>;
