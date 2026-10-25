/**
 * A configuration value read at each use: a plain value or a thunk.
 *
 * Every field of this plugin is `.volatile()`, so the loader commits a settings
 * edit into the running plugin instead of re-running `apply()`. Reading a field
 * once at mount would therefore freeze it for the process lifetime.
 *
 * @module dsh-llm-adapters/live
 */

export type Live<T> = T | (() => T)

export function readLive<T>(value: Live<T> | undefined, fallback: T): T {
  const current = typeof value === 'function' ? (value as () => T)() : value
  return current === undefined ? fallback : current
}

export function readLiveOptional<T>(value: Live<T | undefined> | undefined): T | undefined {
  return typeof value === 'function' ? (value as () => T | undefined)() : value
}
