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

import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

export type LoginPhase =
  | 'idle'
  | 'preparing'
  | 'waiting'
  | 'scanned'
  | 'binding'
  | 'done'
  | 'error'
  | 'cancelled'
  | 'expired'

/** What the settings page may see. */
export interface LoginStatus {
  running: boolean
  phase: LoginPhase
  url?: string
  error?: string
  signedIn?: boolean
  startedAt?: number
  finishedAt?: number
  /** Human-readable progress; browser-driven flows use it instead of a QR. */
  message?: string
}

/** One poll result from a provider flow. */
export interface LoginPoll {
  phase: 'waiting' | 'scanned' | 'binding' | 'done' | 'error' | 'cancelled' | 'expired'
  message?: string
  /** Replacement QR markup, when the provider rotates the code. */
  qr?: string
}

/** Optional second step for providers that must bind a phone to a social login. */
export interface LoginBindingSpec {
  hint: string
  send(phone: string): Promise<void>
  verify(phone: string, code: string): Promise<void>
}

export interface LoginPageSpec {
  title: string
  heading: string
  subtitle: string
  /** Called once after the page is listening; returns inline QR markup. */
  prepare(): Promise<{ qr: string }>
  /** One provider-side step. May take as long as the provider does (30–40 s). */
  poll(): Promise<LoginPoll>
  /** Persist the account once {@link poll} reports `done`. */
  finish?(): Promise<void>
  binding?: LoginBindingSpec
  timeoutMs?: number
}

export interface LoginPageHandle {
  url: string
  result: Promise<void>
  status(): LoginStatus
  close(): Promise<void>
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1_000
const MAX_BODY_BYTES = 8 * 1024
const CLOSE_AFTER_TERMINAL_MS = 60_000

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function sendJson(response: ServerResponse, payload: unknown): void {
  const body = JSON.stringify(payload)
  response.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(body)
}

function sendHtml(response: ServerResponse, html: string): void {
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; connect-src 'self'",
  })
  response.end(html)
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    total += buffer.length
    if (total > MAX_BODY_BYTES) throw new Error('请求体过大')
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return {}
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    throw new Error('请求体不是合法 JSON')
  }
}

function listenOnLoopback(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      if (port === 0) {
        reject(new Error('本地登录页未能获得端口'))
        return
      }
      resolve(port)
    })
  })
}

/**
 * Start the page and the host-side poll loop. Resolves as soon as the loopback
 * server listens; the QR may still be preparing, and the page polls for it.
 */
