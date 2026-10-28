import { describe, expect, it, vi } from 'vitest'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import {
  ProviderHttpError, buildMessages, openAiStream, sseEvents,
} from '../src/wire.ts'

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const chunk of stream) out.push(chunk)
  return out
}

function sseResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

const baseOptions: GenerateOptions = {
  provider: 'loomy',
  model: 'spark-x',
  messages: [
    {
      role: 'system',
      id: 'sys' as never,
      source: { kind: 'system-prompt' },
      content: [{ type: 'text', text: 'be brief' }],
    },
    {
      role: 'user',
      id: 'u1' as never,
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'hello' }],
    },
  ],
}

describe('buildMessages', () => {
  it('combines system prompts and maps user text', async () => {
    const messages = await buildMessages({ ...baseOptions, system: 'global rule' })
    expect(messages).toEqual([
      { role: 'system', content: 'global rule\n\nbe brief' },
      { role: 'user', content: 'hello' },
    ])
  })

  it('maps images to data URLs and files to text handles', async () => {
    const messages = await buildMessages({
      ...baseOptions,
      system: undefined,
      messages: [
        {
          role: 'user',
          id: 'u2' as never,
          source: { kind: 'user' },
          content: [
            { type: 'text', text: 'look' },
            {
              type: 'image',
              attachment: { attachmentId: 'a', mediaType: 'image/png', bytes: 3, width: 1, height: 1 },
            },
            {
              type: 'file',
              attachment: { attachmentId: 'f', name: 'a.txt', bytes: 5 },
            },
          ],
        },
      ],
    }, async () => ({ data: new Uint8Array([1, 2, 3]), mediaType: 'image/png' }))
    const content = messages[0]!.content as Record<string, unknown>[]
    expect(content[0]).toEqual({ type: 'text', text: 'look' })
    // The handle names the attachment even when the route cannot say where the
    // file lives; it sits before the pixels.
    expect(content[1]).toEqual({ type: 'text', text: '[图片附件 a（1×1px，image/png）]' })
    expect(content[2]).toEqual({
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,AQID' },
    })
    expect(content[3]).toEqual({ type: 'text', text: '[附件：a.txt（5 字节）]' })
  })

  it('puts the read-only path in front of the pixels', async () => {
    // Reading an image needs pixels; editing one needs a file path. Without
    // this path the model answered "图片没有保存在工作目录中" and went looking
    // through the workspace for a file that never existed.
    const path = 'C:\\\\Users\\\\tester\\\\.dsh\\\\attachments\\\\v1\\\\objects\\\\ab\\\\abcd.png'
    const messages = await buildMessages({
      ...baseOptions,
      system: undefined,
      messages: [{
        role: 'user',
        id: 'u3' as never,
        source: { kind: 'user' },
        content: [{
          type: 'image',
          attachment: { attachmentId: 'sha256:abcd', mediaType: 'image/png', bytes: 3, width: 492, height: 150, name: 'shot.png' },
        }],
      }],
    }, async () => ({ data: new Uint8Array([1, 2, 3]), mediaType: 'image/png', path }))

    const content = messages[0]!.content as Record<string, unknown>[]
    const handle = String((content[0] as { text: string }).text)
    expect(handle).toContain(JSON.stringify(path))
    expect(handle).toContain('492x150px')
    expect(handle).toContain('Copy to a writable path ending in .png before editing')
    expect(content[1]).toMatchObject({ type: 'image_url' })
  })

  it('keeps the offload wording for an image the harness already dropped', async () => {
    const messages = await buildMessages({
      ...baseOptions,
      system: undefined,
      messages: [{
        role: 'user',
        id: 'u4' as never,
        source: { kind: 'user' },
        content: [{
          type: 'image',
          offloaded: true,
          attachment: { attachmentId: 'sha256:ef01', mediaType: 'image/jpeg', bytes: 3, width: 10, height: 10 },
        }],
      }],
    }, async () => {
      throw new Error('offloaded images must not be read again')
    })

    const content = messages[0]!.content as string
    expect(content).toContain('image omitted to fit request image limits')
    expect(content).toContain('sha256:ef01')
  })

  it('maps assistant tool calls and tool results', async () => {
    const messages = await buildMessages({
      ...baseOptions,
      system: undefined,
      messages: [
        {
          role: 'assistant',
          id: 'a1' as never,
          source: { kind: 'model', provider: 'x', model: 'm' },
          content: [
            { type: 'reasoning', text: 'secret' },
            { type: 'text', text: 'calling' },
            { type: 'tool-call', id: 'c1' as never, name: 'read', arguments: '{"path":"x"}' },
          ],
        },
        {
          role: 'tool',
          id: 't1' as never,
          source: { kind: 'tool', callId: 'c1' as never },
          toolCallId: 'c1' as never,
          content: [{ type: 'text', text: 'ok' }],
        },
      ],
    })
    expect(messages).toEqual([
      {
        role: 'assistant',
        content: 'calling',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{"path":"x"}' } }],
      },
      { role: 'tool', tool_call_id: 'c1', content: 'ok' },
    ])
  })
})

