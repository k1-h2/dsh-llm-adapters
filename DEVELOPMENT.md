# 开发文档

实现要点与改这个仓库前必须知道的约束。返回 [README](./README.md)。

## 目录结构

```
src/
  index.ts           注册 loomy / raccoon / trae / codearts 路由、设置接口与配置目录
  adapter.ts         把 DSH 请求接到 provider client，模型解析与上下文窗口
  api.ts             /models、/status、/account/browser、/account
  auth.ts            插件凭据状态、JWT 到期判定、退出登录
  account-store.ts   插件自己的凭据文件（原子写、0600、串行读改写）
  login-page.ts      本地登录页：随机端口/路径、二维码下发、状态轮询、可选绑手机
  qr.ts              零依赖二维码（byte 模式、纠错 M、版本 1–10）
  loomy-login.ts     Loomy 微信扫码：uuid、长轮询、讯飞账号 HMAC 接口
  raccoon-login.ts   小浣熊扫码：服务端签发二维码、轮询、业务会话确认
  trae-login.ts      Trae 网页登录：独立浏览器配置、CDP 读 cookie 与设备指纹
  trae-endpoints.ts  两个区域的站点 / 网关 / 计费基址
  account-profile.ts 小浣熊账号展示字段
  loomy.ts           Loomy 目录 / 积分 / 流式调用
  raccoon.ts         小浣熊目录 / 余额 / 流式调用
  trae.ts            Trae 目录合并 / SOLO 流式调用 / 额度 / 签到
  codearts-login.ts  CodeArts 浏览器授权：本地回调、PKCE/DPoP、ticket 回退
  codearts-oauth.ts  STS 令牌换取与续期（PKCE + DPoP，零依赖 JWS）
  codearts-sign.ts   华为 SDK-HMAC-SHA256 请求签名
  codearts-endpoints.ts 网关基址、窗口静态表、benefit 与 VL 清单
  codearts.ts        CodeArts 双目录合并 / 签名流式调用 / 额度 / 签到
  codearts-window.ts CodeArts 会话预算：每 60 秒 3 次的排队窗口
  catalog.ts         目录解析、模型缓存、能力来源合并
  model-name.ts      公共名称规则：括号标签、倍率、连字符归一化、匹配 key
  openrouter.ts      OpenRouter 模型表：原子同步、磁盘缓存、通配匹配档位与模态
  wire.ts            OpenAI 兼容 SSE、工具调用、usage
  config.ts          volatile 配置与 live 读取
client.js            设置页（ModuleLoader bundle，无构建步骤）
test/                vitest，不访问真实上游
```

## 扫码登录

两条链路都**没有回调地址**，也不读取日常浏览器的 Cookie。宿主在 `127.0.0.1` 起一个临时
登录页，页面只显示二维码与状态；凭据由宿主侧轮询拿到，不经过页面脚本。

### 本地登录页（`login-page.ts`）

`startLoginPage()` 在 `127.0.0.1:0` 上监听，路径带 32 位随机前缀，**先返回 URL**，二维码在
后台准备（Loomy 需要先拉微信授权页与图片）。返回后：

- `GET /<nonce>/login` 返回单文件页面；二维码可能在准备中，页面每 1.2 秒轮询状态。
- `GET /<nonce>/status` 触发一次 provider 轮询。同一时刻只允许一个轮询在飞；Loomy 的长轮询
  可能占用 40 秒，第二个请求直接返回当前状态。二维码只下发一次，之后页面自己保留。
- 可选绑手机：`POST /<nonce>/send`、`POST /<nonce>/verify`。手机号与验证码只在宿主内存里，
  页面拿不到 `rcode` / `msgid` / `session`。
- 5 分钟超时；成功后页面保持 60 秒再关服务器，用户可以读到「登录成功」。
- `close()` 关闭监听并 `closeAllConnections()`，不会因为一个挂起的长轮询卡住取消。

`POST /account` 的 `browser` 动作只负责启动页面并返回 URL；设置页在点击手势里
`window.open(url)`，被拦截时卡片上的「重新打开登录页」仍可用。设置页轮询
`GET /account/browser?brand=...`，收到 `running:false, signedIn:true` 后重读 `/status`。

### Loomy（`loomy-login.ts`）

1. 生成 `state`，请求 `open.weixin.qq.com/connect/qrconnect`（`appid` / 官方
   `redirect_uri` / `scope=snsapi_login`），从 HTML 里提取二维码 `uuid`。
