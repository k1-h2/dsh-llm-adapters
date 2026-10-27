/**
 * OpenAI Chat Completions transport shared by both providers.
 *
 * The harness vocabulary is richer than the wire format: durable images and
 * files, reasoning blocks, and tool calls arrive as structured content. This
 * module projects those to OpenAI messages and turns the SSE stream back into
 * the harness's block-oriented chunks.
 *
 * @module dsh-llm-adapters/wire
 */
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment';
/**
 * Read one durable image occurrence into the bytes a request sends.
 *
 * `path` is the normalized copy in the host tools' execution world. Pixels let
 * the model look at the image; this path is what a "edit and save it" turn
 * needs, because otherwise the model goes hunting through the workspace for a
 * file that was never there.
 */
export type ReadImage = (ref: ImageAttachmentRef, signal?: AbortSignal) => Promise<{
    data: Uint8Array;
    mediaType: string;
    path?: string;
} | undefined>;
/**
 * Model-facing handle for one image.
 *
 * The harness's own adapters append exactly this text — attachment identity,
 * pixel size, the read-only normalized copy on disk, and the instruction to
 * copy it to a writable path before editing. Reusing the helper keeps the
 * wording (and therefore the model's behaviour) identical across routes.
 */
export declare function imageRefText(ref: ImageAttachmentRef, path: string | undefined): string;
export declare class ProviderHttpError extends Error {
    readonly status: number;
    constructor(message: string, status: number);
}
/** One OpenAI wire message. Tool calls are kept at their raw JSON strings. */
export interface WireMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string | Record<string, unknown>[];
    tool_calls?: {
        id: string;
        type: 'function';
        function: {
            name: string;
            arguments: string;
        };
    }[];
    tool_call_id?: string;
}
/**
 * Project the harness request onto OpenAI messages.
 *
 * Explanatory reasoning from earlier assistant turns is deliberately dropped:
 * providers either reject it or treat it as answer text on replay.
 */
export declare function buildMessages(options: GenerateOptions, readImage?: ReadImage): Promise<WireMessage[]>;
export declare function buildTools(options: GenerateOptions): Record<string, unknown>[] | undefined;
/** Add generation controls without overwriting a provider-specific field. */
export declare function buildBody(options: GenerateOptions, model: string, messages: WireMessage[], tools: Record<string, unknown>[] | undefined): Record<string, unknown>;
interface SseEvent {
    data: string;
}
/** Split a byte stream into SSE data payloads, tolerating CRLF and comments. */
export declare function sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent>;
/** A finish reason mapper for the two compatible gateways. */
export declare function finishReason(raw: string | null | undefined): 'stop' | 'tool-calls' | 'max-tokens' | undefined;
/**
 * Consume one OpenAI-compatible streaming response.
 *
 * Text and reasoning are emitted as they arrive. Tool-call fragments are
 * buffered until the stream ends because the harness requires a stable call id
 * on every delta; emitting fragments with placeholder ids would disconnect
 * them from the matching tool result.
 */
export declare function openAiStream(options: {
    url: string;
    headers: Record<string, string>;
    body: Record<string, unknown>;
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
    onUnauthorized?: () => void;
    onFrame?: (frame: Record<string, unknown>) => void;
}): AsyncGenerator<StreamChunk>;
/** Per-frame hook; a throw aborts the stream (used for in-band error frames). */
export interface ConsumeOptions {
    signal?: AbortSignal;
    onFrame?: (frame: Record<string, unknown>) => void;
}
/**
 * Turn an already-open OpenAI-compatible SSE response into harness chunks.
 *
 * Split out from {@link openAiStream} so a gateway that has to sign the exact
 * request body (CodeArts) can do its own fetch and still reuse the frame
 * handling. `onFrame` sees every parsed frame before it is interpreted, which
 * is how a gateway that reports errors inside a 200 stream is caught.
 */
export declare function consumeOpenAiStream(response: Response, options?: ConsumeOptions): AsyncGenerator<StreamChunk>;
export {};
