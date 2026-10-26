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

import { attributionHeaders, offloadedImageText, requestImageHandleText } from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock, GenerateOptions, StreamChunk, ToolCallId,
} from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'

/**
 * Read one durable image occurrence into the bytes a request sends.
 *
 * `path` is the normalized copy in the host tools' execution world. Pixels let
 * the model look at the image; this path is what a "edit and save it" turn
 * needs, because otherwise the model goes hunting through the workspace for a
 * file that was never there.
 */
export type ReadImage = (ref: ImageAttachmentRef, signal?: AbortSignal) => Promise<{
  data: Uint8Array
  mediaType: string
  path?: string
} | undefined>

/**
 * Model-facing handle for one image.
 *
 * The harness's own adapters append exactly this text — attachment identity,
 * pixel size, the read-only normalized copy on disk, and the instruction to
 * copy it to a writable path before editing. Reusing the helper keeps the
 * wording (and therefore the model's behaviour) identical across routes.
 */
export function imageRefText(ref: ImageAttachmentRef, path: string | undefined): string {
  if (path === undefined) {
    return `[图片附件 ${String(ref.attachmentId)}（${ref.width}×${ref.height}px，${ref.mediaType}）]`
  }
  return requestImageHandleText(ref, { width: ref.width, height: ref.height }, { readonlyPath: path })
}

export class ProviderHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'ProviderHttpError'
  }
}

/** A small, bounded body read used for error diagnostics. */
async function errorMessage(response: Response): Promise<string> {
  const text = await response.text().catch(() => '')
  if (text === '') return `HTTP ${response.status}`
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed !== null && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>
      const nested = record.error
      if (typeof nested === 'string' && nested.length > 0) return nested
      if (nested !== null && typeof nested === 'object') {
        const message = (nested as Record<string, unknown>).message
        if (typeof message === 'string' && message.length > 0) return message
      }
      if (typeof record.message === 'string' && record.message.length > 0) return record.message
      if (typeof record.error_description === 'string' && record.error_description.length > 0) return record.error_description
    }
  } catch {
    /* plain text body */
  }
  return text.slice(0, 400)
}

function textOf(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
}

function filePlaceholder(block: Extract<ContentBlock, { type: 'file' }>): string {
  return `[附件：${block.attachment.name}（${block.attachment.bytes} 字节）]`
}

async function userContent(blocks: readonly ContentBlock[], readImage: ReadImage | undefined, signal?: AbortSignal): Promise<string | Record<string, unknown>[]> {
  const parts: Record<string, unknown>[] = []
  let hasImage = false
  for (const block of blocks) {
    if (block.type === 'text') parts.push({ type: 'text', text: block.text })
    else if (block.type === 'image') {
      if (block.offloaded === true) {
        // Dropped to fit the request image limits: the harness's own handle
        // says so, and repeating the pixels is exactly what was avoided.
        parts.push({ type: 'text', text: offloadedImageText(block.attachment) })
        continue
      }
      if (readImage === undefined) {
        parts.push({ type: 'text', text: imageRefText(block.attachment, undefined) })
        continue
      }
      let image: Awaited<ReturnType<ReadImage>>
      try {
        image = await readImage(block.attachment, signal)
      } catch {
        image = undefined
      }
      if (image === undefined) {
        parts.push({ type: 'text', text: '[图片读取失败]' })
        continue
      }
      // Handle first, pixels second: the text names the file the model may
      // copy and edit, and the data URL lets it read the picture.
      parts.push({ type: 'text', text: imageRefText(block.attachment, image.path) })
      parts.push({
        type: 'image_url',
        image_url: { url: `data:${image.mediaType};base64,${Buffer.from(image.data).toString('base64')}` },
      })
      hasImage = true
    } else if (block.type === 'file') {
      parts.push({ type: 'text', text: filePlaceholder(block) })
    }
  }
  if (!hasImage) return parts.filter(part => part.type === 'text').map(part => String(part.text)).join('')
  return parts.filter(part => part.type === 'text' ? String(part.text).length > 0 : true)
}

/** One OpenAI wire message. Tool calls are kept at their raw JSON strings. */
export interface WireMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | Record<string, unknown>[]
  tool_calls?: { id: string, type: 'function', function: { name: string, arguments: string } }[]
  tool_call_id?: string
}

/**
 * Project the harness request onto OpenAI messages.
 *
 * Explanatory reasoning from earlier assistant turns is deliberately dropped:
 * providers either reject it or treat it as answer text on replay.
 */