export async function startLoginPage(spec: LoginPageSpec): Promise<LoginPageHandle> {
  const prefix = `/${randomBytes(16).toString('hex')}`
  const paths = {
    login: `${prefix}/login`,
    status: `${prefix}/status`,
    send: `${prefix}/send`,
    verify: `${prefix}/verify`,
  }

  const startedAt = Date.now()
  let phase: LoginPhase = 'preparing'
  let qr = ''
  let qrDelivered = false
  let message = '正在准备二维码…'
  let finishedAt: number | undefined
  let terminal = false
  let closed = false
  let url = ''
  let polling: Promise<LoginPoll> | undefined

  let resolveResult!: () => void
  let rejectResult!: (reason: unknown) => void
  const result = new Promise<void>((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })
  result.catch(() => {})

  let closeTimer: NodeJS.Timeout | undefined
  let pump: NodeJS.Timeout | undefined
  let closeNow: () => Promise<void> = async () => {}
  const scheduleClose = (): void => {
    closeTimer = setTimeout(() => { void closeNow() }, CLOSE_AFTER_TERMINAL_MS)
    closeTimer.unref?.()
  }

  const settle = (next: 'done' | 'error' | 'cancelled' | 'expired', reason?: string): void => {
    if (terminal) return
    terminal = true
    phase = next
    finishedAt = Date.now()
    if (reason !== undefined) message = reason
    if (next === 'done') resolveResult()
    else rejectResult(new Error(reason ?? '登录失败'))
    scheduleClose()
  }

  const snapshot = (): LoginStatus => {
    const base: LoginStatus = {
      running: !terminal,
      phase,
      startedAt,
      ...url.length === 0 ? {} : { url },
      ...finishedAt === undefined ? {} : { finishedAt },
      ...phase === 'done' ? { signedIn: true } : {},
    }
    if (terminal && phase !== 'done' && message.length > 0) base.error = message
    return base
  }

  async function advance(): Promise<LoginPoll> {
    if (polling !== undefined) return polling
    polling = (async () => {
      const state = await spec.poll()
      if (terminal) return state
      if (state.phase === 'done') {
        await spec.finish?.()
        phase = 'done'
        message = state.message ?? '登录成功，可以关闭此窗口。'
        settle('done')
      } else if (state.phase === 'error' || state.phase === 'cancelled' || state.phase === 'expired') {
        settle(state.phase, state.message)
      } else {
        phase = state.phase
        message = state.message ?? ''
        if (state.qr !== undefined) {
          qr = state.qr
          qrDelivered = true
        }
      }
      return state
    })()
    try {
      return await polling
    } finally {
      polling = undefined
    }
  }

  const server = createServer((request, response) => {
    void serve(request, response).catch((error: unknown) => {
      try {
        sendJson(response, { error: error instanceof Error ? error.message : String(error) })
      } catch {
        /* response already sent */
      }
    })
  })

  async function serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const incoming = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (incoming.pathname === paths.login) {
      sendHtml(response, renderPage(spec, paths, qr))
      return
    }
    if (incoming.pathname === paths.status) {
      if (terminal) {
        sendJson(response, {
          phase,
          message,
          ...phase === 'done' ? { done: true } : {},
        })
        return
      }
      if (phase === 'preparing') {
        sendJson(response, { phase, message })
        return
      }
      // Hand the QR over before the next provider poll: a Loomy long poll can
      // sit for 40 s, and the page would otherwise stay blank behind it.
      if (qr.length > 0 && !qrDelivered) {
        qrDelivered = true
        sendJson(response, { phase, message, qr })
        return
      }
      if (phase === 'binding') {
        sendJson(response, { phase, message })
        return
      }
      // A long poll may already be in flight; two page requests must not start
      // two provider polls, so the second answer is the current state.
      if (polling !== undefined) {
        sendJson(response, { phase, message })
        return
      }
      try {
        const state = await advance()
        const payload: Record<string, unknown> = { phase: state.phase, message: state.message ?? '' }
        if (state.qr !== undefined) payload.qr = state.qr
        else if (qr.length > 0 && !qrDelivered) {
          payload.qr = qr
          qrDelivered = true
        }
        sendJson(response, payload)
      } catch (error) {
        if (closed) return
        settle('error', error instanceof Error ? error.message : String(error))
        sendJson(response, { phase, message })
      }
      return
    }
    if (incoming.pathname === paths.send && request.method === 'POST') {
      const body = await readJson(request)
      const phone = typeof body.phone === 'string' ? body.phone.trim() : ''
      if (spec.binding === undefined) {
        sendJson(response, { ok: false, message: '当前登录流程不需要绑定手机号' })
        return
      }
      if (!/^1[3-9]\d{9}$/.test(phone)) {
        sendJson(response, { ok: false, message: '请输入 11 位手机号' })
        return
      }
      try {
        await spec.binding.send(phone)
        sendJson(response, { ok: true })
      } catch (error) {
        sendJson(response, { ok: false, message: error instanceof Error ? error.message : String(error) })
      }
      return
    }
    if (incoming.pathname === paths.verify && request.method === 'POST') {
      const body = await readJson(request)
      const phone = typeof body.phone === 'string' ? body.phone.trim() : ''
      const code = typeof body.code === 'string' ? body.code.trim() : ''
      if (spec.binding === undefined) {
        sendJson(response, { ok: false, message: '当前登录流程不需要绑定手机号' })
        return
      }
      if (!/^1[3-9]\d{9}$/.test(phone) || !/^\d{4,8}$/.test(code)) {
        sendJson(response, { ok: false, message: '请填写手机号和短信验证码' })
        return
      }
      try {
        await spec.binding.verify(phone, code)
        await spec.finish?.()
        phase = 'done'
        message = '登录成功，可以关闭此窗口。'
        settle('done')
        sendJson(response, { ok: true, done: true })
      } catch (error) {
        sendJson(response, { ok: false, message: error instanceof Error ? error.message : String(error) })
      }
      return
    }
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found')
  }

  const port = await listenOnLoopback(server)
  url = `http://127.0.0.1:${port}${paths.login}`
  const timeoutTimer = setTimeout(() => {
    if (!terminal) settle('error', '登录等待超时，请重新发起登录。')
  }, spec.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  timeoutTimer.unref?.()

  const handle: LoginPageHandle = {
    url,
    result,
    status: snapshot,
    close: async () => {
      if (closed) return
      closed = true
      clearTimeout(timeoutTimer)
      if (pump !== undefined) clearInterval(pump)
      if (closeTimer !== undefined) clearTimeout(closeTimer)
      if (!terminal) {
        terminal = true
        phase = 'cancelled'
        finishedAt = Date.now()
        message = '登录已取消。'
        rejectResult(new Error(message))
      }
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections?.()
      })
    },
  }
  closeNow = handle.close

  // The host owns the polling, not the browser tab. This is what lets a login
  // finish even if the popup was closed after the phone confirmation.
  pump = setInterval(() => {
    if (terminal || phase === 'preparing' || phase === 'binding' || polling !== undefined) return
    void advance().catch((error: unknown) => {
      if (!closed) settle('error', error instanceof Error ? error.message : String(error))
    })
  }, 2_000)
  pump.unref?.()

  void (async () => {
    try {
      const prepared = await spec.prepare()
      if (terminal) return
      qr = prepared.qr
      if (qr.length === 0) throw new Error('二维码内容为空')
      phase = 'waiting'
      message = '等待扫码…'
    } catch (error) {
      if (!terminal) settle('error', error instanceof Error ? error.message : String(error))
    }
  })()

  return handle
}