2. 下载 `connect/qrcode/<uuid>`（JPEG）并内联成 data URL。
3. 长轮询 `long.open.weixin.qq.com/connect/l/qrconnect`：`408` 待扫码、`404` 已扫码待确认、
   `405` 已确认（这一帧带 `wx_code`）、`403` 取消、`402` 失效。
4. `wx_code` → `/login/thirdAccount/bind/auth` 换 `rcode` 与 `bind`。`bind=1` 走
   `/bind/skip` 直接换 `session`；`bind=0` 显示绑手机表单，走 `/bind/sendMsg` +
   `/bind/checkCode`。
5. 讯飞账号接口用 HMAC-SHA1 的 9 段签名，认证头是 `account {ak}:{sig}`。请求体**只序列化
   一次**，签名与发送共用同一字符串；`base.ua` 固定为 `Loomy|Desktop|Electron|macOS`。

`redirect_uri` 指向的官方回调页本身是 404，但链路不加载它：`code` 来自长轮询。不要把它改成
`127.0.0.1`，微信会校验域名白名单。

### 小浣熊（`raccoon-login.ts`）

1. `POST /api/iam/v1/auth/mp/qrcode`（空对象）取服务端签发的二维码：
   `qrcode_code`（形如 `qr-…`）、`scan_path`、`expires_in`、`poll_interval`。
2. 二维码内容由 `scan_path` 与 `https://xiaohuanxiong.com` 拼成，并附加 `code`、
   `appname=商汤小浣熊`、`source=platform` —— 与官网登录页实际生成的值一致。
3. 按 `poll_interval`（通常 2 秒）`POST /api/iam/v1/auth/mp/qrcode/login`（`qrcode_code`）；
   `pending` / `logging` / `canceled` / `success`。`AUTH_QRCODE_EXPIRED` 视为过期，网络抖动仍
   继续轮询。
4. 成功后先用 `POST /api/web/auth/v1/iam/confirm` 建立业务会话（失败不致命），再向
   `model_catalog` 校验令牌；只有网关接受的令牌才写入账号存储。扫码登录没有刷新流程，到期后
   重新扫码。

⚠️ 不能像旧版那样在本地随机生成 `code`：轮询会返回 `pending`，但微信扫到的落地页会把该码判为
“过期或已被使用”。码必须来自第 1 步。

不走官方桌面端的 `office-raccoon://auth/callback`，也不改网页里写死的回调地址。

### Trae（`trae-login.ts` + `trae.ts`）

Trae 没有可以自建的二维码链路：设备指纹必须来自一次真实的网页登录。因此这里不用本地登录页，
而是**自己启动一个浏览器**：

1. 找一个本机 Chromium 系浏览器（`DSH_TRAE_BROWSER` 可指定），用
   `--remote-debugging-port=0 --user-data-dir=<插件数据目录>/trae-browser/<region>` 启动，
   打开 `www.trae.cn` 或 `www.trae.ai`。配置目录与用户自己的浏览器隔离，但**跨登录保留**，
   让同一区域始终复用同一设备指纹；启动参数还关掉了 `AutomationControlled` 特征。
2. 读 `DevToolsActivePort` 得到调试端口，`/json/list` 找到页面，用 WebSocket 连 CDP。
3. 每 2 秒 `Network.getAllCookies` 拼 `Cookie` 头，回放给 `CheckLogin`；登录后
   `common/GetUserToken` 换 `Cloud-IDE-JWT`，`trae/GetUserInfo` 取账号信息。
4. 设备指纹取自该会话的 `localStorage.__msuuid__`（没有时 `msid`，再没有就生成一个并留在
   页面里）；`machineId = sha256("trae-web-machine\0" + deviceId)`。这两项、JWT、网页
   cookie 与网页会话到期时间一起写入账号记录。JWT 约 8 小时，网页会话约 14 天。
5. 5 分钟超时；成功后关闭窗口但保留配置目录。取消、失败与插件卸载同样走清理路径（Windows
   上用 `taskkill /T /F` 杀掉进程树）。退出登录会删除该区域的配置目录，避免下次登录被
   浏览器 cookie 自动接回。

