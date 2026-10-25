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
  browser-login.ts   Chromium 启动、DevTools 连接、登录轮询与凭据提取
  account-profile.ts 小浣熊账号展示字段
  loomy.ts           Loomy 目录 / 积分 / 流式调用 / 浏览器登录
  raccoon.ts         小浣熊目录 / 余额 / 流式调用 / 浏览器登录
  catalog.ts         目录解析、模型缓存
  wire.ts            OpenAI 兼容 SSE、工具调用、usage
  config.ts          volatile 配置与 live 读取
client.js            设置页（ModuleLoader bundle，无构建步骤）
test/                vitest，不访问真实上游
```

## 浏览器登录

### 启动与连接

`BrowserLoginFlow.start()` 同步返回状态，后台执行：

1. 按 `DSH_LLM_ADAPTERS_BROWSER` → Edge → Chrome → Brave → Chromium 的顺序查找可执行文件。
2. 用 `mkdtemp()` 建临时用户目录，启动
   `--remote-debugging-port=0 --user-data-dir=<tmp> --disable-extensions --new-window <loginUrl>`。
3. 轮询 `<tmp>/DevToolsActivePort`，拿到端口与浏览器级 WebSocket 路径后用全局 `WebSocket` 连接。
4. 通过 `Target.getTargets` 找页面，`Target.attachToTarget(flatten: true)` 建会话，启用
   `Runtime` 与 `Network`。

要求 Node 22+（全局 WebSocket）。浏览器窗口必须是 Chromium 内核；Firefox/Safari 没有这套协议。

### 轮询与“回调”

没有 localhost 回调地址。每 1.5 秒：

- 对 URL 命中 `hosts` 的页面执行 provider 的 `probe`（读取 localStorage / document.cookie，
  Loomy 还会请求 `/api/workspace/auth/me`）。
- 用 `Storage.getCookies` 收集 `cookieDomains` 域下的 Cookie。
- 从 `Network.responseReceived` + `loadingFinished` + `getResponseBody` 收集登录接口返回的
  JSON（URL 匹配 auth/login/token/session，最多 20 条）。

所有候选去重后交给 `resolve()`：逐个向模型网关验证，第一个通过的就是登录凭据。只有
`resolve()` 返回账号时才调用 `save()` 写入存储；随后关闭浏览器、删除临时目录，状态变为
`done`。设置页轮询 `GET /account/browser?brand=...` 收到 `running:false, signedIn:true`
后再拉一次 `/status`。

### 失败与清理

- 默认 5 分钟超时。窗口被用户关闭、浏览器退出、没有端口文件都会进入 `failed`。
- `cancel()` 立即把状态置为 `cancelled`，关闭驱动；后台循环检查 `cancelled` 后退出。
- 结束时先 `Browser.close`，再 `child.kill()`，临时目录最多重试删除 8 次（Windows 句柄释放慢，
  一次 `rm` 会留下登录 Cookie）。
- 插件卸载时 `LocalAdapter.close()` 会取消仍在运行的流程。

### Provider 的提取与校验

- **Loomy**：扫描 localStorage、Cookie；`resolve` 用 `loomyGatewaySessionValid()` 请求
  `/models`，要求返回模型数组。网关对无效 token 常回 200 + 业务错误码，所以不能只看 HTTP 状态。
  通过后用 `/userinfo/query/baseInfo` 补昵称（失败忽略）。
- **小浣熊**：只接受 JWT 形状的值；`raccoonAccessTokenValid()` 请求 `model_catalog` 且要求
  `code === 0`。refresh token 取另一个 JWT、过期时间最远的那个
  （`raccoonRefreshCandidate()`），写入插件存储后由 `RaccoonAuth` 正常轮换。

Loomy 网页登录可能只产生网页会话，网关不接受。此时 `resolve` 全部失败，流程以
`timeout`/「没有拿到可用的模型调用凭据」结束，不写入任何凭据。

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
| `GET /api/llm-adapters/account/browser?brand=` | 浏览器登录进度 |
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

`vitest` 覆盖目录解析、浏览器流程（假驱动）、凭据存储与并发、凭据优先级、刷新回写、SSE 与
工具调用、设置 API。浏览器登录的单元测试不启动真实浏览器；需要真机验证时，手动点一次
「打开浏览器登录」，确认窗口、接回、模型列表与一次对话。

## 易变点

- 浏览器登录依赖官方页面的登录实现：localStorage 键名、Cookie 名、登录接口路径。页面改版后
  先检查 `browser-login.ts` 的两个 probe 与 auth 响应过滤。
- Loomy 账号服务的签名常量（若将来改回账号密码/短信路径）与网页会话格式；当前代码只校验
  网关，不解析网页会话。
- 小浣熊 `auth.json` 字段名与 refresh 单次使用语义。
- 目录字段：Loomy 的倍率在展示名称里，小浣熊的 `billing_*` / `params.*` 可能改名。
- 图片能力不能只信标签；小浣熊使用 `RACCOON_MEASURED_VISION`，Loomy 以目录 capabilities 为准。
