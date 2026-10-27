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
export declare const CODEARTS_SESSION_LIMIT = 3;
/** How long a start keeps its slot. Measured: the burst frees at ~60 s. */
export declare const CODEARTS_SESSION_WINDOW_MS = 60000;
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
    release(): void;
}
export declare class CodeArtsSessionWindow {
    private readonly limit;
    private readonly windowMs;
    private readonly now;
    private readonly starts;
    /** Serialises waiters so two callers cannot both take the last slot. */
    private tail;
    constructor(limit?: number, windowMs?: number, now?: () => number);
    /** Starts recorded inside the current window. */
    get size(): number;
    /** Milliseconds until another start fits; `0` when the window has room. */
    waitMs(): number;
    /**
     * Claim a slot, waiting for the window to roll over when it is full.
     *
     * The slot is recorded on return, not on completion: the gateway counts the
     * start, and holds it for a fixed time whether the answer was short or long.
     */
    open(signal?: AbortSignal): Promise<CodeArtsSessionSlot>;
    /** Forget every start (tests, and a fresh login on another account). */
    reset(): void;
    private trim;
}
/** The process-wide window; a plugin reload reuses it on purpose. */
export declare function sharedSessionWindow(): CodeArtsSessionWindow;
