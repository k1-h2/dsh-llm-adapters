/**
 * Non-secret account facts for the settings card.
 *
 * Browser login stores the credentials; this lookup only adds a display name,
 * phone and account type. Failures are ignored — they must never turn a
 * successful login into a failed one.
 *
 * @module dsh-llm-adapters/account-profile
 */
export declare const RACCOON_WEB_BASE = "https://xiaohuanxiong.com/api/web";
export declare function raccoonAccountInfo(input: {
    accessToken: string;
    fetchImpl?: typeof fetch;
}): Promise<{
    name?: string;
    phone?: string;
    ownerType?: string;
}>;