两条目录来源合并成一份模型表（`mergeTraeModels`）：**只考虑客户端主通道**
（`TRAE_PRIMARY_FUNCTIONS` = `solo_work_remote` / `solo_work_lite`）里的远端行，并且每一行都
必须在 `get_detail_param` 里找到 wire config（chat 只接受 `config_name`）。因此
`Qwen3.8-Flash` / `Kimi-K2.8-Preview`（只在远端 `chat_v3`，任何 wire roster 都没有 config）
不会出现；只在 `chat_v3` / `solo_coder` 里仍可调用、但客户端已下架的老模型（GLM-4.6/4.7、
MiniMax-M2、Kimi-K2.0905、Qwen3-Coder、普通版 DeepSeek-V4-Flash/Pro）也不会出现。只在 wire
里出现、没有主通道目录行的配置不会被提升。远端显示名归一化后相同的两行
（`DeepSeek-V4-Flash` 与 `-Official`）只保留窗口更大的一行，不向名称里拼接 id 或括号。
Trae 与另外两个供应商共用 `resolveCapabilities`：OpenRouter 的实时表优先（`match` 用同一套
名称归一化），匹配不到回退目录，两边都没有就开放全部档位与模态。因此 OpenRouter 命中时
DeepSeek V4.1 Flash 是 None/Low/High/Max，未命中时才是目录的 light/high/extra_high。

聊天走 `POST {chatBase}/api/agent/v3/llm_utils_chat`，需要 `x-device-id` / `x-machine-id` /
`x-uid` 与 **`x-app-version-code` / `x-ide-version-code`** 等网页头。后两个是数字，缺失时上游
返回 `4001 binding: expr_path=app_version_code, cause=missing required parameter`（聊天）或
`config_info_list: []`（`get_detail_param`，静默少一半目录）；网页登录拿不到桌面构建号，因此用
固定的数字 `TRAE_VERSION_CODE`，只规范格式、不冒充设备。消息 content 一律是 block 数组，
assistant 的工具调用放在 `function_call`，工具的 `parameters` 是 JSON **字符串**。上游错误帧
按码映射：`1005` / `4222` → 402，`4008` / `4011` → 429，`4001` / `4023` → 400，其余 502。

目录里的 `features` 是 **JSON 字符串**（不是对象），倍率在
`features.consumption_rate.data.rate`；不解析字符串时所有模型都会丢掉倍率。同一模型会出现在
多个分组，容量取最强行（Max 优先、其次更宽的 dev 窗口），但**调用函数以 wire 目录为准**：
远端分组可能把模型标到一个实际会回 `4001` 的函数上（实测 `solo_agent_remote` 拒绝
`deepseek-v4.1-flash`，`solo_work_remote` 正常）。

思考档位走公共规则，不按 Trae 单独裁剪。实测（同一提示、每档 3 次）`reasoning_tokens` 在
`none/low/high/xhigh/extra_high/max` 之间随机波动（38–109），非法值 `banana` / `999` / `MAX`
同样返回 200，说明 SOLO 通道**不校验** `reasoning_effort`——也正因如此，发 OpenRouter 的档位
不会触发上游错误。宿主按 `resolveModel().reasoning.efforts` 做请求前校验；只有当 OpenRouter
快照为空、列表回退到目录三档时，旧会话里的 `max` 才需要重选。

上下文窗口同时保留上游的 dev 与 Max 两档：模型行默认用 dev，下拉里额外提供它声明的
`maxContextWindow`（例如 1M），不再只显示 200K。

宽窗模型还多一个 500K 中间档（与 `dsh-connect-trae` 一致）：只有当 Max ≥ 500K、且 500K 确实
介于默认窗口与 Max 之间时才出现，落盘值不是该模型可选窗口时会被忽略，不会把模型撑到它没有
的窗口。

工具调用的流有三条必须遵守的细节，都是实测出来的：

1. **id 只在首帧出现。** 参数分片的 `tool_calls[]` 会重复 `index`，但 `id` 与 `type` 是空串。
   把空串当成值写入会把真实 id 覆盖掉，宿主随后就会报
   `tool/result ... requires toolCallId matching its tool source`。因此空 id / 空 name 一律忽略，
   并在发出前再兜一次：缺 id 的调用生成新 id，重复 id 重新生成，保证每次调用一个唯一非空 id。
2. **工具结果必须是 block 数组。** `content` 传字符串会被上游拒绝：`cannot unmarshal string into
   ... messages.content of type []*idecopilot.LLMRawMessageContent`；空数组则报
   `param is invalid`。工具没有文本时补一个空 text block。
3. **一次响应可以带多个工具调用**，`index` 0/1/… 各自独立；`finish_reason` 仍是 `stop`，
   所以有工具调用时按 `tool-calls` 收尾，否则宿主不会执行它们。

`max_tokens` 会被透传（上游接受）；图片走 `image_url` 的 data URL，实测被网关正常识别。
高级设置里的 `traeVisionModelIds` / `traeTextOnlyModelIds` 在目录合并后生效，`textOnly` 优先。

