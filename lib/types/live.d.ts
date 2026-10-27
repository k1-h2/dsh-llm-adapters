/**
 * A configuration value read at each use: a plain value or a thunk.
 *
 * Every field of this plugin is `.volatile()`, so the loader commits a settings
 * edit into the running plugin instead of re-running `apply()`. Reading a field
 * once at mount would therefore freeze it for the process lifetime.
 *
 * @module dsh-llm-adapters/live
 */
export type Live<T> = T | (() => T);
export declare function readLive<T>(value: Live<T> | undefined, fallback: T): T;
export declare function readLiveOptional<T>(value: Live<T | undefined> | undefined): T | undefined;
