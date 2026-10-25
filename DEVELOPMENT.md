# 开发文档

实现要点与改这个仓库前必须知道的约束。返回 [README](./README.md)。

## 目录结构

```
src/
  index.ts           注册 loomy / raccoon 路由、设置接口与配置目录
  adapter.ts         把 DSH 请求接到 provider client，模型解析与上下文窗口
  api.ts             /models、/status、/account/browser、/account
  auth.ts            凭据优先级、桌面文件读取、小浣熊刷新与回写
  account-store.ts   插件自己的凭据文件（原子写、0600、串行读改写）
  login-page.ts      本地登录页：随机端口/路径、二维码下发、状态轮询、可选绑手机
  qr.ts              零依赖二维码（byte 模式、纠错 M、版本 1–10）
  loomy-login.ts     Loomy 微信扫码：uuid、长轮询、讯飞账号 HMAC 接口
  raccoon-login.ts   小浣熊扫码：服务端签发二维码、轮询、业务会话确认
  account-profile.ts 小浣熊账号展示字段
  loomy.ts           Loomy 目录 / 积分 / 流式调用
  raccoon.ts         小浣熊目录 / 余额 / 流式调用
  catalog.ts         目录解析、模型缓存
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
   `model_catalog` 校验令牌；只有网关接受的令牌才写入账号存储。响应若带 `refresh_token` 就
   一并保存，没有时到期后重新扫码。

⚠️ 不能像旧版那样在本地随机生成 `code`：轮询会返回 `pending`，但微信扫到的落地页会把该码判为
“过期或已被使用”。码必须来自第 1 步。

不走官方桌面端的 `office-raccoon://auth/callback`，也不改网页里写死的回调地址。

模型清单里 `name` 取远端的 `description`（`Kimi-K3`），`display_description` 只作说明；旧版
把中文任务描述当成了模型名。

思考开关是**两态**，不是强度档位：请求体写 `extra_body.thinking.type = enabled | disabled`。
`reasoning_effort` 虽被服务端接受但不影响行为。`on` / `off` 由 `catalog.ts` 声明，默认 `off`；
即使 DSH 没有物化默认值，`raccoon.ts` 也会显式发送 `disabled`，保证实际行为与 UI 一致。

额度接口是 `GET /points/v1/balance`，核心字段为 `available_points`（另有 `reward_points`、
`daily_points`、`topup_points`）。没有 `available_points` 时按旧字段回退，绝不编造数字。

### 失败与清理

- 超时、二维码失效、用户取消都会终止页面轮询并把状态写进 `LoginStatus`；设置页显示原因。
- 取消/插件卸载时 `close()` 关闭服务器；正在进行的 provider 轮询即使稍后返回，也不会再写入
  凭据（`advance()` 在落定前检查 `terminal`）。
- 登录页的 QR 与状态接口不带任何令牌；账号写入仍走 `AccountStore`。

## 凭据与刷新

`AuthStatus.sourceKind` 只有两种：`account`（插件存储）与 `file`（桌面客户端）。

读取顺序固定：插件存储优先，其次桌面文件。小浣熊刷新时按来源回写：

- `account` → `AccountStore.saveRaccoon()`；
- `file` → 保留原文件其他字段，临时文件 + rename 原子替换。

`AccountStore` 的读-改-写全部串行在同一条 Promise 链里；并发登录与刷新不会互相覆盖。
文件权限 0600；目录由 `DSH_LLM_ADAPTERS_HOME` 或 `$DSH_HOME/llm-adapters` 决定。

小浣熊的 access token 若没有 JWT 声明（浏览器登录可能返回不透明令牌），`account` 来源按
已登录处理，等网关 401 时再强制刷新；`file` 来源仍要求可解码的过期时间，避免把坏文件当登录。

Loomy 没有 refresh token；插件存储里按登录时间 + 14 天估算到期，过期后状态提示重新登录。

## 设置接口

| 路由 | 用途 |
| --- | --- |
| `GET /api/llm-adapters/models?brand=` | 实时目录 + 开关 / 窗口，`fresh=1` 清缓存 |
| `GET /api/llm-adapters/status?brand=` | 登录状态、到期时间、额度 |
| `GET /api/llm-adapters/account/browser?brand=` | 扫码登录进度（含本地登录页 URL） |
| `POST /api/llm-adapters/account` | `browser` / `browser-cancel` / `logout` |

写操作在 body 里带 `brand`，URL 不承载写目标。配置写入仍走宿主 `configForms` 的修订栅栏，
不经过插件自己的写接口。设置页轮询进度时不会把令牌带给浏览器。

## 传输层

`wire.ts` 把 DSH 的 content blocks 投影成 OpenAI 消息：文本、图片（attachment store → data
URL）、文件（占位文本）、assistant 工具调用、tool 结果。SSE 解析支持 CRLF 跨块；工具分片
先缓存到流尾再一次性发出，保证 id 与参数完整。

- 上游只给 `[DONE]`、不给 `finish_reason` 时（Loomy 会这样截断），标记为 `max-tokens`。
- usage 全部向上取整并保证 `reasoningTokens <= outputTokens`；DSH 的持久化校验不接受小数。
- 小浣熊在 401 时最多重试一次，且只在还没有向调用方输出任何字节时重试，避免重复回答。

## 测试与构建

```sh
npm install
npm run typecheck
npm test
npm run build
```

`vitest` 覆盖目录解析、登录页状态机、Loomy 长轮询与扫码绑定、小浣熊扫码轮询、凭据存储与
并发、凭据优先级、刷新回写、SSE 与工具调用、设置 API。登录相关的测试全部注入假 `fetch`，
不访问真实上游，也不启动浏览器。需要真机验证时，手动点一次「打开扫码登录」，确认二维码、
手机确认后的接回、模型列表与一次对话。

## 易变点

- Loomy 依赖微信授权页的 HTML 里仍内嵌 `/connect/qrcode/<uuid>`，以及讯飞账号端点的签名规则
  和 `accessKeyId` / `accessKeySecret` / `appId` 常量。页面改版先看 `extractWechatUuid()`。
- 小浣熊依赖扫码页 URL 形态、`login_with_qrcode_code` 的状态值与 `auth.json` 字段名；扫码页
  或状态值改名会使二维码扫不出结果。
- 小浣熊 refresh 仍是单次使用；Rotated pair 必须原子回写。
- 目录字段：Loomy 的倍率在展示名称里，小浣熊的 `billing_*` / `params.*` 可能改名。
- 图片能力不能只信标签；小浣熊使用 `RACCOON_MEASURED_VISION`，Loomy 以目录 capabilities 为准。