模型 id 与显示名都必须唯一：id 按小写去重（`custom_model_gemini` 这种跨分组重复）；两条
不同 id 归一到同一显示名时（`DeepSeek-V4-Flash` 与 `DeepSeek-V4-Flash-Official`）只保留窗口
更宽的一行，不合成 `(id)` 后缀——共享命名规则只提取上游括号内容，不新增括号。

`Qwen3.8-Flash` / `Kimi-K2.8-Preview` 是客户端 TraeCode 通道的模型：5 个聊天函数和 12 个目录
函数的 `get_detail_param` 都不返回它们的 config，网页令牌调 `/api/ide/v2/llm_raw_chat` 也会对
包括普通模型在内的所有 config 回 `4001`，所以网页登录无法调用；插件把它们隐藏，而不是提供
一个必然失败的入口。若将来要支持，需要另一套桌面端 TraeCode 凭据，不能复用本插件的网页令牌。

模型 id 必须唯一：宿主对重复元数据直接拒绝整条 provider（“invalid or duplicate model
metadata”）。远端目录在多个分组里用不同大小写/显示名重复列出同一 config，所以
`parseTraeRemoteModels` 按小写 id 合并，`mergeTraeModels` 再用 `usedIds` 拦住只在 wire 里
重复出现的 config，`LocalAdapter.listModels` 最后按 id 去重兜底——这一层对所有供应商生效。

额度按区域走不同接口：国内版 `web_user_ent_usage` v2（已用 / 总额 + 资源包，按最早到期排序），
国际版 `web_user_ent_usage` v1（套餐、`basic_usage_limit` / `basic_usage_amount` 美元用量与
`end_time` 重置时间）。国际版的 `ide_user_pay_status` 只有套餐名、没有任何金额，官网的
“Dollar Usage”面板读的也是 v1 这份 roster。签到只有国内版有：`checkin_credits/status` 读状态，
`checkin_credits/claim` 领取；`checked_in` 是账号维度，`did_checked_in` 是设备维度，两者分开
显示。

签到接口只接受 **16 位纯数字**设备号：网页登录的 UUID 会固定返回 `9074`（提示“当前参与用户
太多”，实际是设备号格式不符，实测同账号同分钟 UUID → 9074、16 位数字 → `code: 0`）。
`checkinDeviceId()` 从网页设备号派生稳定的 16 位数字，仅用于 status / claim；聊天、额度仍用
原设备号。缺 `x-device-id` 返回 `9004`，重复领取返回 `9095`。

### 小浣熊的每日积分（`raccoon.ts`）

没有独立的签到端点：积分由服务端在当天首次网页访问时发放，`setting_info` 的
`point_grant_popups` 只是通知，`/points/v2/bills` 里 `biz_type=daily_grant` 的记录才是可核对的
凭据。插件只把 `grant_at` 属于今天（北京时间）的记录算作今日签到，并把 `created_at` 作为到账时间
显示；`ensureDailyCheckin()` 先读流水，未到账才以 web 身份调用 `setting_info`。宿主按
`raccoonCheckinMinutes`（0 关闭）定时跑这一遍，卡片上的网页入口始终保留。

### CodeArts（`codearts-login.ts` + `codearts.ts`）

CodeArts 是唯一不用 Bearer 令牌的供应商：华为 API 网关校验 `SDK-HMAC-SHA256`，所以每次请求都要
用 AK/SK + STS 安全令牌对**确切的请求体**签名。

登录分两段。宿主在 `127.0.0.1` 起一个 ≥10000 端口的回调服务器（portal 拒绝更低的端口），把
`portal/authorize` 地址交给设置页打开；华为回调带 `code` 时用 PKCE（S256）+ DPoP（ES256）换 STS
凭据，带 `secret` 时退回旧的 ticket 轮询（只有 AK/SK，没有续期令牌）。两条都算成功——把旧路径
判成失败会让用户永远停在「等待授权」。PKCE verifier 与 DPoP 私钥随凭据保存：续期必须复用同一对，
换一对会被 STS 拒绝。续期令牌的 `exp` 固定为登录 +30 天且续期不延长，所以判据只看
`invalid_grant` / `ExpiredRefreshToken`；`InvalidDPoPHeader` 属于单次请求失败（时钟偏差、重放窗口），
把它当终态会把材料完好的账号一步标死。

签名有三处细节，任一错都只回 `APIG.0301 verify ak sk signature fail`：路径必须以 `/` 结尾；`host`
参与签名但不发送（由 fetch 生成）；`Agent-Type` / `X-Language` 必须在**签名之后**追加（进 canonical
会验签失败）。`maas_type: benefit` 相反——它**必须**参与签名，缺失时免费额度模型回
`InferHub.002002009.404`。