describe('sseEvents', () => {
  it('handles a CRLF delimiter split across chunks', async () => {
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: a\r'))
        controller.enqueue(encoder.encode('\n\r'))
        controller.enqueue(encoder.encode('\ndata: b\r\n\r\n'))
        controller.close()
      },
    })
    const events: string[] = []
    for await (const event of sseEvents(stream)) events.push(event.data)
    expect(events).toEqual(['a', 'b'])
  })
})

describe('openAiStream', () => {
  it('emits reasoning then text, usage, and a mapped finish', async () => {
    const body = [
      'data: {"choices":[{"delta":{"role":"assistant","reasoning_content":"think"},"finish_reason":null}]}',
      '',
      'data: {"choices":[{"delta":{"content":"Hi"}}]}',
      '',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":100,"completion_tokens":5,"total_tokens":105,"prompt_tokens_details":{"cached_tokens":40},"completion_tokens_details":{"reasoning_tokens":2}}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n')
    const chunks = await collect(openAiStream({
      url: 'https://example.test/chat',
      headers: {},
      body: {},
      fetchImpl: vi.fn(async () => sseResponse(body)) as unknown as typeof fetch,
    }))
    expect(chunks.filter(chunk => chunk.type === 'block-start')).toEqual([
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'block-start', index: 1, blockType: 'text' },
    ])
    expect(chunks.find(chunk => chunk.type === 'block-end' && chunk.index === 0)).toEqual({
      type: 'block-end', index: 0, block: { type: 'reasoning', text: 'think' },
    })
    expect(chunks.find(chunk => chunk.type === 'block-end' && chunk.index === 1)).toEqual({
      type: 'block-end', index: 1, block: { type: 'text', text: 'Hi' },
    })
    expect(chunks.find(chunk => chunk.type === 'usage')).toEqual({
      type: 'usage',
      usage: {
        inputTokens: 60,
        outputTokens: 5,
        totalTokens: 105,
        cacheReadTokens: 40,
        reasoningTokens: 2,
      },
    })
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('tolerates the null usage frames OpenAI-style gateways send', async () => {
    const body = [
      'data: {"choices":[{"delta":{"content":"Hi"}}],"usage":null}',
      '',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n')
    const chunks = await collect(openAiStream({
      url: 'https://example.test/chat',
      headers: {},
      body: {},
      fetchImpl: vi.fn(async () => sseResponse(body)) as unknown as typeof fetch,
    }))
    expect(chunks.find(chunk => chunk.type === 'text-delta')).toEqual({
      type: 'text-delta', index: 0, text: 'Hi',
    })
    expect(chunks.find(chunk => chunk.type === 'usage')).toMatchObject({
      usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
    })
  })

  it('assembles fragmented tool calls and reports tool-calls', async () => {
    const body = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read","arguments":"{\\"pa"}}]}}]}',
      '',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\\":\\"x\\"}"}}]}}]}',
      '',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n')
    const chunks = await collect(openAiStream({
      url: 'https://example.test/chat',
      headers: {},
      body: {},
      fetchImpl: vi.fn(async () => sseResponse(body)) as unknown as typeof fetch,
    }))
    expect(chunks.find(chunk => chunk.type === 'block-end')).toEqual({
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id: 'call_1', name: 'read', arguments: '{"path":"x"}' },
    })
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
  })

  it('reports a bare [DONE] after content as max-tokens instead of silently stopping', async () => {
    const body = [
      'data: {"choices":[{"delta":{"content":"partial"}}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n')
    const chunks = await collect(openAiStream({
      url: 'https://example.test/chat',
      headers: {},
      body: {},
      fetchImpl: vi.fn(async () => sseResponse(body)) as unknown as typeof fetch,
    }))
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'max-tokens' } })
  })

  it('falls back to a JSON completion when the gateway ignores stream=true', async () => {
    const response = new Response(JSON.stringify({
      choices: [{
        message: { content: 'hello', reasoning_content: 'why' },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 10, completion_tokens: 2 },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
    const chunks = await collect(openAiStream({
      url: 'https://example.test/chat',
      headers: {},
      body: {},
      fetchImpl: vi.fn(async () => response) as unknown as typeof fetch,
    }))
    expect(chunks.filter(chunk => chunk.type === 'block-start')).toHaveLength(2)
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('surfaces auth failures and invokes the invalidation callback', async () => {
    const onUnauthorized = vi.fn()
    const errors: unknown[] = []
    try {
      await collect(openAiStream({
        url: 'https://example.test/chat',
        headers: {},
        body: {},
        onUnauthorized,
        fetchImpl: vi.fn(async () => new Response('{"error":{"message":"bad token"}}', {
          status: 401,
          headers: { 'content-type': 'application/json' },
        })) as unknown as typeof fetch,
      }))
    } catch (error) {
      errors.push(error)
    }
    expect(errors[0]).toBeInstanceOf(ProviderHttpError)
    expect((errors[0] as Error).message).toBe('bad token')
    expect(onUnauthorized).toHaveBeenCalledOnce()
  })
})
