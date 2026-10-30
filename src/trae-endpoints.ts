/**
 * Trae's two regions, as the website itself splits them.
 *
 * The web bundle keeps one base URL set per deployment: the CN portal talks to
 * `api.trae.cn` and the international one to `ug-normal.trae.ai`, while chat,
 * model directory and billing live on their own gateways. Spelling them out
 * once keeps the login flow, the catalog and the quota reader from drifting
 * apart.
 *
 * @module dsh-llm-adapters/trae-endpoints
 */

import type { TraeRegion } from './brand.ts'

export interface TraeRegionProfile {
  id: TraeRegion
  label: string
  /** The site the user signs in on. */
  webOrigin: string
  /** Auth/session API base (CheckLogin, GetUserToken, GetUserInfo). */
  apiBase: string
  /** SOLO chat + `get_detail_param`. */
  chatBase: string
  /** Model directory (`/models?functions=…`). */
  remoteBase: string
  /** Billing / entitlement API. */
  payBase: string
  timezone: string
  language: string
  /**
   * The deployment publishes its entitlement usage on the v2 route.
   *
   * Mainland answers `web_user_ent_usage` v2 (usage summary plus packs); the
   * international site's own "Dollar Usage" panel reads v1, whose pack carries
   * the dollar allowance instead.
   */
  usageV2: boolean
}

export const TRAE_REGION_PROFILES: Record<TraeRegion, TraeRegionProfile> = {
  cn: {
    id: 'cn',
    label: 'Trae 国内版',
    webOrigin: 'https://www.trae.cn',
    apiBase: 'https://api.trae.cn',
    chatBase: 'https://trae-api-cn.mchost.guru',
    remoteBase: 'https://solo.trae.cn/api/remote/v1',
    payBase: 'https://api.trae.cn',
    timezone: 'Asia/Shanghai',
    language: 'zh-cn',
    usageV2: true,
  },
  global: {
    id: 'global',
    label: 'Trae 国际版',
    webOrigin: 'https://www.trae.ai',
    apiBase: 'https://ug-normal.trae.ai',
    chatBase: 'https://coresg-normal.trae.ai',
    remoteBase: 'https://coresg-normal.trae.ai/api/remote/v1',
    payBase: 'https://growsg-normal.trae.ai',
    timezone: 'Asia/Singapore',
    language: 'en',
    usageV2: false,
  },
}

/** The app id Trae's own clients send; not account-specific. */
export const TRAE_APP_ID = '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8'

/**
 * Numeric build code sent as `x-app-version-code` / `x-ide-version-code`.
 *
 * The gateway binds those headers as a number and rejects the request with
 * `4001 ... expr_path=app_version_code, cause=missing required parameter` when
 * they are absent — on chat AND on `get_detail_param`, where the silent variant
 * is an empty roster. A web login has no desktop build number, so this fixed
 * numeric code is used; only the format is normalized, nothing impersonates a
 * device.
 */
export const TRAE_VERSION_CODE = '20260716'

export const TRAE_SOLO_CHAT_PATH = '/api/agent/v3/llm_utils_chat'
export const TRAE_SOLO_MODELS_PATH = '/api/ide/v1/get_detail_param'

/** A browser User-Agent; the gateways reject obviously non-browser clients. */
export const TRAE_WEB_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
