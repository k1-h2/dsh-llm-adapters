/**
 * Where Huawei CodeArts lives, and the two facts about it that are not HTTP.
 *
 * CodeArts Agent is an IDE with a signed gateway behind it, so every call needs
 * a `SDK-HMAC-SHA256` signature over the exact body. The host names below come
 * from the IDE's own `product.json` (snap-access) and its OAuth portal; none of
 * them is a documented public API.
 *
 * The context windows are the one thing the gateway never publishes: neither
 * `/v1/model/builtin` nor `opengw gateway/config` carries any window field. The
 * table below is the IDE's own provider configuration (`limit.context`), read
 * out of its kernel log on 2026-10-21 — the only authoritative source. It does
 * change over time (GLM-5.2 went from 202 752 to 1 048 576 on 10-21), so the
 * table is a cache of a measurement, not a spec: an unknown model falls back to
 * the smallest window the catalogue currently reports, which is the safe side
 * (too small only compresses early; too large makes the upstream reject a
 * conversation that already overflows).
 *
 * @module dsh-llm-adapters/codearts-endpoints
 */
/** Gateway host for models, quota and chat. */
export declare const CODEARTS_SNAP_BASE = "https://snap-access.cn-north-4.myhuaweicloud.com";
/** Chat completions live under the v2 prefix; models and quota do not. */
export declare const CODEARTS_CHAT_URL = "https://snap-access.cn-north-4.myhuaweicloud.com/api/v2/chat/completions";
export declare const CODEARTS_MODEL_BUILTIN_PATH = "/v1/model/builtin";
export declare const CODEARTS_PACKAGE_INFO_PATH = "/snap-manager/v1/statistics/plugin";
export declare const CODEARTS_OPS_DELIVERY_PATH = "/v1/ops/delivery";
export declare const CODEARTS_OPS_CLAIM_PATH = "/v1/ops/claim";
export declare const CODEARTS_OPS_CONFIRM_PATH = "/v1/ops/confirm";
/** The `benefit` (free-allowance) models are listed by a second gateway. */
export declare const CODEARTS_GATEWAY_CONFIG_URL = "https://opengw.developer.huaweicloud.com/api/v1/gateway/config";
/** Activity channel the IDE declares when it reads or claims rewards. */
export declare const CODEARTS_OPS_CHANNEL = "IDE";
/** The daily sign-in activity's `type`; the other three are invite/new-user/student. */
export declare const CODEARTS_DAILY_LOGIN_TYPE = "USER_LOGIN";
/** Activity states that mean "already taken", not "not eligible". */
export declare const CODEARTS_CLAIMED_STATUSES: readonly string[];
/**
 * Headers every snap-access call carries.
 *
 * They are appended **after** signing on purpose: putting `Agent-Type` into the
 * canonical request makes the gateway answer `APIG.0301 … verify ak sk signature
 * fail`, while the same header sent unsigned is required for routing.
 */
export declare const CODEARTS_EXTRA_HEADERS: Readonly<Record<string, string>>;
/** OAuth client id = the IDE's URI scheme. */
export declare const CODEARTS_CLIENT_ID = "codearts-agent";
/** Local callback path the portal redirects to. */
export declare const CODEARTS_REDIRECT_PATH = "/oauth/callback";
export declare const CODEARTS_STS_TOKEN_URL = "https://sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens";
export declare const CODEARTS_PORTAL_AUTHORIZE = "https://codearts.huaweicloud.com/portal/authorize";
export declare const CODEARTS_PORTAL_LOGIN = "https://codearts.huaweicloud.com/portal/login";
/** Plugin identity the portal expects; these are the real extension's values. */
export declare const CODEARTS_LOGIN_PLUGIN_NAME = "snap_AIIDE";
export declare const CODEARTS_LOGIN_PLUGIN_VERSION = "5.2.0";
/** The gateway rejects a larger `max_tokens`; 65 536 is the IDE's own cap. */
export declare const CODEARTS_MAX_OUTPUT_TOKENS = 65536;
/**
 * `reasoning_effort` values the gateway validates, in the order the settings
 * page shows them.
 *
 * `none` is deliberately absent: it is only the legacy spelling of `off`,
 * which is sent as `thinking: disabled` instead, and `glm-5.3` rejects it as a
 * level outright. OpenRouter's `supported_efforts` is intersected with this
 * list, so an editor-only level (`minimal`) never reaches a model that would
 * answer 4xx for it.
 */
export declare const CODEARTS_EFFORT_LEVELS: readonly string[];
/**
 * Window used when a model is not in the table: the smallest one the catalogue
 * is known to publish (openpangu / sft-harmony). Erring small costs an early
 * compaction; erring large costs a rejected turn.
 */
export declare const CODEARTS_FALLBACK_CONTEXT_WINDOW = 524288;
/**
 * `limit.context` per model, from the IDE provider configuration.
 *
 * Keys are lowercase; lookups are case-insensitive because the gateway spells
 * the same model `GLM-5.2` in one roster and `glm-5.2` in the other.
 */
export declare const CODEARTS_CONTEXT_WINDOWS: Readonly<Record<string, number>>;
/** The window a model gets, with the documented fallback. */
export declare function codeartsContextWindow(modelId: string): number;
/**
 * Models that can take an image, measured from `supports_images`.
 *
 * Every other model answers `InferHub.001001020.406 The request model is not
 * multimodal`, even `deepseek-v4.1-flash`, whose own API accepts images. Both
 * are `display_enabled: false` upstream but `enable: true`, and both answer
 * tool calls, so they are listed even though the IDE hides them.
 */
export declare const CODEARTS_VISION_MODELS: readonly string[];
/**
 * The model that transcribes images for the models the gateway serves as text.
 *
 * This is the IDE's own choice: its kernel log picks `kimi-k2.6-vl` on every
 * sample (`fetchMultimodalModelId`, candidates being this and Qwen3-VL-235B).
 */
export declare const CODEARTS_VISION_MODEL = "kimi-k2.6-vl";
/**
 * Free-allowance models known to need `maas_type: benefit`.
 *
 * The authoritative set is the `opengw gateway/config` roster, fetched with the
 * catalogue; this is only the fallback for the first call after a fresh install.
 * `deepseek-v4-flash` / `deepseek-v4-pro` are deliberately absent: they are
 * registered as ordinary models and the header makes them `unsupported model`.
 */
export declare const CODEARTS_BENEFIT_FALLBACK: readonly string[];