export async function buildMessages(options: GenerateOptions, readImage?: ReadImage): Promise<WireMessage[]> {
  const out: WireMessage[] = []
  const system: string[] = []
  if (options.system !== undefined && options.system.trim().length > 0) system.push(options.system)

  for (const message of options.messages) {
    if (message.role === 'system') {
      const text = textOf(message.content)
      if (text.length > 0) system.push(text)
      continue
    }
    if (message.role === 'developer') {
      const text = textOf(message.content)
      if (text.length > 0) system.push(text)
      continue
    }
    if (message.role === 'user') {
      out.push({ role: 'user', content: await userContent(message.content, readImage, options.signal) })
      continue
    }
    if (message.role === 'tool') {
      out.push({
        role: 'tool',
        tool_call_id: String(message.toolCallId),
        content: textOf(message.content),
      })
      continue
    }
    const text = textOf(message.content)
    const toolCalls = message.content
      .filter((block): block is Extract<ContentBlock, { type: 'tool-call' }> => block.type === 'tool-call')
      .map(block => ({
        id: String(block.id),
        type: 'function' as const,
        function: { name: block.name, arguments: block.arguments === '' ? '{}' : block.arguments },
      }))
    out.push({
      role: 'assistant',
      content: text,
      ...toolCalls.length === 0 ? {} : { tool_calls: toolCalls },
    })
  }

  if (system.length > 0) out.unshift({ role: 'system', content: system.join('\n\n') })
  return out
}

export function buildTools(options: GenerateOptions): Record<string, unknown>[] | undefined {
  if (options.tools === undefined || options.tools.length === 0) return undefined
  return options.tools.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }))
}

/** Add generation controls without overwriting a provider-specific field. */
export function buildBody(options: GenerateOptions, model: string, messages: WireMessage[], tools: Record<string, unknown>[] | undefined): Record<string, unknown> {
  return {
    model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...options.maxTokens === undefined ? {} : { max_tokens: Math.floor(options.maxTokens) },
    ...options.temperature === undefined ? {} : { temperature: options.temperature },
    ...options.stop === undefined || options.stop.length === 0 ? {} : { stop: options.stop },
    ...tools === undefined ? {} : { tools, tool_choice: 'auto' },
  }
}

interface SseEvent {
  data: string
}

/** Split a byte stream into SSE data payloads, tolerating CRLF and comments. */
export async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let match = /\r\n\r\n|\n\n|\r\r/.exec(buffer)
      while (match !== null) {
        const block = buffer.slice(0, match.index)
        buffer = buffer.slice(match.index + match[0].length)
        const data = block
          .split(/\r\n|\n|\r/)
          .filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).replace(/^ /, ''))
          .join('\n')
        if (data.length > 0) yield { data }
        match = /\r\n\r\n|\n\n|\r\r/.exec(buffer)
      }
    }
    buffer += decoder.decode()
    for (const block of buffer.split(/\r\n\r\n|\n\n|\r\r/)) {
      const data = block
        .split(/\r\n|\n|\r/)
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).replace(/^ /, ''))
        .join('\n')
      if (data.length > 0) yield { data }
    }
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

interface ToolAccumulator {
  id?: string
  name?: string
  arguments: string
}

interface CompletionUsage {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number }
  completion_tokens_details?: { reasoning_tokens?: number }
}

const int = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.ceil(value) : 0

function usageOf(usage: CompletionUsage | undefined): StreamChunk | undefined {
  if (usage === undefined) return undefined
  const prompt = int(usage.prompt_tokens)
  const completion = int(usage.completion_tokens)
  const cached = int(usage.prompt_tokens_details?.cached_tokens)
  const reasoning = Math.min(int(usage.completion_tokens_details?.reasoning_tokens), completion)
  const input = Math.max(0, prompt - cached)
  const total = int(usage.total_tokens) || input + cached + completion
  if (prompt === 0 && completion === 0) return undefined
  return {
    type: 'usage',
    usage: {
      inputTokens: input,
      outputTokens: completion,
      totalTokens: total,
      ...cached === 0 ? {} : { cacheReadTokens: cached },
      ...reasoning === 0 ? {} : { reasoningTokens: reasoning },
    },
  }
}

/** A finish reason mapper for the two compatible gateways. */
export function finishReason(raw: string | null | undefined): 'stop' | 'tool-calls' | 'max-tokens' | undefined {
  if (raw === 'stop' || raw === 'end_turn') return 'stop'
  if (raw === 'tool_calls' || raw === 'function_call') return 'tool-calls'
  if (raw === 'length' || raw === 'max_tokens' || raw === 'max_output_tokens') return 'max-tokens'
  return undefined
}

interface DeltaFrame {
  choices?: { delta?: Record<string, unknown>, finish_reason?: string | null }[]
  usage?: CompletionUsage
  error?: unknown
}

function deltaText(delta: Record<string, unknown>): string {
  for (const key of ['content', 'text']) {
    if (typeof delta[key] === 'string') return delta[key] as string
  }
  return ''
}