目录来自两个端点：`opengw gateway/config` 给 benefit 模型（`result.models`），
`snap-access/v1/model/builtin` 给常规模型（`builtinModels`）。两处都**不下发上下文窗口**，窗口取自
IDE 自身 provider 配置的 `limit.context`（`codearts-endpoints.ts` 的静态表，来源与日期写在注释
里）；表里没有的模型落到 `CODEARTS_FALLBACK_CONTEXT_WINDOW`（当前目录最小的真实窗口）——偏小只会
提前压缩，偏大可能让上游拒绝一轮对话。

读图只有两个模型：`kimi-k2.6-vl` 与 `Qwen3-VL-235B`（`builtinModels` 里 `supports_images: true`，
类别「图片理解」）。其余模型（含 `deepseek-v4.1-flash`）带图一律回
`InferHub.001001020.406 The request model is not multimodal`。这两个模型上游 `display_enabled:
false`（IDE 菜单里看不到）但 `enable: true`，实测**能读图也能发工具调用**（同一请求回 8 个
tool-call 分片），所以照样列进目录并按 `supports_images` 标成 `vision`；窗口表里没有它们的
`limit.context`，按模型卡各取 256K。网关名册没有这个字段，那部分仍靠 `CODEARTS_VISION_MODELS` 兜底。

### 为什么 DeepSeek 的图进不来（2026-10-27 实测）

DeepSeek 官方文档写明 `deepseek-flash`（V4.1-Flash-1017）接受图片，但 CodeArts 的目录把
`deepseek-v4.1-flash` / `-1017` 标成 `supports_images: false`，网关按模型能力拒绝。实网 8 种写法
逐一排除（`image_url` 对象 + data URL / 外部 https、`image_url` 字符串、Anthropic `image/source`、
`input_image`、1017 变体），全部失败；同一张图交给 `kimi-k2.6-vl` 正常返回，证明请求体形态正确。
⇒ 不是「换个字段就能传」，是通道级能力禁用。IDE 的处理是两段式（`analyzeImage` 交给 VL 模型），
插件若要对文本模型开放读图，只能在适配器里先做一次 VL 转述（每张新图多一次会话，需缓存结果），
不能把图直接发给文本模型。

思考只有两档：`off` / `on`。网关切的是**顶层** `thinking: { type: 'disabled' }`，不是
`reasoning_effort`；`on` 与不传等价，所以只有关闭时才发该字段。`reasoning_effort` 不是「更细的
档位」：网关会**按模型**校验它（`deepseek-v4.1-flash` 收 `none|low|medium|high|xhigh|max`，
`glm-5.3` 直接拒绝 `none`），但实测不影响思考长度——同一道证明题上 `deepseek-v4.1-flash` 的
`reasoning_tokens` 是 `none` 388 / `low` 480 / `max` 515 / 不传 595，`glm-5.3` 是 `max` 709 /
不传 670，噪声大于档位差；只有 `thinking: disabled` 能把它压到 0。`max_tokens` 钳到 65536（更大的值
是硬 4xx）。聊天带 `tool_stream: true`（超大工具参数分片下发，否则大文件写入会被网关截断）与
`prompt_cache_key`（否则 `cached_tokens` 恒为 0）。

额度来自 `snap-manager/v1/statistics/plugin`：`usageTotalPackageCredit` 是汇总行，**不能**再和三个
分类一起当资源包求和（会翻倍）；只有基础包能拿到真实到期（套餐 `end_date`），赠送包与按需包如实
留空。汇总行同时给出 `package_credit_amount` / `package_credit_used` / `package_credit_remain`，
前两项是卡片进度条唯一的「总额 + 已用」来源（缺汇总行时由分类行相加补出）。签到是三步（账户类型 →
活动列表 → claim + confirm），只在积分计费账户上可用，`claimable=false` 且状态属已领取时才算「今天已领」。

思考档位对每个模型声明 `off|on|low|medium|high|xhigh|max`。`off` 映射到 `thinking: disabled`
（唯一实测能把 `reasoning_tokens` 压到 0 的开关）；`on` 是旧默认，两个字段都不发；其余档位原样写进
`reasoning_effort`。网关按模型校验取值（`glm-5.3` 不接受 `none`），所以 `none` 只作为 `off` 的
兼容别名，不作为独立档位暴露。

账号名不在 STS 响应里（那里只有 AK/SK/安全令牌），而在**续期令牌**的 `user_profile` 声明中：再套
一层 base64 的 JSON，含 `account_name` / `principal_id` / `account_id`。`readUserProfile` 解它，
`CodeArtsAuth.status()` 在记录里没有名字时当场解一次（老账号无需重新登录），续期时再写回记录。
`?secret=` 票据登录拿不到续期令牌，那条路径没有名字。