function renderPage(
  spec: LoginPageSpec,
  paths: { login: string, status: string, send: string, verify: string },
  qr: string,
): string {
  const form = spec.binding === undefined
    ? ''
    : `
    <div class="form" id="form" hidden>
      <div class="hint">${escapeHtml(spec.binding.hint)}</div>
      <div class="row">
        <input id="phone" type="tel" inputmode="numeric" maxlength="11" placeholder="手机号">
        <button id="send" type="button">获取验证码</button>
      </div>
      <input id="code" type="text" inputmode="numeric" maxlength="8" placeholder="短信验证码">
      <button id="verify" type="button" class="primary">完成绑定并登录</button>
    </div>`
  const formScript = spec.binding === undefined
    ? ''
    : `
  var form = document.getElementById('form');
  var phoneEl = document.getElementById('phone');
  var codeEl = document.getElementById('code');
  var sendBtn = document.getElementById('send');
  var verifyBtn = document.getElementById('verify');
  function digits(value) { return (value || '').replace(/[^0-9]/g, ''); }
  sendBtn.addEventListener('click', function () {
    var phone = digits(phoneEl.value);
    if (phone.length !== 11) { setStatus('请输入 11 位手机号', 'err'); return; }
    sendBtn.disabled = true;
    setStatus('正在发送验证码…');
    post('${paths.send}', { phone: phone }).then(function (res) {
      setStatus(res.ok ? '验证码已发送' : (res.message || '发送失败'), res.ok ? 'ok' : 'err');
    }).catch(function () { setStatus('发送失败，请重试', 'err'); })
      .finally(function () { sendBtn.disabled = false; });
  });
  verifyBtn.addEventListener('click', function () {
    var phone = digits(phoneEl.value);
    var code = digits(codeEl.value);
    if (phone.length !== 11) { setStatus('请输入 11 位手机号', 'err'); return; }
    if (code.length === 0) { setStatus('请输入短信验证码', 'err'); return; }
    verifyBtn.disabled = true;
    setStatus('正在完成绑定…');
    post('${paths.verify}', { phone: phone, code: code }).then(function (res) {
      if (res.ok && res.done) { done = true; setStatus('登录成功，可以关闭此窗口。', 'ok'); form.hidden = true; }
      else setStatus(res.message || '验证码错误，请重试', 'err');
    }).catch(function () { setStatus('绑定失败，请重试', 'err'); })
      .finally(function () { verifyBtn.disabled = false; });
  });`

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(spec.title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
         font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
         background: #f5f6f8; color: #1f2329; }
  .card { background: #fff; border-radius: 12px; padding: 26px 30px; box-shadow: 0 4px 24px rgba(0,0,0,.08);
          text-align: center; width: 320px; }
  h1 { font-size: 17px; margin: 0 0 6px; font-weight: 600; }
  .sub { font-size: 13px; color: #8a9099; margin: 0 0 16px; }
  .qr { width: 220px; height: 220px; display: flex; align-items: center; justify-content: center;
        margin: 0 auto; border: 1px solid #eceef1; border-radius: 8px; background: #fff;
        font-size: 12px; color: #8a9099; }
  .qr img, .qr svg { width: 100%; height: 100%; display: block; border-radius: 6px; }
  .status { margin-top: 16px; font-size: 13px; color: #4e5969; min-height: 20px; }
  .status[data-tone="ok"] { color: #0f9d58; font-weight: 600; }
  .status[data-tone="err"] { color: #d93026; }
  .form { margin-top: 16px; text-align: left; }
  .hint { font-size: 12px; color: #8a9099; margin-bottom: 8px; }
  .row { display: flex; gap: 8px; }
  input { width: 100%; box-sizing: border-box; padding: 8px 10px; font-size: 14px; margin-bottom: 8px;
          border: 1px solid #d9dde3; border-radius: 6px; }
  button { padding: 8px 12px; font-size: 13px; border: 0; border-radius: 6px; background: #f2f3f5;
           color: #1f2329; cursor: pointer; white-space: nowrap; }
  button.primary { width: 100%; background: #07c160; color: #fff; padding: 9px; font-size: 14px; }
  button:disabled { opacity: .5; cursor: not-allowed; }
  .row button { margin-bottom: 8px; }
</style>
</head>
<body>
  <div class="card">
    <h1>${escapeHtml(spec.heading)}</h1>
    <p class="sub">${escapeHtml(spec.subtitle)}</p>
    <div class="qr" id="qr">${qr.length > 0 ? qr : '正在准备二维码…'}</div>
    <div class="status" id="status">${qr.length > 0 ? '等待扫码…' : '正在准备二维码…'}</div>
    ${form}
  </div>
<script>
(function () {
  var statusEl = document.getElementById('status');
  var qrEl = document.getElementById('qr');
  var done = false;
  var bindingShown = false;
  var qrShown = ${qr.length > 0 ? 'true' : 'false'};
  var missed = 0;

  function setStatus(text, tone) {
    statusEl.textContent = text;
    if (tone) statusEl.setAttribute('data-tone', tone);
    else statusEl.removeAttribute('data-tone');
  }

  function post(path, payload) {
    return fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).then(function (response) { return response.json(); });
  }

  function poll() {
    if (done) return;
    fetch('${paths.status}')
      .then(function (response) { return response.json(); })
      .then(function (res) {
        missed = 0;
        if (res.qr && !qrShown) { qrEl.innerHTML = res.qr; qrShown = true; }
        if (res.phase === 'done') { done = true; setStatus(res.message || '登录成功，可以关闭此窗口。', 'ok'); return; }
        if (res.phase === 'error' || res.phase === 'cancelled' || res.phase === 'expired') {
          done = true; setStatus(res.message || '登录失败', 'err'); return;
        }
        if (res.phase === 'binding') {
          if (!bindingShown) {
            bindingShown = true;
            setStatus('已扫码，请绑定手机号');
            ${spec.binding === undefined ? '' : 'document.getElementById(\'form\').hidden = false;'}
          }
          // Keep polling so a server-side timeout or cancellation still shows.
          setTimeout(poll, 2000);
          return;
        }
        if (res.phase === 'scanned') setStatus('已扫码，请在手机上确认');
        else if (res.phase === 'preparing') setStatus('正在准备二维码…');
        else setStatus('等待扫码…');
        setTimeout(poll, 1200);
      })
      .catch(function () {
        missed += 1;
        if (missed >= 20) { setStatus('连接登录页失败，请刷新重试', 'err'); return; }
        setTimeout(poll, 1500);
      });
  }

  ${formScript}

  poll();
})();
</script>
</body>
</html>`
}