function deltaReasoning(delta: Record<string, unknown>): string {
  for (const key of ['reasoning_content', 'reasoning', 'reasoning_text']) {
    if (typeof delta[key] === 'string') return delta[key] as string
  }
  return ''
}

function toolDeltas(delta: Record<string, unknown>): { index: number, id?: string, name?: string, arguments: string }[] {
  if (!Array.isArray(delta.tool_calls)) return []
  const out: { index: number, id?: string, name?: string, arguments: string }[] = []
  for (const entry of delta.tool_calls) {
    if (entry === null || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    const fn = record.function !== null && typeof record.function === 'object'
      ? record.function as Record<string, unknown>
      : {}
    out.push({
      index: typeof record.index === 'number' ? record.index : 0,
      ...typeof record.id === 'string' && record.id.length > 0 ? { id: record.id } : {},
      ...typeof fn.name === 'string' && fn.name.length > 0 ? { name: fn.name } : {},
      arguments: typeof fn.arguments === 'string' ? fn.arguments : '',
    })
  }
  return out
}

/**
 * Consume one OpenAI-compatible streaming response.
 *
 * Text and reasoning are emitted as they arrive. Tool-call fragments are
 * buffered until the stream ends because the harness requires a stable call id
 * on every delta; emitting fragments with placeholder ids would disconnect
 * them from the matching tool result.
 */
export async function* openAiStream(options: {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
  signal?: AbortSignal
  fetchImpl?: typeof fetch
  onUnauthorized?: () => void
  onFrame?: (frame: Record<string, unknown>) => void
}): AsyncGenerator<StreamChunk> {
  const response = await (options.fetchImpl ?? fetch)(options.url, {
    method: 'POST',
    headers: { ...attributionHeaders(), accept: 'text/event-stream', 'content-type': 'application/json', ...options.headers },
    body: JSON.stringify(options.body),
    signal: options.signal,
  })
  if (!response.ok) {
    const message = await errorMessage(response)
    if (response.status === 401 || response.status === 403) options.onUnauthorized?.()
    throw new ProviderHttpError(message, response.status)
  }
  if (response.body === null) throw new ProviderHttpError('上游没有返回响应体', 502)

  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.includes('text/event-stream')) {
    yield* nonStreaming(response, options.signal)
    return
  }

  yield* consumeOpenAiStream(response, {
    ...options.signal === undefined ? {} : { signal: options.signal },
    ...options.onFrame === undefined ? {} : { onFrame: options.onFrame },
  })
}

/** Per-frame hook; a throw aborts the stream (used for in-band error frames). */
export interface ConsumeOptions {
  signal?: AbortSignal
  onFrame?: (frame: Record<string, unknown>) => void
}

/**
 * Turn an already-open OpenAI-compatible SSE response into harness chunks.
 *
 * Split out from {@link openAiStream} so a gateway that has to sign the exact
 * request body (CodeArts) can do its own fetch and still reuse the frame
 * handling. `onFrame` sees every parsed frame before it is interpreted, which
 * is how a gateway that reports errors inside a 200 stream is caught.
 */
