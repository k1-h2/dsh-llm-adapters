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
export const CODEARTS_SNAP_BASE = 'https://snap-access.cn-north-4.myhuaweicloud.com'
/** Chat completions live under the v2 prefix; models and quota do not. */
export const CODEARTS_CHAT_URL = `${CODEARTS_SNAP_BASE}/api/v2/chat/completions`

export const CODEARTS_MODEL_BUILTIN_PATH = '/v1/model/builtin'
export const CODEARTS_PACKAGE_INFO_PATH = '/snap-manager/v1/statistics/plugin'
export const CODEARTS_OPS_DELIVERY_PATH = '/v1/ops/delivery'
export const CODEARTS_OPS_CLAIM_PATH = '/v1/ops/claim'
export const CODEARTS_OPS_CONFIRM_PATH = '/v1/ops/confirm'

/** The `benefit` (free-allowance) models are listed by a second gateway. */
export const CODEARTS_GATEWAY_CONFIG_URL = 'https://opengw.developer.huaweicloud.com/api/v1/gateway/config'

/** Activity channel the IDE declares when it reads or claims rewards. */
export const CODEARTS_OPS_CHANNEL = 'IDE'
/** The daily sign-in activity's `type`; the other three are invite/new-user/student. */
export const CODEARTS_DAILY_LOGIN_TYPE = 'USER_LOGIN'
/** Activity states that mean "already taken", not "not eligible". */
export const CODEARTS_CLAIMED_STATUSES: readonly string[] = ['CLAIMED', 'CONFIRMED', 'CONSUMED']

/**
 * Headers every snap-access call carries.
 *
 * They are appended **after** signing on purpose: putting `Agent-Type` into the
 * canonical request makes the gateway answer `APIG.0301 … verify ak sk signature
 * fail`, while the same header sent unsigned is required for routing.
 */
export const CODEARTS_EXTRA_HEADERS: Readonly<Record<string, string>> = {
  'Agent-Type': 'PromptCenter',
  'X-Language': 'zh-cn',
}

/** OAuth client id = the IDE's URI scheme. */
export const CODEARTS_CLIENT_ID = 'codearts-agent'
/** Local callback path the portal redirects to. */
export const CODEARTS_REDIRECT_PATH = '/oauth/callback'
export const CODEARTS_STS_TOKEN_URL = 'https://sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens'
export const CODEARTS_PORTAL_AUTHORIZE = 'https://codearts.huaweicloud.com/portal/authorize'
export const CODEARTS_PORTAL_LOGIN = 'https://codearts.huaweicloud.com/portal/login'
/** Plugin identity the portal expects; these are the real extension's values. */
export const CODEARTS_LOGIN_PLUGIN_NAME = 'snap_AIIDE'
export const CODEARTS_LOGIN_PLUGIN_VERSION = '5.2.0'

/** The gateway rejects a larger `max_tokens`; 65 536 is the IDE's own cap. */
export const CODEARTS_MAX_OUTPUT_TOKENS = 65_536

/**
 * Window used when a model is not in the table: the smallest one the catalogue
 * is known to publish (openpangu / sft-harmony). Erring small costs an early
 * compaction; erring large costs a rejected turn.
 */
export const CODEARTS_FALLBACK_CONTEXT_WINDOW = 524_288

/**
 * `limit.context` per model, from the IDE provider configuration.
 *
 * Keys are lowercase; lookups are case-insensitive because the gateway spells
 * the same model `GLM-5.2` in one roster and `glm-5.2` in the other.
 */
export const CODEARTS_CONTEXT_WINDOWS: Readonly<Record<string, number>> = {
  'glm-5.2': 1_048_576,
  'glm-5.3': 1_048_576,
  'glm-5.2-sft-harmony': 202_752,
  'openpangu-2.0-flash': 524_288,
  'openpangu-2.0-pro': 524_288,
  'deepseek-v4.1-flash': 1_048_576,
  // The two image models are hidden from the IDE's own menu, so there is no
  // `limit.context` to read: these come from the model cards (Kimi K2.6 and
  // Qwen3-VL-235B are both 256K).
  'kimi-k2.6-vl': 262_144,
  'qwen3-vl-235b': 262_144,
}

/** The window a model gets, with the documented fallback. */
export function codeartsContextWindow(modelId: string): number {
  return CODEARTS_CONTEXT_WINDOWS[modelId.trim().toLowerCase()] ?? CODEARTS_FALLBACK_CONTEXT_WINDOW
}

/**
 * Models that can take an image, measured from `supports_images`.
 *
 * Every other model answers `InferHub.001001020.406 The request model is not
 * multimodal`, so the route declares image input only for these. Both are
 * `display_enabled: false` upstream but `enable: true`, and both answer tool
 * calls, so they are listed even though the IDE hides them.
 */
export const CODEARTS_VISION_MODELS: readonly string[] = ['kimi-k2.6-vl', 'Qwen3-VL-235B']

/**
 * Free-allowance models known to need `maas_type: benefit`.
 *
 * The authoritative set is the `opengw gateway/config` roster, fetched with the
 * catalogue; this is only the fallback for the first call after a fresh install.
 * `deepseek-v4-flash` / `deepseek-v4-pro` are deliberately absent: they are
 * registered as ordinary models and the header makes them `unsupported model`.
 */
export const CODEARTS_BENEFIT_FALLBACK: readonly string[] = ['glm-5.3-flash', 'deepseek-v4.1-flash']