`wire.ts` 的 SSE 消费被拆成 `consumeOpenAiStream`：CodeArts 要自己签名 fetch，但帧处理与
`openAiStream` 完全相同；`onFrame` 钩子用来抓「HTTP 200 + SSE 内嵌 `error_code`」的排队/额度错误。

### CodeArts 的会话预算（`codearts-window.ts`）

体验版按账号限制会话：**每滚动 60 秒 3 次**，全模型共用，与并发无关，换 `session-id` 不加额度。
实网连续 6 次串行请求的结果是 `OK OK OK` 后整批被 `TM.00001041` 拒绝，约 61 秒后一起恢复；被拒的
请求**不**延长锁定（第 4 次在 72.9s 被拒、93.0s 与 113.2s 再被拒，133.4s 就恢复了，而不是
113.2 + 60）。反过来说，`InferHub.4004.200`（缺 benefit 包）是**会**占额度的，所以那条路径靠
`noBenefit` 记住结论，而不是每次重猜。

`CodeArtsSessionWindow` 因此做两件事：发请求前排队拿名额（满了就等最老的滑出窗口，`MARGIN_MS`
留 1.5 秒吸收「本地开始 → 网关计数」之间的网络时延），以及在被 `TM.00001041` 明确拒绝时把名额
**退回**（`slot.release()`）——占着拒绝请求的名额，会把下一分钟拖成每 20 秒一次，而网关根本没记这
一笔。窗口是进程内单例：热重载重置计数只会让下一次请求撞上网关还记得的额度。

### 公共的名称与能力规则

这些规则在 `src/model-name.ts` 与 `src/openrouter.ts`，Loomy、Raccoon 以及以后新增的供应商
都走同一套，**不按模型 id 硬编码**。

1. **名称归一化**（`parseModelName`）：提取 `()` / `（）` 里的内容；纯倍率（`x0.8`、`12倍`）
   作为 `priceFactor` 并从句子里删掉；其他括号内容变成 `labels`；数字之间的 `-` 变 `.`
   （`GLM-5-3` → `GLM 5.3`），其余 `-` 变空格（`Kimi-K3` → `Kimi K3`）。
2. **OpenRouter 匹配**（`OpenRouterIndex.match`）：`modelKey` 去掉空格、点、横线等，把
   `sn-kimi-k3`、`Kimi K3`、`moonshotai/kimi-k3` 归一到同一 key；先查精确 key，再用双向
   包含做通配匹配（上游少一个版本后缀、或多一个后缀都能命中），同分且有歧义时放弃匹配。
3. **能力来源**（`resolveCapabilities`）：OpenRouter 有 `supported_efforts` /
   `input_modalities` 就用它；否则回退上游的 `reasoning_efforts`、`input_modalities`、
   `capabilities.vision` 或 `tags`；两边都没有时开放全部档位与 text/image 两种模态。
4. **默认档**取列表里**倒数第二强**的一档（强度顺序 `none < minimal < low < medium <
   high < xhigh < max`），由 `defaultEffortOf` 统一计算：不沿用 OpenRouter 的 `max`（太贵），
   也不沿用上游常见默认值 `low` 或 `none`（切模型时看起来像没思考）。只有一个档位时就取它。
5. **档位名只做大写化**：`none` → `None`、`low` → `Low`、`max` → `Max`，`xhigh` 保持原样；
   不做中文翻译。
6. **同步即更新**：OpenRouter 表由插件页的「OpenRouter 模型同步」按配置的间隔自动同步，也可
   手动触发；刷新模型列表**不会**清空它。同步成功后内存快照与磁盘文件一起原子替换，失败则两者
   都保留上一次成功的数据。

Loomy 的 `GET /models` 自带 `reasoning_efforts` 与 `default_reasoning_effort`，但为了统一
规则，它也会先查 OpenRouter（命中时以实时表为准），匹配不上才用上游的档位列表；无论档位来自
哪一边，默认档都按倒数第二强计算。它的请求体直接透传 `reasoning_effort`。

### OpenRouter 快照（`openrouter.ts`）

一份快照由四个供应商共享，由 `index.ts` 创建并注入。`models()` 只读内存（缓存为空时才触发
一次同步），刷新供应商目录不会清空它；`sync()` 是唯一会发网络请求的入口，由 30 秒 tick 按
`openRouterSyncMinutes` 判断是否到期，设置页的「立即同步」也调用它。