export async function* consumeOpenAiStream(
  response: Response,
  options: ConsumeOptions = {},
): AsyncGenerator<StreamChunk> {
  if (response.body === null) throw new ProviderHttpError('上游没有返回响应体', 502)
  let nextIndex = 0
  let current: { kind: 'text' | 'reasoning', index: number, text: string } | undefined
  const tools = new Map<number, ToolAccumulator>()
  let finish: string | null | undefined
  let usage: StreamChunk | undefined
  let sawDone = false
  let sawContent = false

  const start = (kind: 'text' | 'reasoning'): StreamChunk => {
    current = { kind, index: nextIndex++, text: '' }
    return { type: 'block-start', index: current.index, blockType: kind }
  }
  const close = (): StreamChunk | undefined => {
    if (current === undefined) return undefined
    const block: ContentBlock = current.kind === 'text'
      ? { type: 'text', text: current.text }
      : { type: 'reasoning', text: current.text }
    const chunk: StreamChunk = { type: 'block-end', index: current.index, block }
    current = undefined
    return chunk
  }

  for await (const event of sseEvents(response.body)) {
    if (event.data.trim() === '[DONE]') {
      sawDone = true
      break
    }
    let frame: DeltaFrame
    try {
      frame = JSON.parse(event.data) as DeltaFrame
    } catch {
      continue
    }
    options.onFrame?.(frame as unknown as Record<string, unknown>)
    if (frame.error !== undefined) {
      const message = typeof frame.error === 'string'
        ? frame.error
        : typeof frame.error === 'object' && frame.error !== null
          ? String((frame.error as Record<string, unknown>).message ?? '上游返回错误')
          : '上游返回错误'
      throw new ProviderHttpError(message, 502)
    }
    usage = usageOf(frame.usage) ?? usage
    const choice = frame.choices?.[0]
    if (choice === undefined) continue
    const delta = choice.delta ?? {}
    const reasoning = deltaReasoning(delta)
    if (reasoning.length > 0) {
      if (current?.kind !== 'reasoning') {
        const ended = close()
        if (ended !== undefined) yield ended
        yield start('reasoning')
      }
      current!.text += reasoning
      sawContent = true
      yield { type: 'reasoning-delta', index: current!.index, text: reasoning }
    }
    const text = deltaText(delta)
    if (text.length > 0) {
      if (current?.kind !== 'text') {
        const ended = close()
        if (ended !== undefined) yield ended
        yield start('text')
      }
      current!.text += text
      sawContent = true
      yield { type: 'text-delta', index: current!.index, text }
    }
    for (const tool of toolDeltas(delta)) {
      const held = tools.get(tool.index) ?? { arguments: '' }
      if (tool.id !== undefined) held.id = tool.id
      if (tool.name !== undefined) held.name = (held.name ?? '') + tool.name
      held.arguments += tool.arguments
      tools.set(tool.index, held)
      sawContent = true
    }
    if (choice.finish_reason !== undefined) finish = choice.finish_reason
  }

  const ended = close()
  if (ended !== undefined) yield ended

  let toolCalls = 0
  for (const [index, tool] of [...tools.entries()].sort((a, b) => a[0] - b[0])) {
    const callId = (tool.id ?? `call_${crypto.randomUUID()}`) as ToolCallId
    const name = tool.name ?? 'unknown_tool'
    const args = tool.arguments === '' ? '{}' : tool.arguments
    const blockIndex = nextIndex++
    yield { type: 'block-start', index: blockIndex, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: blockIndex, id: callId, name, argumentsDelta: args }
    yield {
      type: 'block-end',
      index: blockIndex,
      block: { type: 'tool-call', id: callId, name, arguments: args },
    }
    toolCalls++
  }

  if (usage !== undefined) yield usage

  let reason = finishReason(finish)
  if (reason === undefined && toolCalls > 0) reason = 'tool-calls'
  // A bare [DONE] without finish_reason is how Loomy truncates. Reporting
  // `max-tokens` makes that visible in the durable transcript instead of
  // silently presenting a partial answer as complete.
  if (reason === undefined && sawDone) reason = sawContent ? 'max-tokens' : 'stop'
  if (reason === undefined) reason = 'stop'
  yield { type: 'finish', reason: { kind: reason } }
}


/** Non-streaming fallback for a gateway that ignores `stream: true`. */
async function* nonStreaming(response: Response, signal?: AbortSignal): AsyncGenerator<StreamChunk> {
  const payload = await response.json() as {
    choices?: { message?: Record<string, unknown>, finish_reason?: string }[]
    usage?: CompletionUsage
  }
  if (signal?.aborted === true) throw new DOMException('aborted', 'AbortError')
  const message = payload.choices?.[0]?.message ?? {}
  const reasoning = typeof message.reasoning_content === 'string'
    ? message.reasoning_content
    : typeof message.reasoning === 'string' ? message.reasoning : ''
  let index = 0
  if (reasoning.length > 0) {
    yield { type: 'block-start', index, blockType: 'reasoning' }
    yield { type: 'reasoning-delta', index, text: reasoning }
    yield { type: 'block-end', index, block: { type: 'reasoning', text: reasoning } }
    index++
  }
  const text = typeof message.content === 'string' ? message.content : ''
  if (text.length > 0) {
    yield { type: 'block-start', index, blockType: 'text' }
    yield { type: 'text-delta', index, text }
    yield { type: 'block-end', index, block: { type: 'text', text } }
    index++
  }
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : []
  for (const raw of toolCalls) {
    if (raw === null || typeof raw !== 'object') continue
    const record = raw as Record<string, unknown>
    const fn = record.function !== null && typeof record.function === 'object'
      ? record.function as Record<string, unknown>
      : {}
    const callId = (typeof record.id === 'string' ? record.id : `call_${crypto.randomUUID()}`) as ToolCallId
    const name = typeof fn.name === 'string' ? fn.name : 'unknown_tool'
    const args = typeof fn.arguments === 'string' ? fn.arguments : '{}'
    yield { type: 'block-start', index, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index, id: callId, name, argumentsDelta: args }
    yield { type: 'block-end', index, block: { type: 'tool-call', id: callId, name, arguments: args } }
    index++
  }
  const usage = usageOf(payload.usage)
  if (usage !== undefined) yield usage
  const reason = finishReason(payload.choices?.[0]?.finish_reason) ?? (toolCalls.length > 0 ? 'tool-calls' : 'stop')
  yield { type: 'finish', reason: { kind: reason } }
}
