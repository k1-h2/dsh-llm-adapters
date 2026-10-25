/**
 * dsh-llm-adapters — browser half.
 *
 * One settings section per provider. Each follows the same shape as
 * dsh-agent-sdk-bridge: an account card first, then the live catalog with per
 * model on/off and context-window controls, then a collapsed advanced area.
 *
 * The account card is read-only by design. It never asks for a password or a
 * token; sign-in happens on the provider's own page (a WeChat QR code for Loomy
 * and Raccoon, a dedicated browser window for Trae), and the card only reports
 * the resulting account, quota and check-in state.
 *
 * Trae is one card with a region switch: `traeRegion` is a setting, not a
 * second brand, so both regions share this page and keep separate accounts.
 *
 * Hand-written ModuleLoader bundle: no build step, no dependency beyond the
 * `react` the shell provides.
 */

window.__ModuleLoader__.load({
  id: 'dsh-llm-adapters',
  factory: require => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const { createElement: h, useState, useEffect, useCallback, useMemo, useRef, useSyncExternalStore } = React

    const NS = 'llm-adapters'
    const inject = ['slots', 'locale', 'configForms']

    const zh = {
      pluginOptionsTitle: '启用的供应商',
      pluginOptionsHint: '关闭后，对应设置页、模型列表与模型分组都会移除；登录态与已保存的模型选择会保留。',
      pluginOptionsOn: '显示中',
      pluginOptionsOff: '已关闭',
      pluginOptionsReadOnly: '当前配置不可写',
      pluginOptionsRejected: '宿主拒绝了这次改动；若刚更新过插件，请重启 DSH 后再试',
      loadFailed: '读取失败',
      retry: '重试',
      refresh: '刷新状态与模型',
      refreshing: '刷新中…',
      saveFailed: '保存失败',
      notApplied: '服务器未报告这次改动，可能被其他窗口覆盖了，请刷新后重试',
      timeout: '保存超时，请重试',
      saved: '已保存',
      saving: '保存中…',
      enabledCount: '已启用',
      search: '搜索模型…',
      onlyEnabled: '只看已启用',
      selectAll: '全部启用',
      selectNone: '全部关闭',
      colEnabled: '启用',
      windowDefault: '默认',
      windowDefaultHint: '跟随上游声明的窗口',
      vision: '读图',
      reasoning: '思考',
      free: '免费',
      advanced: '高级设置',
      advancedHint: '以下为细节参数，通常无需改动。',
      show: '展开',
      hide: '收起',
      reset: '恢复默认',
      windowWarn: '窗口越大，DSH 的自动压缩触发得越晚。若对话经常超限，请选较小的窗口。',
      accountTitle: '登录与账号',
      account: '账号',
      accountUnknown: '账号信息未提供',
      expires: '预计到期',
      quota: '额度',
      quotaRefreshing: '正在读取额度…',
      quotaUnavailable: '暂时无法读取额度',
      quotaFailed: '额度读取失败',
      points: '积分',
      loomyAvailable: '可用',
      loomyPermanent: '永久积分',
      loomyDaily: '每日积分',
      loomyCycle: '每日周期',
      raccoonOwner: '账号类型',
      ownerPersonal: '个人',
      ownerEnterprise: '企业',
      signedIn: '已登录',
      notLoggedIn: '未登录',
      reread: '重新读取登录态',
      reading: '读取中…',
      loginGuide: '点“打开扫码登录”，用微信扫码后会自动接回。',
      browserTitle: '微信扫码登录',
      browserOpen: '打开扫码登录',
      browserWaiting: '等待扫码…',
      browserCancel: '取消',
      browserReopen: '重新打开登录页',
      browserPolling: '登录页已在浏览器打开：用微信扫码并在手机上确认，成功后会自动接回。若弹窗被拦截，点“重新打开登录页”。',
      browserHintLoomy: '会打开一个本地登录页：用微信扫码登录 Loomy；首次使用的微信账号需要在页面里绑定手机号。',
      browserHintRaccoon: '会打开一个本地登录页：用微信扫码登录小浣熊，扫码确认后插件会自动接回。',
      loomyHint: 'Loomy 会话约 14 天有效，且没有刷新令牌；过期后再点“打开扫码登录”即可。',
      raccoonHint: '小浣熊扫码登录的令牌约 30 天有效，到期后重新扫码即可。思考档位（None / Low / High / Max，xhigh 除外）在聊天框的模型菜单里切换，每次刷新模型时按 OpenRouter 实时校正。',
      loginLogout: '退出登录',
      loginConfirmLogout: '确定要退出当前账号吗？',
      loginFailedPrefix: '登录失败',
      loomyLoginMissing: 'Loomy 尚未登录。请点「打开扫码登录」用微信扫码。',
      raccoonLoginMissing: '小浣熊尚未登录。请点「打开扫码登录」用微信扫码。',
      possiblyExpired: '登录态可能已过期',
      modelsEmptyLoomy: 'Loomy 没有返回模型。请确认账号已登录，然后点“重新读取登录态”。',
      modelsEmptyRaccoon: '小浣熊没有返回模型。请确认账号已登录，然后点“重新读取登录态”。',
      modelsHint: '登录后才会读取并显示可用模型。',
      catalogNotice: '模型列表提示',
      advancedFields: {
        displayName: '分组名称',
        visionModelIds: '强制启用读图的模型 ID（JSON 数组）',
        textOnlyModelIds: '强制按纯文本处理的模型 ID（JSON 数组）',
        modelAliases: '模型别名（JSON 对象）',
        defaultMaxTokens: '默认输出上限',
      },
      loomyNav: 'Loomy',
      loomyTitle: 'Loomy',
      loomyIntro: '点“打开扫码登录”，用微信扫码登录 Loomy 即可使用，无需安装客户端。改动即时生效，无需重启。',
      raccoonNav: '商汤小浣熊',
      raccoonTitle: '商汤小浣熊',
      raccoonIntro: '点“打开扫码登录”，用微信扫码登录小浣熊即可使用，无需安装客户端。改动即时生效，无需重启。',
      traeNav: 'Trae',
      traeTitle: 'Trae',
      traeIntro: '先选国内版或国际版，再点“打开浏览器登录”在 Trae 官网登录。设备指纹由这次网页登录生成，不需要安装桌面客户端。改动即时生效，无需重启。',
      traeHint: 'Trae 的令牌来自网页登录；过期后重新登录即可。国内版每天可签到领积分，国际版没有签到活动。',
      traeLoginMissing: 'Trae 尚未登录。请点“打开浏览器登录”。',
      regionLabel: '区域',
      regionCn: '国内版 · trae.cn',
      regionGlobal: '国际版 · trae.ai',
      regionHint: '两个区域各自保存账号：切换区域不会退出另一个区域的登录。',
      regionSwitching: '正在切换区域…',
      checkin: '签到',
      checkinClaim: '签到领积分',
      checkinBusy: '签到中…',
      checkinClaimed: '今日已签到',
      checkinDevice: '本机今日已签到',
      checkinReward: '可得',
      checkinFailed: '签到失败',
      plan: '套餐',
      planFree: '免费版',
      planTrial: '试用中',
      trialEnds: '试用到期',
      packs: '资源包',
      packExpires: '到期',
      packUsage: '已用 / 总额',
      packNearest: '最近到期',
      packDetail: '详细信息',
      packCollapse: '收起',
      usedOf: '已用',
      browserHintTrae: '点下面的按钮会打开一个独立的浏览器窗口（不会动你自己的浏览器配置）：在其中登录 Trae，登录成功后窗口会自动关闭。',
      browserPollingTrae: '浏览器已打开：请在窗口里登录 Trae，成功后会自动接回，这个窗口随后会关闭。',
      browserTitleTrae: '浏览器登录',
      browserOpenTrae: '打开浏览器登录',
      browserWaitingTrae: '等待登录…',
      loginGuideTrae: '点“打开浏览器登录”，在弹出的窗口里登录 Trae 即可；登录成功后会自动接回。',
      modelsEmptyTrae: '账号没有返回任何 Trae 模型。请确认账号已登录，然后点“重新读取登录态”。',
      openRouterTitle: 'OpenRouter 模型同步',
      openRouterHint: 'OpenRouter 的实时模型表用来补充思考档位与读图能力，三个供应商共用一份。缓存保存在本机，连不上时会继续使用上次成功同步的数据；刷新模型不会清空缓存。',
      openRouterInterval: '自动同步',
      openRouterOff: '关闭自动同步',
      openRouterEvery15: '每 15 分钟',
      openRouterEvery60: '每小时',
      openRouterEvery360: '每 6 小时',
      openRouterEvery1440: '每 24 小时',
      openRouterSyncNow: '立即同步',
      openRouterSyncing: '同步中…',
      openRouterNever: '尚未同步',
      openRouterModels: '个模型',
      openRouterLastSync: '上次同步',
      openRouterSyncFailed: '同步失败',
      openRouterSyncDone: '已同步',
    }
    const en = {
      pluginOptionsTitle: 'Enabled providers',
      pluginOptionsHint: 'Turning one off removes its settings page, model list and model group. Login state and saved model choices are kept.',
      pluginOptionsOn: 'Shown',
      pluginOptionsOff: 'Off',
      pluginOptionsReadOnly: 'Configuration is read-only',
      pluginOptionsRejected: 'The host rejected this change; restart DSH after a plugin update and retry',
      loadFailed: 'Could not load',
      retry: 'Retry',
      refresh: 'Refresh status and models',
      refreshing: 'Refreshing…',
      saveFailed: 'Save failed',
      notApplied: 'The host did not report this change; another window may have overwritten it. Refresh and retry.',
      timeout: 'Save timed out; please retry',
      saved: 'Saved',
      saving: 'Saving…',
      enabledCount: 'enabled',
      search: 'Search models…',
      onlyEnabled: 'Enabled only',
      selectAll: 'Enable all',
      selectNone: 'Disable all',
      colEnabled: 'Enabled',
      windowDefault: 'Default',
      windowDefaultHint: 'Follow the upstream context window',
      vision: 'vision',
      reasoning: 'reasoning',
      free: 'free',
      advanced: 'Advanced',
      advancedHint: 'Rarely needed; read the help text before changing.',
      show: 'Show',
      hide: 'Hide',
      reset: 'Reset',
      windowWarn: 'A larger window delays automatic compaction. Choose a smaller value if conversations often overflow.',
      accountTitle: 'Sign-in',
      account: 'Account',
      accountUnknown: 'Account details are unavailable',
      expires: 'Expires (estimated)',
      quota: 'Quota',
      quotaRefreshing: 'Reading quota…',
      quotaUnavailable: 'Quota is temporarily unavailable',
      quotaFailed: 'Could not read quota',
      points: 'points',
      loomyAvailable: 'Available',
      loomyPermanent: 'Permanent',
      loomyDaily: 'Daily',
      loomyCycle: 'Daily cycle',
      raccoonOwner: 'Account type',
      ownerPersonal: 'Personal',
      ownerEnterprise: 'Enterprise',
      signedIn: 'Signed in',
      notLoggedIn: 'Not signed in',
      reread: 'Re-read login state',
      reading: 'Reading…',
      loginGuide: 'Use “Open QR sign-in” and scan the code in WeChat; the login is adopted automatically.',
      browserTitle: 'WeChat QR sign-in',
      browserOpen: 'Open QR sign-in',
      browserWaiting: 'Waiting for scan…',
      browserCancel: 'Cancel',
      browserReopen: 'Reopen the sign-in page',
      browserPolling: 'The sign-in page is open in your browser. Scan the code in WeChat and confirm on your phone; the plugin adopts the login automatically. If the popup was blocked, use “Reopen the sign-in page”.',
      browserHintLoomy: 'A local sign-in page opens: scan it in WeChat to sign in to Loomy. A WeChat account using Loomy for the first time must bind a phone number on that page.',
      browserHintRaccoon: 'A local sign-in page opens: scan it in WeChat to sign in to Raccoon, and the plugin adopts the login once you confirm.',
      loomyHint: 'A Loomy session lasts about 14 days and has no refresh token; use “Open QR sign-in” again when it expires.',
      raccoonHint: 'A Raccoon QR login lasts about 30 days; scan again when it expires. Pick a thinking level (off / low / high / max) in the chat model menu; levels are reconciled against OpenRouter on each model refresh.',
      loginLogout: 'Sign out',
      loginConfirmLogout: 'Sign out of this account?',
      loginFailedPrefix: 'Sign-in failed',
      loomyLoginMissing: 'Loomy is not signed in. Use “Open QR sign-in” and scan the code in WeChat.',
      raccoonLoginMissing: 'Raccoon is not signed in. Use “Open QR sign-in” and scan the code in WeChat.',
      possiblyExpired: 'The login may have expired',
      modelsEmptyLoomy: 'Loomy returned no models. Confirm the account is signed in, then re-read the login state.',
      modelsEmptyRaccoon: 'Raccoon returned no models. Confirm the account is signed in, then re-read the login state.',
      modelsHint: 'Models are read only after sign-in.',
      catalogNotice: 'Model list notice',
      advancedFields: {
        displayName: 'Group name',
        visionModelIds: 'Force vision model IDs (JSON array)',
        textOnlyModelIds: 'Force text-only model IDs (JSON array)',
        modelAliases: 'Model aliases (JSON object)',
        defaultMaxTokens: 'Default output limit',
      },
      loomyNav: 'Loomy',
      loomyTitle: 'Loomy',
      loomyIntro: 'Use “Open QR sign-in” and scan the code in WeChat; no client install needed. Changes apply immediately.',
      raccoonNav: 'SenseTime Raccoon',
      raccoonTitle: 'SenseTime Raccoon',
      raccoonIntro: 'Use “Open QR sign-in” and scan the code in WeChat; no client install needed. Changes apply immediately.',
      traeNav: 'Trae',
      traeTitle: 'Trae',
      traeIntro: 'Pick the mainland or international edition, then use “Open browser sign-in” to sign in on Trae’s website. The device fingerprint comes from that web session, so no desktop client is needed. Changes apply immediately.',
      traeHint: 'Trae tokens come from the web sign-in; sign in again when one expires. The mainland edition offers a daily check-in for credits; the international edition has none.',
      traeLoginMissing: 'Trae is not signed in. Use “Open browser sign-in”.',
      regionLabel: 'Region',
      regionCn: 'Mainland · trae.cn',
      regionGlobal: 'International · trae.ai',
      regionHint: 'Each region keeps its own account: switching regions does not sign out the other one.',
      regionSwitching: 'Switching region…',
      checkin: 'Check-in',
      checkinClaim: 'Check in for credits',
      checkinBusy: 'Checking in…',
      checkinClaimed: 'Already checked in today',
      checkinDevice: 'This device checked in today',
      checkinReward: 'reward',
      checkinFailed: 'Check-in failed',
      plan: 'Plan',
      planFree: 'Free',
      planTrial: 'Trial',
      trialEnds: 'Trial ends',
      packs: 'Credit packs',
      packExpires: 'expires',
      packUsage: 'used / total',
      packNearest: 'nearest expiry',
      packDetail: 'Details',
      packCollapse: 'Collapse',
      usedOf: 'used',
      browserHintTrae: 'The button opens a dedicated browser window (your own browser profile is untouched): sign in to Trae there and the window closes itself.',
      browserPollingTrae: 'The browser is open: sign in to Trae in that window; the login is adopted automatically and the window then closes.',
      browserTitleTrae: 'Browser sign-in',
      browserOpenTrae: 'Open browser sign-in',
      browserWaitingTrae: 'Waiting for sign-in…',
      loginGuideTrae: 'Use “Open browser sign-in” and sign in to Trae in the window that opens; the login is adopted automatically.',
      modelsEmptyTrae: 'Trae returned no models. Confirm the account is signed in, then re-read the login state.',
      openRouterTitle: 'OpenRouter model sync',
      openRouterHint: 'OpenRouter’s live catalog supplies thinking levels and image support for all three providers. The snapshot is cached on this machine, so a failed sync keeps the last successful data; refreshing a model list never clears it.',
      openRouterInterval: 'Auto sync',
      openRouterOff: 'Off',
      openRouterEvery15: 'Every 15 minutes',
      openRouterEvery60: 'Hourly',
      openRouterEvery360: 'Every 6 hours',
      openRouterEvery1440: 'Every 24 hours',
      openRouterSyncNow: 'Sync now',
      openRouterSyncing: 'Syncing…',
      openRouterNever: 'Not synced yet',
      openRouterModels: 'models',
      openRouterLastSync: 'Last sync',
      openRouterSyncFailed: 'Sync failed',
      openRouterSyncDone: 'Synced',
    }

    const BRANDS = [
      { id: 'loomy', settingsId: 'loomy', order: 40, titleKey: 'loomyTitle', navKey: 'loomyNav', introKey: 'loomyIntro' },
      { id: 'raccoon', settingsId: 'raccoon', order: 41, titleKey: 'raccoonTitle', navKey: 'raccoonNav', introKey: 'raccoonIntro' },
      { id: 'trae', settingsId: 'trae', order: 42, titleKey: 'traeTitle', navKey: 'traeNav', introKey: 'traeIntro' },
    ]

    const FIELDS = {
      loomy: {
        enabled: 'loomyEnabled',
        displayName: 'loomyDisplayName',
        disabled: 'loomyDisabledModels',
        windows: 'loomyModelContextWindows',
        aliases: 'loomyModelAliases',
        vision: 'loomyVisionModelIds',
        textOnly: 'loomyTextOnlyModelIds',
      },
      raccoon: {
        enabled: 'raccoonEnabled',
        displayName: 'raccoonDisplayName',
        disabled: 'raccoonDisabledModels',
        windows: 'raccoonModelContextWindows',
        aliases: 'raccoonModelAliases',
        vision: 'raccoonVisionModelIds',
        textOnly: 'raccoonTextOnlyModelIds',
      },
      trae: {
        enabled: 'traeEnabled',
        displayName: 'traeDisplayName',
        disabled: 'traeDisabledModels',
        windows: 'traeModelContextWindows',
        aliases: 'traeModelAliases',
        vision: 'traeVisionModelIds',
        textOnly: 'traeTextOnlyModelIds',
        region: 'traeRegion',
      },
    }

    const REGIONS = [
      { id: 'cn', labelKey: 'regionCn' },
      { id: 'global', labelKey: 'regionGlobal' },
    ]

    const OPENROUTER_INTERVALS = [
      { value: 0, labelKey: 'openRouterOff' },
      { value: 15, labelKey: 'openRouterEvery15' },
      { value: 60, labelKey: 'openRouterEvery60' },
      { value: 360, labelKey: 'openRouterEvery360' },
      { value: 1440, labelKey: 'openRouterEvery1440' },
    ]

    function regionOf(value) {
      return value === 'global' ? 'global' : 'cn'
    }

    const css = {
      page: { maxWidth: '860px', display: 'flex', flexDirection: 'column', gap: '14px', color: 'var(--dsw-alias-label-primary)' },
      h2: { margin: '0', fontSize: '1.25em' },
      h3: { margin: 0, fontSize: '0.95em' },
      intro: { margin: '0', opacity: 0.72, lineHeight: 1.55, fontSize: '0.92em' },
      bar: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      btn: { padding: '6px 12px', borderRadius: '7px', border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35))', background: 'transparent', color: 'inherit', cursor: 'pointer', font: 'inherit', fontSize: '0.88em' },
      btnPrimary: { border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.45))', background: '#0b0b0b', color: '#fff', fontWeight: 500 },
      btnAlert: { border: '1px solid var(--dsw-alias-label-danger, #e03131)', color: 'var(--dsw-alias-label-danger, #e03131)' },
      loginBox: { display: 'flex', flexDirection: 'column', gap: '10px', padding: '12px 14px', borderRadius: '10px', border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.25))' },
      h4: { margin: 0, fontSize: '0.92em' },
      input: { padding: '6px 10px', borderRadius: '7px', border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35))', background: 'var(--dsw-alias-bg-base, transparent)', color: 'inherit', font: 'inherit', fontSize: '0.88em' },
      search: { flex: '1 1 180px', minWidth: '140px' },
      count: { fontSize: '0.85em', opacity: 0.7, marginLeft: 'auto' },
      list: { display: 'flex', flexDirection: 'column', border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.25))', borderRadius: '10px', overflow: 'hidden' },
      row: { display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 14px', borderTop: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.15))' },
      rowFirst: { borderTop: 'none' },
      rowOff: { opacity: 0.5 },
      name: { flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '2px' },
      nameText: { fontSize: '0.92em', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      id: { fontSize: '0.76em', opacity: 0.55, fontFamily: 'ui-monospace, monospace' },
      tag: { fontSize: '0.72em', padding: '1px 6px', borderRadius: '5px', border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35))', opacity: 0.75 },
      price: { fontSize: '0.9em', opacity: 0.7, fontWeight: 400 },
      select: { padding: '5px 8px', borderRadius: '7px', border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35))', background: 'var(--dsw-alias-bg-base, transparent)', color: 'inherit', font: 'inherit', fontSize: '0.85em', minWidth: '104px' },
      switch: { width: '17px', height: '17px', cursor: 'pointer', accentColor: 'var(--dsw-alias-brand-primary, #4c6ef5)' },
      note: { fontSize: '0.82em', opacity: 0.62, lineHeight: 1.5 },
      err: { fontSize: '0.86em', color: 'var(--dsw-alias-label-danger, #e03131)' },
      guide: { display: 'flex', flexDirection: 'column', gap: '8px', padding: '12px 14px', borderRadius: '10px', border: '1px solid var(--dsw-alias-label-danger, #e03131)', background: 'rgba(224,49,49,0.07)' },
      guideText: { fontSize: '0.88em', lineHeight: 1.5, color: 'var(--dsw-alias-label-danger, #e03131)' },
      group: { display: 'flex', flexDirection: 'column', gap: '10px', border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.25))', borderRadius: '10px', padding: '14px 16px' },
      card: { display: 'flex', flexDirection: 'column', gap: '10px', padding: '14px 16px', borderRadius: '10px', border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.25))', background: 'var(--dsw-alias-bg-base, rgba(128,128,128,0.03))' },
      cardHead: { display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap' },
      line: { display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap', fontSize: '0.86em' },
      label: { opacity: 0.62, minWidth: '78px' },
      value: { fontWeight: 500 },
      mono: { fontFamily: 'ui-monospace, monospace', fontSize: '0.8em', opacity: 0.7, wordBreak: 'break-all' },
      link: { color: 'var(--dsw-alias-brand-primary, #4c6ef5)', textDecoration: 'none', fontSize: '0.86em' },
      foot: { display: 'flex', alignItems: 'center', gap: '14px', flexWrap: 'wrap', fontSize: '0.8em', opacity: 0.6 },
      optionRow: { display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 0', borderTop: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.15))' },
      optionFirst: { borderTop: 'none', paddingTop: 0 },
      optionText: { flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '2px' },
      optionName: { fontSize: '0.92em', fontWeight: 500 },
      optionStatus: { fontSize: '0.82em', opacity: 0.62 },
      advLabel: { fontSize: '0.88em' },
      advHelp: { fontSize: '0.78em', opacity: 0.55, lineHeight: 1.4 },
      regionBox: { display: 'flex', flexDirection: 'column', gap: '6px', paddingBottom: '10px', borderBottom: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.15))' },
      seg: { display: 'flex', gap: '6px', flexWrap: 'wrap' },
      segBtn: { padding: '4px 10px', borderRadius: '7px', border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35))', background: 'transparent', color: 'inherit', cursor: 'pointer', font: 'inherit', fontSize: '0.84em' },
      segOn: { border: '1px solid var(--dsw-alias-brand-primary, #4c6ef5)', fontWeight: 600 },
      section: { display: 'flex', flexDirection: 'column', gap: '10px', paddingTop: '14px', borderTop: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.15))' },
      packBlock: { display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '2px' },
      packHead: { display: 'flex', alignItems: 'baseline', gap: '8px' },
      packToggle: { marginLeft: 'auto', background: 'none', border: 'none', padding: 0, font: 'inherit', fontSize: '0.8em', color: 'var(--dsw-alias-brand-primary, #4c6ef5)', cursor: 'pointer' },
      packList: { display: 'flex', flexDirection: 'column', borderRadius: '8px', border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.25))', overflow: 'hidden' },
      packListScroll: { maxHeight: '190px', overflowY: 'auto' },
      packRow: { display: 'grid', gridTemplateColumns: 'minmax(90px, 1.5fr) auto auto', alignItems: 'baseline', gap: '10px', padding: '6px 10px', borderTop: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.15))', fontSize: '0.82em' },
      packFirst: { borderTop: 'none' },
      packLabel: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      packAmount: { fontFamily: 'ui-monospace, monospace', textAlign: 'right', whiteSpace: 'nowrap' },
      packExpiry: { opacity: 0.6, whiteSpace: 'nowrap', fontSize: '0.92em' },
    }

    const API = (() => {
      try { return new URL('api/llm-adapters', document.baseURI).pathname } catch { return '/api/llm-adapters' }
    })()

    const CACHE_PREFIX = 'dsh-llm-adapters/cache/v1'
    const cacheMemory = new Map()

    function cacheKey(brand, kind) {
      return `${CACHE_PREFIX}:${brand}:${kind}`
    }

    function readCache(brand, kind) {
      const key = cacheKey(brand, kind)
      if (cacheMemory.has(key)) return cacheMemory.get(key)
      try {
        const raw = window.localStorage.getItem(key)
        if (raw === null) return undefined
        const parsed = JSON.parse(raw)
        cacheMemory.set(key, parsed)
        return parsed
      } catch {
        return undefined
      }
    }

    function writeCache(brand, kind, value) {
      const key = cacheKey(brand, kind)
      cacheMemory.set(key, value)
      try { window.localStorage.setItem(key, JSON.stringify(value)) } catch { /* private mode */ }
    }

    async function api(path, options) {
      const { timeout = 30_000, ...rest } = options ?? {}
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), timeout)
      try {
        const response = await fetch(`${API}${path}`, { ...rest, signal: ctrl.signal })
        const text = await response.text()
        let payload
        try { payload = text === '' ? {} : JSON.parse(text) } catch { payload = { error: text.slice(0, 200) } }
        if (!response.ok) throw new Error(payload?.error ?? `HTTP ${response.status}`)
        return payload
      } finally {
        clearTimeout(timer)
      }
    }

    const WRITE_TIMEOUT_MS = 20_000

    function withDeadline(promise, ms, message) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(message)), ms)
        promise.then(
          value => { clearTimeout(timer); resolve(value) },
          error => { clearTimeout(timer); reject(error) },
        )
      })
    }

    function windowLabel(n) {
      if (typeof n !== 'number' || !Number.isFinite(n)) return '—'
      if (n >= 1_000_000) return `${Number((n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1))}M`
      if (n >= 1000) return `${Math.round(n / 1000)}K`
      return String(n)
    }

    function creditsOf(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      return value.toLocaleString('zh-CN', { maximumFractionDigits: 2 })
    }

    function dateLabel(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      if (value > Date.now() + 100 * 365 * 24 * 3600 * 1000) return '—'
      return new Date(value).toLocaleString('zh-CN', {
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
      })
    }

    function priceText(t, factor) {
      if (typeof factor !== 'number' || !Number.isFinite(factor) || factor < 0) return ''
      if (factor === 0) return t('free')
      return `x${Number(factor.toFixed(2))}`
    }

    function ownerLabel(t, owner) {
      if (typeof owner !== 'string' || owner === '') return '—'
      if (owner === 'users' || owner === 'user' || owner === 'personal') return t('ownerPersonal')
      if (owner === 'org' || owner === 'enterprise') return t('ownerEnterprise')
      return owner
    }

    function AccountCard({ t, brand, region, regionBusy, onRegionChange, reloadSignal, onStatus, onAfterRefresh }) {
      // Trae keeps one snapshot per region, so switching back and forth never
      // shows the other region's account while a fresh read is in flight.
      const cacheId = brand.id === 'trae' ? `trae:${region}` : brand.id
      const cached = readCache(cacheId, 'status')
      const [status, setStatus] = useState(cached)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(undefined)
      const seenReload = useRef(reloadSignal)
      const mounted = useRef(true)
      const [browser, setBrowser] = useState(undefined)
      const [actionBusy, setActionBusy] = useState(false)
      const [actionError, setActionError] = useState(undefined)
      const [checkinBusy, setCheckinBusy] = useState(false)
      const [packsExpanded, setPacksExpanded] = useState(false)
      const ticket = useRef(0)

      const load = useCallback(async (fresh, notify) => {
        const mine = ++ticket.current
        setBusy(true)
        setError(undefined)
        try {
          const payload = await api(`/status?brand=${brand.id}${fresh ? '&fresh=1' : ''}`, { timeout: 35_000 })
          // A region switch starts a second read; the older one must not win.
          if (!mounted.current || mine !== ticket.current) return
          setStatus(payload)
          writeCache(cacheId, 'status', { ...payload, cachedAt: Date.now() })
          onStatus?.(payload)
          if (notify && payload?.signedIn === true) onAfterRefresh?.()
        } catch (err) {
          if (!mounted.current || mine !== ticket.current) return
          setError(String(err?.message ?? err))
        } finally {
          if (mounted.current && mine === ticket.current) setBusy(false)
        }
      }, [brand.id, cacheId, onStatus, onAfterRefresh])

      useEffect(() => {
        mounted.current = true
        void load(false, false)
        return () => { mounted.current = false }
      }, [load])

      // A region switch changes which stored account the card describes, so the
      // previous region's snapshot is dropped before the new read lands.
      useEffect(() => {
        setStatus(readCache(cacheId, 'status'))
        setBrowser(undefined)
        setActionError(undefined)
        setPacksExpanded(false)
      }, [cacheId])

      useEffect(() => {
        if (reloadSignal === seenReload.current) return
        seenReload.current = reloadSignal
        void load(true, true)
      }, [reloadSignal, load])

      // Follow the server-side browser login. The flow lives in the host, so it
      // keeps going even if this page is closed and reopened mid-login.
      useEffect(() => {
        if (browser?.running !== true) return undefined
        let alive = true
        const tick = async () => {
          try {
            const payload = await api(`/account/browser?brand=${brand.id}`, { timeout: 10_000 })
            if (!alive) return
            setBrowser(payload)
            if (payload?.running === false && payload?.signedIn === true) {
              await load(true, true)
            }
          } catch {
            /* transient; the next tick retries */
          }
        }
        const timer = setInterval(() => { void tick() }, 1500)
        return () => { alive = false; clearInterval(timer) }
      }, [browser?.running, brand.id, load])

      const signedIn = status?.signedIn === true
      const account = status?.account ?? {}
      const accountText = [account.name, account.phone, account.ownerType === undefined ? undefined : ownerLabel(t, account.ownerType)]
        .filter(part => typeof part === 'string' && part.length > 0)
        .join(' · ') || t('accountUnknown')
      const quota = status?.quota

      const accountRequest = useCallback(async body => api('/account', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ brand: brand.id, ...(brand.id === 'trae' ? { region } : {}), ...body }),
        timeout: 45_000,
      }), [brand.id, region])

      const logout = useCallback(async () => {
        if (typeof window.confirm === 'function' && !window.confirm(t('loginConfirmLogout'))) return
        setActionBusy(true)
        setActionError(undefined)
        try {
          const payload = await accountRequest({ action: 'logout' })
          setStatus(payload)
          writeCache(cacheId, 'status', { ...payload, cachedAt: Date.now() })
          onStatus?.(payload)
          onAfterRefresh?.()
        } catch (err) {
          setActionError(`${t('loginFailedPrefix')}：${String(err?.message ?? err)}`)
        } finally {
          setActionBusy(false)
        }
      }, [accountRequest, cacheId, onStatus, onAfterRefresh, t])

      const startBrowserLogin = useCallback(async () => {
        setActionError(undefined)
        try {
          const payload = await accountRequest({ action: 'browser' })
          setBrowser(payload)
          if (typeof payload?.url === 'string' && payload.url !== '' && typeof window.open === 'function') {
            window.open(payload.url, '_blank', 'noopener')
          }
        } catch (err) {
          setActionError(`${t('loginFailedPrefix')}：${String(err?.message ?? err)}`)
        }
      }, [accountRequest, t])

      const cancelBrowserLogin = useCallback(async () => {
        try {
          const payload = await accountRequest({ action: 'browser-cancel' })
          setBrowser(payload)
        } catch (err) {
          setActionError(`${t('loginFailedPrefix')}：${String(err?.message ?? err)}`)
        }
      }, [accountRequest, t])

      // Claiming is the only state-changing account action. The reward changes
      // the quota, so the reading is refreshed afterwards instead of guessed.
      const claimCheckin = useCallback(async () => {
        setCheckinBusy(true)
        setActionError(undefined)
        try {
          const payload = await accountRequest({ action: 'checkin' })
          if (payload?.checkin !== undefined) {
            setStatus(previous => previous === undefined
              ? previous
              : { ...previous, checkin: payload.checkin })
          }
          await load(true, false)
        } catch (err) {
          setActionError(`${t('checkinFailed')}：${String(err?.message ?? err)}`)
        } finally {
          setCheckinBusy(false)
        }
      }, [accountRequest, load, t])

      const quotaContent = (() => {
        if (busy && quota === undefined) return h('div', { style: css.note }, t('quotaRefreshing'))
        if (status?.quotaError !== undefined) return h('div', { style: css.err }, `${t('quotaFailed')}：${status.quotaError}`)
        if (quota === undefined) return h('div', { style: css.note }, signedIn ? t('quotaUnavailable') : t('quotaRefreshing'))
        if (brand.id === 'loomy') {
          return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '5px' } },
            h('div', { style: css.line },
              h('span', { style: css.label }, t('loomyAvailable')),
              h('span', { style: css.value }, `${creditsOf(quota.available ?? quota.total)} ${t('points')}`),
            ),
            h('div', { style: css.line },
              h('span', { style: css.label }, t('loomyPermanent')),
              h('span', { style: css.value }, creditsOf(quota.permanent)),
              quota.daily === undefined ? null : h('span', { style: css.label }, t('loomyDaily')),
              quota.daily === undefined ? null : h('span', { style: css.value }, creditsOf(quota.daily)),
            ),
            quota.cycle === undefined ? null : h('div', { style: css.line },
              h('span', { style: css.label }, t('loomyCycle')),
              h('span', { style: css.value }, quota.cycle),
            ),
          )
        }
        if (brand.id === 'trae') {
          const packs = Array.isArray(quota.packs) ? quota.packs : []
          const plan = typeof quota.plan === 'string' && quota.plan !== '' ? quota.plan : undefined
          const usedText = quota.used === undefined
            ? undefined
            : `${creditsOf(quota.used)}${quota.total === undefined ? '' : ` / ${creditsOf(quota.total)}`} ${t('points')}`
          return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '5px' } },
            plan === undefined && quota.total === undefined && usedText === undefined && packs.length === 0
              ? h('div', { style: css.note }, t('quotaUnavailable'))
              : null,
            plan === undefined ? null : h('div', { style: css.line },
              h('span', { style: css.label }, t('plan')),
              h('span', { style: css.value }, plan),
              quota.trialEndsAt === undefined ? null : h('span', { style: css.label }, t('trialEnds')),
              quota.trialEndsAt === undefined ? null : h('span', { style: css.value }, dateLabel(quota.trialEndsAt)),
            ),
            usedText === undefined ? null : h('div', { style: css.line },
              h('span', { style: css.label }, t('quota')),
              h('span', { style: css.value }, usedText),
              quota.ratio === undefined ? null : h('span', { style: css.label }, `${Math.round(quota.ratio)}%`),
            ),
            packs.length === 0 ? null : (() => {
              // Collapsed (the default) is one summary row: how many packs, the
              // combined total and the nearest expiry. Expanding lists every
              // pack, aligned in a bounded scroll area.
              const total = packs.reduce((sum, pack) => sum + (pack.total ?? pack.used ?? 0), 0)
              const nearest = packs
                .map(pack => pack.expiresAt)
                .filter(value => typeof value === 'number')
                .sort((a, b) => a - b)[0]
              return h('div', { style: css.packBlock },
                h('div', { style: css.packHead },
                  h('span', { style: css.label }, `${t('packs')}（${packs.length}）`),
                  h('span', { style: css.value }, `${creditsOf(total)} ${t('points')}`),
                  nearest === undefined ? null : h('span', { style: css.packExpiry }, `${t('packNearest')} ${dateLabel(nearest)}`),
                  h('button', {
                    style: css.packToggle,
                    onClick: () => setPacksExpanded(value => !value),
                  }, packsExpanded ? t('packCollapse') : `（${t('packDetail')}）`),
                ),
                packsExpanded
                  ? h('div', { style: css.packBlock },
                      h('div', { style: css.packHead },
                        h('span', { style: css.label }, t('packUsage')),
                      ),
                      h('div', { style: { ...css.packList, ...css.packListScroll } },
                        packs.map((pack, index) => h('div', {
                          key: `${pack.label}-${index}`,
                          style: { ...css.packRow, ...(index === 0 ? css.packFirst : {}) },
                        },
                          h('span', { style: css.packLabel, title: pack.label }, pack.label),
                          h('span', { style: css.packAmount }, pack.total === undefined
                            ? (pack.used === undefined ? '—' : creditsOf(pack.used))
                            : `${creditsOf(pack.used ?? 0)} / ${creditsOf(pack.total)}`),
                          h('span', { style: css.packExpiry }, pack.expiresAt === undefined ? '' : dateLabel(pack.expiresAt)),
                        )),
                      ),
                    )
                  : null,
              )
            })(),
          )
        }
        return h('div', { style: css.line },
          h('span', { style: css.label }, t('quota')),
          h('span', { style: css.value }, `${creditsOf(quota.total)} ${t('points')}`),
        )
      })()

      // Trae CN grants one reward per account per day, but its device flag can
      // also block the claim; the two reasons are shown apart so "本机已签"
      // never reads as "this account already claimed".
      const checkin = brand.id === 'trae' ? status?.checkin : undefined
      const checkinBlocked = checkin === undefined
        || checkin.available === false
        || checkin.claimed === true
        || checkin.deviceClaimed === true
      const checkinLabel = checkin?.claimed === true
        ? t('checkinClaimed')
        : checkin?.deviceClaimed === true ? t('checkinDevice') : t('checkinClaim')
      const checkinPanel = signedIn && checkin !== undefined && checkin.available !== false
        ? h('div', { style: css.bar },
            h('button', {
              style: { ...css.btn, ...css.btnPrimary },
              disabled: checkinBlocked || checkinBusy || actionBusy,
              onClick: () => void claimCheckin(),
            }, checkinBusy ? t('checkinBusy') : checkinLabel),
            checkin.reward === undefined || checkin.claimed === true || checkin.deviceClaimed === true
              ? null
              : h('span', { style: css.note }, `${t('checkinReward')} +${creditsOf(checkin.reward)} ${t('points')}`),
          )
        : null

      const browserRunning = browser?.running === true
      const browserPanel = h('div', { style: css.loginBox },
        h('h4', { style: css.h4 }, brand.id === 'trae' ? t('browserTitleTrae') : t('browserTitle')),
        h('div', { style: css.note }, brand.id === 'loomy'
          ? t('browserHintLoomy')
          : brand.id === 'raccoon' ? t('browserHintRaccoon') : t('browserHintTrae')),
        h('div', { style: css.bar },
          h('button', {
            style: { ...css.btn, ...css.btnPrimary },
            disabled: browserRunning || actionBusy || regionBusy,
            onClick: () => void startBrowserLogin(),
          }, browserRunning
            ? brand.id === 'trae' ? t('browserWaitingTrae') : t('browserWaiting')
            : brand.id === 'trae' ? t('browserOpenTrae') : t('browserOpen')),
          browserRunning
            ? h('button', {
                style: css.btn,
                onClick: () => void cancelBrowserLogin(),
              }, t('browserCancel'))
            : null,
          browserRunning && typeof browser?.url === 'string'
            ? h('a', {
                href: browser.url,
                target: '_blank',
                rel: 'noreferrer',
                style: css.link,
              }, t('browserReopen'))
            : null,
        ),
        browserRunning
          ? h('div', { style: css.note }, typeof browser?.message === 'string' && browser.message !== ''
              ? browser.message
              : brand.id === 'trae' ? t('browserPollingTrae') : t('browserPolling'))
          : null,
        browser !== undefined && browser.running === false && browser.error !== undefined
          ? h('div', { style: css.err }, browser.error)
          : null,
        actionError !== undefined ? h('div', { style: css.err }, actionError) : null,
      )

      // Trae's region is a saved setting, not a tab: the selector writes the
      // same `traeRegion` the provider reads, and the page then re-reads both
      // the account and the catalog for the newly selected region.
      const regionPicker = brand.id === 'trae'
        ? h('div', { style: css.regionBox },
            h('div', { style: css.bar },
              h('span', { style: css.label }, t('regionLabel')),
              h('div', { style: css.seg },
                ...REGIONS.map(option => h('button', {
                  key: option.id,
                  style: { ...css.segBtn, ...(region === option.id ? css.segOn : {}) },
                  disabled: regionBusy || busy,
                  onClick: () => {
                    if (region === option.id) return
                    onRegionChange?.(option.id)
                  },
                }, t(option.labelKey))),
              ),
              regionBusy ? h('span', { style: css.note }, t('regionSwitching')) : null,
            ),
            h('div', { style: css.note }, t('regionHint')),
          )
        : null

      return h('div', { style: css.card },
        regionPicker,
        h('div', { style: css.cardHead },
          h('h3', { style: css.h3 }, t('accountTitle')),
          h('span', { style: { ...css.note, opacity: 0.75 } }, signedIn ? t('signedIn') : t('notLoggedIn')),
          h('button', {
            style: { ...css.btn, marginLeft: 'auto' },
            disabled: busy,
            onClick: () => { void load(true, true) },
          }, busy ? t('reading') : t('reread')),
        ),
        h('div', { style: css.note }, brand.id === 'loomy'
          ? t('loomyHint')
          : brand.id === 'raccoon' ? t('raccoonHint') : t('traeHint')),
        signedIn
          ? h('div', { style: css.line },
              h('span', { style: css.label }, t('account')),
              h('span', { style: css.value }, accountText),
            )
          : null,
        signedIn
          ? h('div', { style: css.line },
              h('span', { style: css.label }, t('expires')),
              h('span', { style: css.value }, dateLabel(status?.expiresAt)),
            )
          : null,
        signedIn && brand.id === 'raccoon'
          ? h('div', { style: css.line },
              h('span', { style: css.label }, t('raccoonOwner')),
              h('span', { style: css.value }, ownerLabel(t, account.ownerType)),
            )
          : null,
        signedIn ? quotaContent : null,
        checkinPanel,
        status?.possiblyExpired === true ? h('div', { style: css.err }, t('possiblyExpired')) : null,
        !signedIn && status !== undefined
          ? h('div', { style: css.guide },
              h('div', { style: css.guideText }, status?.error ?? signInGuide(t, brand)),
              h('div', { style: css.note }, brand.id === 'trae' ? t('loginGuideTrae') : t('loginGuide')),
            )
          : null,
        signedIn
          ? h('div', { style: css.bar },
              h('button', {
                style: { ...css.btn, ...css.btnAlert },
                disabled: actionBusy,
                onClick: () => void logout(),
              }, t('loginLogout')),
            )
          : null,
        !signedIn || status?.possiblyExpired === true ? browserPanel : null,
        error !== undefined ? h('div', { style: css.err }, `${t('loadFailed')}：${error}`) : null,
      )
    }

    function AdvancedInput({ t, form, fieldKey, label, kind, value, writable }) {
      const [draft, setDraft] = useState(undefined)
      const initial = kind === 'number'
        ? value === undefined ? '' : String(value)
        : kind === 'json'
          ? value === undefined ? (fieldKey.includes('Aliases') ? '{}' : '[]') : JSON.stringify(value, null, 2)
          : value === undefined ? '' : String(value)
      const shown = draft === undefined ? initial : draft

      const commit = () => {
        const raw = shown
        if (raw.trim() === '') {
          form.unset(fieldKey).catch(() => undefined)
          return
        }
        if (kind === 'number') {
          const number = Number(raw)
          if (!Number.isFinite(number) || number <= 0) { setDraft(initial); return }
          form.set(fieldKey, Math.floor(number)).catch(() => undefined)
          return
        }
        if (kind === 'json') {
          try {
            const parsed = JSON.parse(raw)
            const expectedArray = fieldKey.includes('Aliases') ? false : true
            if (expectedArray && !Array.isArray(parsed)) { setDraft(initial); return }
            if (!expectedArray && (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))) { setDraft(initial); return }
            form.set(fieldKey, parsed).catch(() => undefined)
          } catch {
            setDraft(initial)
          }
          return
        }
        form.set(fieldKey, raw).catch(() => undefined)
      }

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
          h('span', { style: css.advLabel }, label),
          value === undefined || !writable
            ? null
            : h('button', {
                style: { fontSize: '0.75em', opacity: 0.55, background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline', padding: 0, font: 'inherit', color: 'inherit' },
                onClick: () => { form.unset(fieldKey).catch(() => undefined) },
              }, t('reset')),
        ),
        kind === 'json'
          ? h('textarea', {
              style: { ...css.input, minHeight: '64px', fontFamily: 'ui-monospace, monospace', resize: 'vertical' },
              value: shown,
              disabled: !writable,
              onChange: event => setDraft(event.target.value),
              onBlur: commit,
            })
          : h('input', {
              style: css.input,
              type: kind === 'number' ? 'number' : 'text',
              value: shown,
              disabled: !writable,
              onChange: event => setDraft(event.target.value),
              onBlur: commit,
            }),
        h('div', { style: css.advHelp }, t('advancedHint')),
      )
    }

    function Advanced({ ctx, t, brand, show, onToggle }) {
      const form = ctx.configForms.get(NS)
      const subscribe = useCallback(listener => form.subscribe(listener), [form])
      const read = useCallback(() => form.getSnapshot(), [form])
      const snapshot = useSyncExternalStore(subscribe, read)
      const value = snapshot?.value ?? {}
      const writable = snapshot?.writable !== false
      const fields = FIELDS[brand.id]
      const labels = t('advancedFields')
      const items = [
        [fields.displayName, labels.displayName, 'text', value[fields.displayName]],
        [fields.vision, labels.visionModelIds, 'json', value[fields.vision]],
        [fields.textOnly, labels.textOnlyModelIds, 'json', value[fields.textOnly]],
        [fields.aliases, labels.modelAliases, 'json', value[fields.aliases]],
        ['defaultMaxTokens', labels.defaultMaxTokens, 'number', value.defaultMaxTokens],
      ]
      return h('div', { style: css.group },
        h('h3', { style: css.h3 }, t('advanced')),
        h('div', { style: css.bar },
          h('button', { style: css.btn, onClick: onToggle }, show ? t('hide') : t('show')),
          h('span', { style: css.note }, t('advancedHint')),
        ),
        show
          ? items.map(([key, label, kind, current]) => h(AdvancedInput, {
              key,
              t,
              form,
              fieldKey: key,
              label,
              kind,
              value: current,
              writable,
            }))
          : null,
      )
    }

    function SettingsPage({ ctx, t, brand }) {
      const form = ctx.configForms.get(NS)
      const subscribe = useCallback(listener => form.subscribe(listener), [form])
      const read = useCallback(() => form.getSnapshot(), [form])
      const snapshot = useSyncExternalStore(subscribe, read)
      const fields = FIELDS[brand.id]
      // Trae's two regions have independent accounts AND catalogs, so every
      // snapshot (models and status) is keyed by region as well as by brand.
      const region = brand.id === 'trae' ? regionOf(snapshot?.value?.[fields.region]) : undefined
      const cacheId = region === undefined ? brand.id : `${brand.id}:${region}`
      const cached = readCache(cacheId, 'models')
      const [models, setModels] = useState(() => Array.isArray(cached?.rows) ? cached.rows : undefined)
      const [notice, setNotice] = useState(() => typeof cached?.notice === 'string' ? cached.notice : undefined)
      const [signedIn, setSignedIn] = useState(() => cached?.signedIn === true ? true : undefined)
      const [error, setError] = useState(undefined)
      const [saveStatus, setSaveStatus] = useState(undefined)
      const [busy, setBusy] = useState(false)
      const [query, setQuery] = useState('')
      const [onlyEnabled, setOnlyEnabled] = useState(false)
      const [showAdvanced, setShowAdvanced] = useState(false)
      const [reloadSignal, setReloadSignal] = useState(0)
      const [regionBusy, setRegionBusy] = useState(false)
      const ticket = useRef(0)
      const writeTicket = useRef(0)

      const fetchModels = useCallback(async (fresh = false) => {
        const payload = await api(`/models?brand=${brand.id}${fresh ? '&fresh=1' : ''}`)
        return {
          rows: Array.isArray(payload?.models) ? payload.models : [],
          notice: typeof payload?.notice === 'string' ? payload.notice : undefined,
          signedIn: typeof payload?.signedIn === 'boolean' ? payload.signedIn : undefined,
        }
      }, [brand.id])

      const adopt = useCallback((rows, nextNotice, nextSignedIn) => {
        setModels(rows)
        setNotice(nextNotice)
        if (nextSignedIn !== undefined) setSignedIn(nextSignedIn)
        writeCache(cacheId, 'models', { rows, notice: nextNotice, signedIn: nextSignedIn, at: Date.now() })
      }, [cacheId])

      const load = useCallback(async (fresh = false) => {
        const mine = ++ticket.current
        setError(undefined)
        try {
          const payload = await fetchModels(fresh)
          if (mine !== ticket.current) return
          adopt(payload.rows, payload.notice, payload.signedIn)
        } catch (err) {
          if (mine !== ticket.current) return
          setError(String(err?.message ?? err))
          setModels(previous => previous ?? [])
        }
      }, [adopt, fetchModels])

      useEffect(() => {
        const saved = readCache(cacheId, 'models')
        setModels(Array.isArray(saved?.rows) ? saved.rows : undefined)
        setNotice(typeof saved?.notice === 'string' ? saved.notice : undefined)
        setError(undefined)
        void load(false)
      }, [cacheId, load])

      // Switching region writes the same field the provider reads, so the host
      // starts answering for the new region immediately; the cacheId change
      // above then restores that region's own account and catalog.
      const changeRegion = useCallback(async next => {
        setRegionBusy(true)
        setError(undefined)
        try {
          const accepted = await withDeadline(form.set(fields.region, next), WRITE_TIMEOUT_MS, t('timeout'))
          if (accepted === false) throw new Error(t('saveFailed'))
        } catch (err) {
          setError(`${t('saveFailed')}：${String(err?.message ?? err)}`)
        } finally {
          setRegionBusy(false)
        }
      }, [fields.region, form, t])

      const handleStatus = useCallback((payload) => {
        if (typeof payload?.signedIn === 'boolean') setSignedIn(payload.signedIn)
      }, [])

      const afterRefresh = useCallback(() => {
        void load(true)
      }, [load])

      const loadUntil = useCallback(async (verify, attempts = 5) => {
        let rows
        for (let attempt = 0; attempt < attempts; attempt++) {
          try {
            const payload = await fetchModels()
            rows = payload.rows
            adopt(rows, payload.notice, payload.signedIn)
          } catch (err) {
            setError(String(err?.message ?? err))
            return undefined
          }
          if (verify === undefined || verify(rows)) return rows
          await new Promise(resolve => setTimeout(resolve, 120 + attempt * 120))
        }
        return rows
      }, [adopt, fetchModels])

      const write = useCallback(async (key, next, verify) => {
        const mine = ++writeTicket.current
        setBusy(true)
        setSaveStatus(t('saving'))
        setError(undefined)
        try {
          const accepted = await withDeadline(next === undefined ? form.unset(key) : form.set(key, next), WRITE_TIMEOUT_MS, t('timeout'))
          if (accepted === false) throw new Error(t('saveFailed'))
          const rows = await loadUntil(verify)
          if (rows !== undefined && verify !== undefined && !verify(rows)) throw new Error(t('notApplied'))
          if (mine === writeTicket.current) setSaveStatus(t('saved'))
        } catch (err) {
          if (mine !== writeTicket.current) return
          setError(`${t('saveFailed')}：${String(err?.message ?? err)}`)
          setSaveStatus(undefined)
          await load()
        } finally {
          if (mine === writeTicket.current) setBusy(false)
        }
      }, [form, load, loadUntil, t])

      const writeDisabled = useCallback((rows, id, enabled) => {
        const next = new Set(rows.filter(model => !model.enabled).map(model => model.id))
        if (enabled) next.delete(id)
        else next.add(id)
        setModels(current => current?.map(model => model.id === id ? { ...model, enabled } : model))
        return write(fields.disabled, [...next], list => list.some(model => model.id === id && model.enabled === enabled))
      }, [fields.disabled, write])

      const writeWindow = useCallback((rows, id, window) => {
        const next = {}
        for (const model of rows) if (model.override !== undefined) next[model.id] = model.override
        if (window === undefined) delete next[id]
        else next[id] = window
        setModels(current => current?.map(model => model.id === id
          ? { ...model, override: window, contextWindow: window ?? model.defaultContextWindow }
          : model))
        return write(fields.windows, next, list => list.some(model => model.id === id
          && (window === undefined ? model.override === undefined : model.override === window)))
      }, [fields.windows, write])

      const writeAll = useCallback((enabled) => {
        const ids = (models ?? []).map(model => model.id)
        setModels(current => current?.map(model => ({ ...model, enabled })))
        return write(fields.disabled, enabled ? [] : ids, list => list.every(model => model.enabled === enabled))
      }, [fields.disabled, models, write])

      const all = models ?? []
      const enabledTotal = all.filter(model => model.enabled).length
      const shown = useMemo(() => {
        const q = query.trim().toLowerCase()
        return all.filter(model => {
          if (onlyEnabled && !model.enabled) return false
          if (q === '') return true
          return String(model.name).toLowerCase().includes(q) || String(model.id).toLowerCase().includes(q)
        })
      }, [all, query, onlyEnabled])

      const accountCard = h(AccountCard, {
        t,
        brand,
        region,
        regionBusy,
        onRegionChange: next => { void changeRegion(next) },
        reloadSignal,
        onStatus: handleStatus,
        onAfterRefresh: afterRefresh,
      })

      const refreshButton = h('button', {
        style: css.btn,
        disabled: busy,
        onClick: () => {
          setReloadSignal(value => value + 1)
          void load(true)
        },
      }, busy ? t('refreshing') : t('refresh'))

      const advanced = h(Advanced, {
        ctx, t, brand, show: showAdvanced,
        onToggle: () => setShowAdvanced(value => !value),
      })

      if (models === undefined) {
        return h('div', { style: css.page },
          h('h2', { style: css.h2 }, t(brand.titleKey)),
          h('p', { style: css.intro }, t(brand.introKey)),
          accountCard,
          error === undefined
            ? h('div', { style: css.note }, t('reading'))
            : h('div', null,
                h('div', { style: css.err }, `${t('loadFailed')}：${error}`),
                h('button', { style: { ...css.btn, marginTop: '8px' }, onClick: () => void load(true) }, t('retry')),
              ),
        )
      }

      if (signedIn !== true) {
        return h('div', { style: css.page },
          h('h2', { style: css.h2 }, t(brand.titleKey)),
          h('p', { style: css.intro }, t(brand.introKey)),
          accountCard,
          h('div', { style: css.guide },
            h('div', { style: css.guideText }, signInGuide(t, brand)),
            h('div', { style: css.note }, t('modelsHint')),
          ),
          refreshButton,
          advanced,
          error !== undefined ? h('div', { style: css.err }, error) : null,
        )
      }

      const rows = shown.map((model, index) => {
        const choices = Array.isArray(model.contextWindows) ? model.contextWindows : []
        const price = priceText(t, model.priceFactor)
        return h('div', {
          key: model.id,
          style: { ...css.row, ...(index === 0 ? css.rowFirst : {}), ...(model.enabled ? {} : css.rowOff) },
        },
          h('input', {
            type: 'checkbox',
            style: css.switch,
            checked: model.enabled === true,
            disabled: busy,
            title: t('colEnabled'),
            onChange: event => { void writeDisabled(all, model.id, event.target.checked) },
          }),
          h('div', { style: css.name },
            h('div', { style: css.nameText },
              model.name,
              model.vision === true ? h('span', { key: 'v', style: { ...css.tag, marginLeft: '6px' } }, t('vision')) : null,
              model.reasoning === true ? h('span', { key: 'r', style: { ...css.tag, marginLeft: '6px' } }, t('reasoning')) : null,
              ...(Array.isArray(model.labels) ? model.labels : []).map((label, labelIndex) =>
                h('span', { key: `l${labelIndex}`, style: { ...css.tag, marginLeft: '6px' } }, label)),
              model.badge !== undefined
                ? h('span', { key: 'b', style: { ...css.tag, marginLeft: '6px' } }, model.badge)
                : null,
              price !== '' ? h('span', { key: 'p', style: css.price }, ` · ${price}`) : null,
            ),
            h('div', { style: css.id }, model.id),
          ),
          h('select', {
            style: css.select,
            value: model.override === undefined ? '' : String(model.override),
            disabled: busy,
            title: t('windowDefaultHint'),
            onChange: event => {
              const value = event.target.value
              void writeWindow(all, model.id, value === '' ? undefined : Number(value))
            },
          },
            h('option', { key: 'default', value: '' }, `${t('windowDefault')} · ${windowLabel(model.defaultContextWindow)}`),
            choices.map(value => h('option', { key: String(value), value: String(value) }, windowLabel(value))),
          ),
        )
      })

      return h('div', { style: css.page },
        h('h2', { style: css.h2 }, t(brand.titleKey)),
        h('p', { style: css.intro }, t(brand.introKey)),
        accountCard,
        h('div', { style: css.bar },
          h('input', {
            style: { ...css.input, ...css.search },
            placeholder: t('search'),
            value: query,
            onChange: event => setQuery(event.target.value),
          }),
          h('label', { style: { ...css.note, display: 'flex', alignItems: 'center', gap: '6px', whiteSpace: 'nowrap' } },
            h('input', { type: 'checkbox', checked: onlyEnabled, onChange: event => setOnlyEnabled(event.target.checked) }),
            t('onlyEnabled'),
          ),
        ),
        h('div', { style: { ...css.bar, flexWrap: 'nowrap' } },
          refreshButton,
          h('button', {
            style: css.btn,
            disabled: busy || all.every(model => model.enabled),
            onClick: () => void writeAll(true),
          }, t('selectAll')),
          h('button', {
            style: css.btn,
            disabled: busy || enabledTotal === 0,
            onClick: () => void writeAll(false),
          }, t('selectNone')),
          h('span', { style: css.count }, `${t('enabledCount')} ${enabledTotal} / ${all.length}`),
        ),
        all.length === 0
          ? h('div', { style: css.guide },
              h('div', { style: css.guideText }, brand.id === 'loomy'
                ? t('modelsEmptyLoomy')
                : brand.id === 'raccoon' ? t('modelsEmptyRaccoon') : t('modelsEmptyTrae')),
            )
          : h('div', { style: css.list }, rows.length > 0
              ? rows
              : h('div', { style: { ...css.note, padding: '12px 14px' } }, '—')),
        notice !== undefined ? h('div', { style: css.note }, `${t('catalogNotice')}：${notice}`) : null,
        all.length > 0 ? h('div', { style: css.note }, t('windowWarn')) : null,
        error !== undefined ? h('div', { style: css.err }, error) : null,
        saveStatus !== undefined && error === undefined
          ? h('div', { style: css.note }, saveStatus)
          : null,
        advanced,
      )
    }

    function signInGuide(t, brand) {
      if (brand.id === 'loomy') return t('loomyLoginMissing')
      return brand.id === 'raccoon' ? t('raccoonLoginMissing') : t('traeLoginMissing')
    }

    function BundleSettings({ ctx, t, view }) {
      const form = ctx.configForms.get(NS)
      const subscribe = useCallback(listener => form.subscribe(listener), [form])
      const read = useCallback(() => form.getSnapshot(), [form])
      const snapshot = useSyncExternalStore(subscribe, read)
      const value = snapshot?.value ?? {}
      const writable = snapshot?.writable !== false
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(undefined)
      const [status, setStatus] = useState(undefined)
      const [openRouter, setOpenRouter] = useState(undefined)
      const [syncing, setSyncing] = useState(false)
      const [routerError, setRouterError] = useState(undefined)
      const [routerNotice, setRouterNotice] = useState(undefined)
      const ticket = useRef(0)
      const syncInterval = typeof value.openRouterSyncMinutes === 'number' ? value.openRouterSyncMinutes : 60

      const loadOpenRouter = useCallback(async () => {
        try {
          setOpenRouter(await api('/openrouter', { timeout: 10_000 }))
        } catch (err) {
          setRouterError(String(err?.message ?? err))
        }
      }, [])

      useEffect(() => { void loadOpenRouter() }, [loadOpenRouter])

      const syncOpenRouter = useCallback(async () => {
        setSyncing(true)
        setRouterError(undefined)
        setRouterNotice(undefined)
        try {
          const payload = await api('/openrouter/sync', { method: 'POST', timeout: 45_000 })
          setOpenRouter(payload)
          if (payload?.ok === true) {
            setRouterNotice(`${t('openRouterSyncDone')} · ${payload.models} ${t('openRouterModels')}`)
          } else {
            setRouterError(`${t('openRouterSyncFailed')}：${payload?.error ?? '—'}`)
          }
        } catch (err) {
          setRouterError(`${t('openRouterSyncFailed')}：${String(err?.message ?? err)}`)
        } finally {
          setSyncing(false)
        }
      }, [t])

      const setSyncInterval = useCallback(async next => {
        setStatus(t('saving'))
        setError(undefined)
        try {
          const accepted = await withDeadline(form.set('openRouterSyncMinutes', next), WRITE_TIMEOUT_MS, t('timeout'))
          if (accepted === false) throw new Error(t('pluginOptionsRejected'))
          setStatus(t('saved'))
        } catch (err) {
          setError(`${t('saveFailed')}：${String(err?.message ?? err)}`)
          setStatus(undefined)
        }
      }, [form, t])

      const toggle = useCallback(async (key, next) => {
        const mine = ++ticket.current
        setBusy(true)
        setStatus(t('saving'))
        setError(undefined)
        try {
          const accepted = await withDeadline(form.set(key, next), WRITE_TIMEOUT_MS, t('timeout'))
          if (accepted === false) throw new Error(t('pluginOptionsRejected'))
          if (mine === ticket.current) setStatus(t('saved'))
        } catch (err) {
          if (mine !== ticket.current) return
          setError(`${t('saveFailed')}：${String(err?.message ?? err)}`)
          setStatus(undefined)
        } finally {
          if (mine === ticket.current) setBusy(false)
        }
      }, [form, t])

      if (view !== undefined && view !== 'page') {
        const names = BRANDS
          .filter(brand => value[FIELDS[brand.id].enabled] !== false)
          .map(brand => {
            const stored = value[FIELDS[brand.id].displayName]
            return typeof stored === 'string' && stored !== '' ? stored : t(brand.navKey)
          })
        return h('span', null, names.join(' · '))
      }

      return h('div', { style: css.group },
        h('h3', { style: css.h3 }, t('pluginOptionsTitle')),
        h('div', { style: css.note }, t('pluginOptionsHint')),
        BRANDS.map((brand, index) => {
          const key = FIELDS[brand.id].enabled
          const enabled = value[key] !== false
          const stored = value[FIELDS[brand.id].displayName]
          const name = typeof stored === 'string' && stored !== '' ? stored : t(brand.navKey)
          return h('div', { key: brand.id, style: { ...css.optionRow, ...(index === 0 ? css.optionFirst : {}) } },
            h('input', {
              type: 'checkbox',
              style: css.switch,
              checked: enabled,
              disabled: busy || !writable,
              onChange: event => { void toggle(key, event.target.checked) },
            }),
            h('div', { style: css.optionText },
              h('div', { style: css.optionName }, name),
              h('div', { style: css.optionStatus }, enabled ? t('pluginOptionsOn') : t('pluginOptionsOff')),
            ),
          )
        }),
        !writable ? h('div', { style: css.note }, t('pluginOptionsReadOnly')) : null,
        h('div', { style: css.section },
          h('h3', { style: css.h3 }, t('openRouterTitle')),
          h('div', { style: css.note }, t('openRouterHint')),
          h('div', { style: css.bar },
            h('span', { style: css.label }, t('openRouterInterval')),
            h('select', {
              style: css.select,
              value: String(syncInterval),
              disabled: busy || !writable,
              onChange: event => { void setSyncInterval(Number(event.target.value)) },
            },
              OPENROUTER_INTERVALS.map(option => h('option', {
                key: String(option.value),
                value: String(option.value),
              }, t(option.labelKey))),
            ),
            h('button', {
              style: { ...css.btn, ...css.btnPrimary },
              disabled: syncing || !writable,
              onClick: () => { void syncOpenRouter() },
            }, syncing ? t('openRouterSyncing') : t('openRouterSyncNow')),
          ),
          h('div', { style: css.bar },
            h('span', { style: css.note }, openRouter === undefined
              ? t('openRouterNever')
              : `${openRouter.models ?? 0} ${t('openRouterModels')}${typeof openRouter.at === 'number' ? ` · ${t('openRouterLastSync')} ${dateLabel(openRouter.at)}` : ''}`),
            typeof openRouter?.error === 'string'
              ? h('span', { style: css.err }, `${t('openRouterSyncFailed')}：${openRouter.error}`)
              : null,
          ),
          routerNotice !== undefined ? h('div', { style: css.note }, routerNotice) : null,
          routerError !== undefined ? h('div', { style: css.err }, routerError) : null,
        ),
        error !== undefined ? h('div', { style: css.err }, error) : null,
        status !== undefined && error === undefined ? h('div', { style: css.note }, status) : null,
      )
    }

    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'llm-adapters: dictionaries')

      ctx.effect(() => ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
        name: 'plugins.bundle.config',
        key: 'dsh-llm-adapters',
        locale: NS,
      }, props => h(BundleSettings, { ...props, ctx, t }))), 'llm-adapters: bundle options')

      ctx.effect(() => ctx.configForms.whileServed([NS], () => {
        const form = ctx.configForms.get(NS)
        const live = new Map()

        const sync = () => {
          const snapshot = form.getSnapshot()
          if (snapshot.status !== 'ready') return
          const value = snapshot.value ?? {}
          for (const brand of BRANDS) {
            const enabled = value[FIELDS[brand.id].enabled] !== false
            const current = live.get(brand.id)
            if (enabled && current === undefined) {
              live.set(brand.id, ctx.slots.inject('settings.section', () => ctx.slots.register({
                name: 'settings.section',
                id: brand.settingsId,
                order: brand.order,
                label: () => t(brand.navKey),
                locale: NS,
              }, props => h(SettingsPage, { ...props, ctx, t, brand }))))
            } else if (!enabled && current !== undefined) {
              current()
              live.delete(brand.id)
            }
          }
        }

        const unsubscribe = form.subscribe(sync)
        sync()
        return () => {
          unsubscribe()
          for (const off of live.values()) off()
          live.clear()
        }
      }), 'llm-adapters: pages')
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = 'dsh-llm-adapters'
    exports.__test = {
      BRANDS, FIELDS, REGIONS, OPENROUTER_INTERVALS, regionOf, zh, en, css, windowLabel, creditsOf,
      ownerLabel, priceText, dateLabel, readCache, writeCache, AccountCard, SettingsPage, BundleSettings,
    }
    return module.exports
  },
})