原子性分两层：内存中只有完整解析并建好索引后才替换 `snapshot`；磁盘先写同目录临时文件，
再 `rename` 覆盖 `$DSH_HOME/llm-adapters/openrouter-models.json`。任一步失败都不覆盖旧数据，
并把原因放进 `status().error`。并发调用共享同一个 in-flight Promise，所以定时同步、手动同步
和模型读取不会打出多个请求。

Raccoon 的思考控制有两条通道，都要发：`extra_body.thinking.type = enabled | disabled`
（真正的开关，`disabled` 实测能把 `reasoning_tokens` 压到 0）与 `reasoning_effort`
（强度档，网关确实生效；Kimi-K3 上 `low` 约 2.7k、`max` 约 8.4k completion token）。
`raccoon.ts` 只在 DSH 传下 `reasoningEffort` 时才写这两个字段；DSH 会用适配器声明的
`defaultReasoningEffort` 物化它。

额度接口是 `GET /points/v1/balance`，核心字段为 `available_points`（另有 `reward_points`、
`daily_points`、`topup_points`）。没有 `available_points` 时按旧字段回退，绝不编造数字。

### 失败与清理

- 超时、二维码失效、用户取消都会终止页面轮询并把状态写进 `LoginStatus`；设置页显示原因。
- 取消/插件卸载时 `close()` 关闭服务器；正在进行的 provider 轮询即使稍后返回，也不会再写入
  凭据（`advance()` 在落定前检查 `terminal`）。
- 登录页的 QR 与状态接口不带任何令牌；账号写入仍走 `AccountStore`。

## 凭据

凭据只有一个来源：`AccountStore`（`$DSH_HOME/llm-adapters/accounts.json`）。插件不发现、不
读取、也不回写任何客户端登录文件，也没有客户端路径配置项。

`AccountStore` 的读-改-写全部串行在同一条 Promise 链里；并发登录与退出不会互相覆盖。
文件权限 0600；目录由 `DSH_LLM_ADAPTERS_HOME` 或 `$DSH_HOME/llm-adapters` 决定。

- Loomy：登录时声明 14 天有效期并把到期时间存进记录；过期后状态变为未登录，提示重新扫码。
- 小浣熊：扫码得到的 access token 若是 JWT，按 `exp` 判断；没有 JWT 声明的不透明令牌按
  已登录处理，等网关 401 再提示重新扫码。两者都没有刷新流程。
- Trae：一个区域一条记录（`trae.cn` / `trae.global`），带令牌、设备指纹、登录时间、登录时
  捕获的网页 cookie 与网页会话到期时间。JWT 的 `exp` 约 8 小时，到期前 5 分钟用 cookie 调
  `common/GetUserToken` 自动续期；续期失败才提示重新登录。退出登录清当前区域并删除该区域的
  浏览器配置目录。
- CodeArts：AK/SK + STS 安全令牌，外加续期所需的 refresh token、PKCE verifier 与 DPoP 私钥。
  到期前 5 分钟自动续期，续期结果写回同一条记录；续期令牌失效才需要重新授权。

`RaccoonAuth.accessToken(true)` 只用于网关明确拒绝令牌的路径，它会直接报“登录已失效”，
不再尝试刷新或回读任何文件。

## 设置接口

| 路由 | 用途 |
| --- | --- |
| `GET /api/llm-adapters/models?brand=` | 实时目录 + 开关 / 窗口，`fresh=1` 清缓存 |
| `GET /api/llm-adapters/status?brand=` | 登录状态、到期时间、额度 |
| `GET /api/llm-adapters/account/browser?brand=` | 登录进度（本地登录页 URL、Trae 的浏览器状态或 CodeArts 的授权页地址） |
| `POST /api/llm-adapters/account` | `browser` / `browser-cancel` / `checkin` / `logout` |

`checkin` 由 Trae（国内版）与 CodeArts 实现，其余供应商会明确拒绝；`browser` 对 CodeArts 返回
华为云授权页地址，页面在新标签页打开它，之后仍由宿主轮询 `/account/browser` 接回。

写操作在 body 里带 `brand`，URL 不承载写目标。`browser` 还可以带 `region`（`cn` / `global`），
只有 Trae 使用它。配置写入仍走宿主 `configForms` 的修订栅栏，不经过插件自己的写接口。设置页
轮询进度时不会把令牌带给浏览器；`checkin` 只返回签到状态，不返回令牌。

Trae 的区域是配置项 `traeRegion`，不是第二个 brand：设置页切区域时写这个字段，随后按
`brand:region` 的 key 重读状态与目录快照，两个区域的账号与模型选择互不覆盖。

