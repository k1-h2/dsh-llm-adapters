import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CODEARTS_SESSION_LIMIT, CODEARTS_SESSION_WINDOW_MS, CodeArtsSessionWindow, sharedSessionWindow,
} from '../src/codearts-window.ts'

/** The margin `open()` adds so a request never lands a few milliseconds early. */
const MARGIN_MS = 1_500

describe('CodeArts session window', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('hands out the three slots the plan allows without waiting', async () => {
    const window = new CodeArtsSessionWindow()
    for (let i = 0; i < CODEARTS_SESSION_LIMIT; i++) await window.open()
    expect(window.size).toBe(CODEARTS_SESSION_LIMIT)
    // Full, but the oldest start is still a whole window old.
    expect(window.waitMs()).toBe(CODEARTS_SESSION_WINDOW_MS)
  })

  it('holds the fourth caller until the oldest start ages out', async () => {
    const window = new CodeArtsSessionWindow()
    for (let i = 0; i < CODEARTS_SESSION_LIMIT; i++) await window.open()

    let opened = false
    const fourth = window.open().then(() => {
      opened = true
    })
    await vi.advanceTimersByTimeAsync(CODEARTS_SESSION_WINDOW_MS - 1)
    expect(opened).toBe(false)
    await vi.advanceTimersByTimeAsync(MARGIN_MS + 1)
    await fourth
    expect(opened).toBe(true)
    // The three old starts aged out, so only the new one is counted.
    expect(window.size).toBe(1)
  })

  it('serialises a burst so five callers end up as two windows, not five rejections', async () => {
    const window = new CodeArtsSessionWindow()
    const opened: number[] = []
    const burst = Array.from({ length: 5 }, (_, index) => window.open().then(() => {
      opened.push(index)
    }))

    await vi.advanceTimersByTimeAsync(0)
    expect(opened).toEqual([0, 1, 2])

    await vi.advanceTimersByTimeAsync(CODEARTS_SESSION_WINDOW_MS + MARGIN_MS)
    await Promise.all(burst)
    expect(opened).toEqual([0, 1, 2, 3, 4])
    expect(window.size).toBe(2)
  })

  it('reports a shrinking wait as the window rolls', async () => {
    const window = new CodeArtsSessionWindow()
    for (let i = 0; i < CODEARTS_SESSION_LIMIT; i++) await window.open()

    await vi.advanceTimersByTimeAsync(20_000)
    expect(window.waitMs()).toBe(CODEARTS_SESSION_WINDOW_MS - 20_000)
    await vi.advanceTimersByTimeAsync(40_000)
    expect(window.waitMs()).toBe(0)
  })

  it('lets an aborted waiter fail without poisoning the queue', async () => {
    const window = new CodeArtsSessionWindow()
    for (let i = 0; i < CODEARTS_SESSION_LIMIT; i++) await window.open()

    const controller = new AbortController()
    const aborted = window.open(controller.signal)
    controller.abort(new Error('stop'))
    await expect(aborted).rejects.toThrow('stop')

    // The next caller still waits for a slot instead of inheriting the failure.
    let opened = false
    const next = window.open().then(() => {
      opened = true
    })
    await vi.advanceTimersByTimeAsync(CODEARTS_SESSION_WINDOW_MS + MARGIN_MS)
    await next
    expect(opened).toBe(true)
  })

  it('forgets every start on reset', async () => {
    const window = new CodeArtsSessionWindow()
    for (let i = 0; i < CODEARTS_SESSION_LIMIT; i++) await window.open()
    window.reset()
    expect(window.size).toBe(0)
    expect(window.waitMs()).toBe(0)
    await window.open()
  })

  it('gives a refused slot back instead of spending the minute on it', async () => {
    const window = new CodeArtsSessionWindow()
    for (let i = 0; i < CODEARTS_SESSION_LIMIT; i++) await window.open()
    expect(window.size).toBe(CODEARTS_SESSION_LIMIT)

    const slot = await (async () => {
      const pending = window.open()
      await vi.advanceTimersByTimeAsync(CODEARTS_SESSION_WINDOW_MS + MARGIN_MS)
      return await pending
    })()
    expect(window.size).toBe(1)

    // The gateway answered `TM.00001041`: it never counted this start, so the
    // caller must not hold a slot the next turn needs.
    slot.release()
    expect(window.size).toBe(0)
    expect(window.waitMs()).toBe(0)
  })

  it('shares one window per process so a reload cannot reset the count', () => {
    expect(sharedSessionWindow()).toBe(sharedSessionWindow())
  })
})
