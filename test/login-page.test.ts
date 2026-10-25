import { afterEach, describe, expect, it, vi } from 'vitest'
import { startLoginPage, type LoginPageHandle, type LoginPoll } from '../src/login-page.ts'

const handles: LoginPageHandle[] = []

afterEach(async () => {
  await Promise.all(handles.splice(0).map(handle => handle.close()))
})

function statusUrl(handle: LoginPageHandle): string {
  return handle.url.replace(/\/login$/, '/status')
}

async function status(handle: LoginPageHandle): Promise<Record<string, unknown>> {
  return await (await fetch(statusUrl(handle))).json() as Record<string, unknown>
}

describe('login page', () => {
  it('serves a local page, hands over the QR, and settles after finish', async () => {
    const finish = vi.fn(async () => undefined)
    const poll = vi.fn<() => Promise<LoginPoll>>()
      .mockResolvedValueOnce({ phase: 'waiting' })
      .mockResolvedValueOnce({ phase: 'scanned' })
      .mockResolvedValueOnce({ phase: 'done', message: 'ok' })

    const handle = await startLoginPage({
      title: 'Test login',
      heading: 'Scan me',
      subtitle: 'with a phone',
      prepare: async () => ({ qr: '<svg id="qr"></svg>' }),
      poll,
      finish,
    })
    handles.push(handle)

    expect(handle.url.startsWith('http://127.0.0.1:')).toBe(true)
    expect(new URL(handle.url).pathname).toMatch(/^\/[0-9a-f]{32}\/login$/)

    const page = await (await fetch(handle.url)).text()
    expect(page).toContain('Scan me')
    expect(page).toContain('with a phone')

    // The QR may still be preparing when the page is requested; the status
    // endpoint delivers it once and only once.
    let first = await status(handle)
    for (let attempt = 0; attempt < 20 && first.qr === undefined; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 10))
      first = await status(handle)
    }
    expect(first.qr).toContain('<svg')

    const second = await status(handle)
    expect(second.qr).toBeUndefined()
    expect(second.phase).toMatch(/waiting|scanned|done/)

    for (let attempt = 0; attempt < 20 && handle.status().phase !== 'done'; attempt++) {
      await status(handle)
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(handle.status().phase).toBe('done')
    expect(handle.status().running).toBe(false)
    expect(handle.status().signedIn).toBe(true)
    expect(finish).toHaveBeenCalledOnce()
    await handle.result
  })

  it('reports a provider error and rejects the result', async () => {
    const handle = await startLoginPage({
      title: 'Test',
      heading: 'Scan',
      subtitle: '',
      prepare: async () => ({ qr: '<svg></svg>' }),
      poll: async () => ({ phase: 'error', message: '微信授权失败' }),
    })
    handles.push(handle)

    for (let attempt = 0; attempt < 20 && handle.status().phase !== 'error'; attempt++) {
      await status(handle)
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(handle.status().phase).toBe('error')
    expect(handle.status().error).toContain('微信授权失败')
  })

  it('supports a phone-binding second step', async () => {
    const sent = vi.fn(async () => undefined)
    const verified = vi.fn(async () => undefined)
    const finish = vi.fn(async () => undefined)
    const handle = await startLoginPage({
      title: 'Test',
      heading: 'Bind',
      subtitle: '',
      prepare: async () => ({ qr: '<svg></svg>' }),
      poll: async () => ({ phase: 'binding', message: '需要手机号' }),
      binding: { hint: '绑定手机号', send: sent, verify: verified },
      finish,
    })
    handles.push(handle)

    const page = await (await fetch(handle.url)).text()
    expect(page).toContain('绑定手机号')

    for (let attempt = 0; attempt < 20; attempt++) {
      await status(handle)
      await new Promise(resolve => setTimeout(resolve, 10))
      if (handle.status().phase === 'binding') break
    }
    expect(handle.status().phase).toBe('binding')

    const prefix = new URL(handle.url).pathname.replace(/\/login$/, '')
    const bad = await fetch(`http://127.0.0.1:${new URL(handle.url).port}${prefix}/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone: '123' }),
    })
    expect(await bad.json()).toMatchObject({ ok: false })

    const send = await fetch(`http://127.0.0.1:${new URL(handle.url).port}${prefix}/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone: '13800138000' }),
    })
    expect(await send.json()).toMatchObject({ ok: true })
    expect(sent).toHaveBeenCalledWith('13800138000')

    const verify = await fetch(`http://127.0.0.1:${new URL(handle.url).port}${prefix}/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone: '13800138000', code: '123456' }),
    })
    expect(await verify.json()).toMatchObject({ ok: true, done: true })
    expect(verified).toHaveBeenCalledWith('13800138000', '123456')
    expect(finish).toHaveBeenCalledOnce()
    expect(handle.status().phase).toBe('done')
    await handle.result
  })

  it('times out and closes cleanly', async () => {
    const handle = await startLoginPage({
      title: 'Test',
      heading: 'Wait',
      subtitle: '',
      prepare: async () => ({ qr: '<svg></svg>' }),
      poll: async () => ({ phase: 'waiting' }),
      timeoutMs: 30,
    })
    handles.push(handle)
    const error = await handle.result.then(() => undefined, (reason: unknown) => reason)
    expect(String(error)).toContain('超时')
    expect(handle.status().phase).toBe('error')
    await handle.close()
    await handle.close()
  })
})
