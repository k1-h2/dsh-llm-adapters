/**
 * The trial plan's chat budget.
 *
 * The gateway opens one "session" per chat request and allows **three per
 * rolling minute** for the whole account. The window is shared by every model,
 * it is not keyed by `session-id` (re-sending the same id does not buy a slot),
 * and a request rejected with `InferHub.4004.200` spends a slot just like a
 * successful one. Measured behaviour, three slots then a lockout:
 *
 * ```
 * t+0s   ok ok ok cap cap cap     burst of six
 * t+10s  cap                      …
 * t+51s  cap
 * t+61s  ok ok ok                 the burst ages out of the window
 * ```
 *
 * So a turn cannot be made to "go faster" by retrying: the only way a request
 * stops failing is to spend the budget deliberately — wait for the oldest start
 * to age out instead of firing into a wall. This class owns that bookkeeping and
 * is shared by every provider instance in the process, because a hot reload
 * must not reset the count the gateway still remembers.
 *
 * @module dsh-llm-adapters/codearts-window
 */

/** Sessions the trial plan allows inside one window. */
export const CODEARTS_SESSION_LIMIT = 3

/** How long a start keeps its slot. Measured: the burst frees at ~60 s. */
export const CODEARTS_SESSION_WINDOW_MS = 60_000

/** A little slack so a request never lands a few milliseconds early. */
const MARGIN_MS = 1_500

/** The claim a caller holds while its request is in flight. */
export interface CodeArtsSessionSlot {
  /**
   * Give the slot back.
   *
   * The gateway does not charge for a call it turned away: a burst rejected
   * with `TM.00001041` at t+0 s lifts at the same moment as one that was never
   * sent. Keeping the slot after a refusal would therefore throttle the next
   * minute to one request per twenty seconds for no reason.
   */
  release(): void
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal?.reason instanceof Error ? signal.reason : new Error('aborted'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export class CodeArtsSessionWindow {
  private readonly starts: number[] = []
  /** Serialises waiters so two callers cannot both take the last slot. */
  private tail: Promise<void> = Promise.resolve()

  constructor(
    private readonly limit: number = CODEARTS_SESSION_LIMIT,
    private readonly windowMs: number = CODEARTS_SESSION_WINDOW_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /** Starts recorded inside the current window. */
  get size(): number {
    this.trim()
    return this.starts.length
  }

  /** Milliseconds until another start fits; `0` when the window has room. */
  waitMs(): number {
    this.trim()
    if (this.starts.length < this.limit) return 0
    const oldest = this.starts[0] ?? 0
    return Math.max(0, this.windowMs - (this.now() - oldest))
  }

  /**
   * Claim a slot, waiting for the window to roll over when it is full.
   *
   * The slot is recorded on return, not on completion: the gateway counts the
   * start, and holds it for a fixed time whether the answer was short or long.
   */
  async open(signal?: AbortSignal): Promise<CodeArtsSessionSlot> {
    const run = this.tail.then(async (): Promise<CodeArtsSessionSlot> => {
      for (;;) {
        const wait = this.waitMs()
        if (wait === 0) {
          const start = this.now()
          this.starts.push(start)
          return {
            release: () => {
              const index = this.starts.indexOf(start)
              if (index >= 0) this.starts.splice(index, 1)
            },
          }
        }
        await sleep(wait + MARGIN_MS, signal)
      }
    })
    // A failed waiter must not poison the queue for the next one.
    this.tail = run.then(() => undefined, () => undefined)
    return await run
  }

  /** Forget every start (tests, and a fresh login on another account). */
  reset(): void {
    this.starts.length = 0
  }

  private trim(): void {
    const now = this.now()
    while (this.starts.length > 0 && now - (this.starts[0] ?? 0) >= this.windowMs) this.starts.shift()
  }
}

let shared: CodeArtsSessionWindow | undefined

/** The process-wide window; a plugin reload reuses it on purpose. */
export function sharedSessionWindow(): CodeArtsSessionWindow {
  shared ??= new CodeArtsSessionWindow()
  return shared
}