## 传输层

`wire.ts` 把 DSH 的 content blocks 投影成 OpenAI 消息：文本、图片（attachment store → data
URL + 路径句柄）、文件（占位文本）、assistant 工具调用、tool 结果。SSE 解析支持 CRLF 跨块；工具分片
先缓存到流尾再一次性发出，保证 id 与参数完整。

**图片除了像素还要给路径。** 像素让模型「看见」图片，但用户说「取反色后保存」时它需要知道文件在哪。
DSH 的原生适配器会在图片旁附上 `requestImageHandleText()`：附件名、像素尺寸、**只读归一化副本的
宿主路径**，以及「编辑前先复制成可写 `.png`」的指示；只发像素时模型只能去工作区里瞎找（实测回
「图片没有保存在工作目录中」）。现在 `ReadImage` 的返回值带上 `path`（`attachments.imageHostPath()`
取宿主路径，再经 `ctx.fs.processPathFromHostPath()` 映射到工具执行世界），`userContent()` 在
`image_url` 前插入 `imageRefText()` 生成的同一句文案；被请求限额丢弃的图片走
`offloadedImageText()`。适配器还会记住每个模型上一次验证过的 `vision` 能力：目录某次读不到时不再
谎报 text-only——那会让 DSH 在适配器之前就把像素换成占位符。

- 上游只给 `[DONE]`、不给 `finish_reason` 时（Loomy 会这样截断），标记为 `max-tokens`。
- usage 全部向上取整并保证 `reasoningTokens <= outputTokens`；DSH 的持久化校验不接受小数。
- 小浣熊在 401 时不再重放请求：扫码登录没有刷新流程，直接提示重新扫码，避免重复回答。

## 测试与构建

```sh
npm install
npm run typecheck
npm test
npm run build
```

`lib/` 随源码一起提交：从 GitHub 直装（`github:k1-h2/dsh-llm-adapters`）时 pnpm 不会执行构建，
没有 `lib/index.js` 的包会在启用时报 `ERR_MODULE_NOT_FOUND`。改完 `src/` 必须重新构建并提交产物。

`vitest` 覆盖目录解析、登录页状态机、Loomy 长轮询与扫码绑定、小浣熊扫码轮询、Trae 两份目录
的合并与档位映射、CodeArts 的签名 / PKCE-DPoP / 双目录 / 倍率时段 / 额度 / 签到、SSE 与工具
调用、凭据存储与并发、过期判定、设置 API。登录相关的测试全部注入假 `fetch`，不访问真实上游，
也不启动浏览器。需要真机验证时，手动点一次「打开扫码登录」或「打开浏览器登录」，确认接回、
模型列表与一次对话。

## 易变点

- Loomy 依赖微信授权页的 HTML 里仍内嵌 `/connect/qrcode/<uuid>`，以及讯飞账号端点的签名规则
  和 `accessKeyId` / `accessKeySecret` / `appId` 常量。页面改版先看 `extractWechatUuid()`。
- 小浣熊依赖 `/auth/mp/qrcode` 的签发字段、`scan_path` 形态与 `auth/mp/qrcode/login` 的
  状态值；扫码页或状态值改名会使二维码扫不出结果。
- 目录字段：Loomy 的倍率在展示名称的括号里，小浣熊的 `billing_*` / `params.*` 可能改名；
  名称归一化与 OpenRouter 匹配都依赖这些字段的语义，改版时先看 `parseModelName` /
  `buildOpenRouterIndex` 的测试。
- OpenRouter 表本身会变，所以每次「刷新状态与模型」都重拉，不写死任何模型清单；匹配不到时
  回退上游，再没有就全部开放，任何新供应商都自动适用这套规则。
- Trae 依赖 `DevToolsActivePort` 与 CDP 的 `Network.getAllCookies`、以及页面里的
  `localStorage.__msuuid__`；浏览器或站点改版后先看 `trae-login.ts` 的 `DEVICE_EXPRESSION`
  与 `authPost` 路径。两个区域的基址集中在 `trae-endpoints.ts`，站点换域名只需改那一处。
- CodeArts 依赖华为云的 `portal/authorize` 参数拼写（`code_challenge_method` 必须是 `SHA-256`
  而不是 `S256`，否则 portal 退回 ticket 流程）、`sts…/v1/oauth2/tokens` 的 DPoP 校验，以及
  两个目录端点的字段名（`model_id` / `builtinModels` / `result.models`）。窗口静态表与 benefit
  清单都在 `codearts-endpoints.ts`；上游调整窗口或新增 benefit 模型时改那一处。
