import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentMessage, AgentToolCall } from '@genoffice/agent-core'
import { chatForProvider } from '../src/chat'
import { setOAuthCredentialResolver } from '../src/runtime-config'
import { streamForProvider } from '../src/stream'
import type { AiProviderConfig } from '../src/types'
import { AI_IDLE_TIMEOUT_MS, AiTimeoutError } from '../src/watchdog'
import { errorResponse, okResponse, sseStream } from './test-utils'

const config: AiProviderConfig = { apiKey: 'public-key', model: 'gpt-5.6', authMode: 'oauth' }
const completed = { type: 'response.completed', response: { status: 'completed' } }
const toolItem = {
  type: 'function_call',
  id: 'fc_item_1',
  call_id: 'call_1',
  name: 'read_cells',
  arguments: '{"range":"A1:B2"}',
  status: 'completed',
}

function response(...events: unknown[]): Response {
  return okResponse(sseStream(events.flatMap((event) => [`data: ${JSON.stringify(event)}`, ''])))
}

function collector(signal = new AbortController().signal) {
  const deltas: string[] = []
  const reasoning: string[] = []
  const toolCalls: AgentToolCall[] = []
  const stops: string[] = []
  const activity = vi.fn()
  return {
    deltas,
    reasoning,
    toolCalls,
    stops,
    cb: {
      signal,
      onDelta: (text: string) => {
        deltas.push(text)
      },
      onReasoningDelta: (text: string) => {
        reasoning.push(text)
      },
      onToolCall: (call: AgentToolCall) => {
        toolCalls.push(call)
      },
      onStopReason: (reason: string) => {
        stops.push(reason)
      },
      onActivity: activity,
    },
  }
}

beforeEach(() => {
  setOAuthCredentialResolver(async () => ({ accessToken: 'private-token', accountId: 'account-1' }))
})

afterEach(() => {
  setOAuthCredentialResolver(null)
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('ChatGPT native request routing', () => {
  it('uses the fixed endpoint and private account credentials with the supported Responses body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(completed))
    vi.stubGlobal('fetch', fetchMock)
    const untrustedConfig = {
      ...config,
      baseUrl: 'https://untrusted.example/v1',
      oauthAccountId: 'public-account',
      temperature: 1,
      previous_response_id: 'public-response',
    }
    await streamForProvider(
      'openai',
      untrustedConfig,
      'System instructions',
      [{ role: 'user', text: 'Hi' }],
      [{ name: 'read_cells', description: 'Read cells', inputSchema: { type: 'object' } }],
      1234,
      collector().cb,
    )

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://chatgpt.com/backend-api/codex/responses')
    expect(init.redirect).toBe('error')
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer private-token',
      'ChatGPT-Account-Id': 'account-1',
    })
    expect(JSON.parse(init.body as string)).toEqual({
      model: 'gpt-5.6',
      instructions: 'System instructions',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Hi' }] }],
      tools: [
        {
          type: 'function',
          name: 'read_cells',
          description: 'Read cells',
          parameters: { type: 'object' },
        },
      ],
      stream: true,
      store: false,
    })
  })

  it('collects one-shot text from SSE and omits the account header when unavailable', async () => {
    setOAuthCredentialResolver(async () => ({ accessToken: 'private-token' }))
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        response(
          { type: 'response.reasoning_summary_text.delta', delta: 'Thinking' },
          { type: 'response.output_text.delta', delta: 'Hello ' },
          { type: 'response.output_text.delta', delta: 'world' },
          completed,
        ),
      )
    vi.stubGlobal('fetch', fetchMock)
    expect(await chatForProvider('openai', config, 'sys', 'hi')).toEqual({
      ok: true,
      content: 'Hello world',
    })
    const init = fetchMock.mock.calls[0]![1] as RequestInit
    expect(init.headers).not.toHaveProperty('ChatGPT-Account-Id')
    expect(JSON.parse(init.body as string)).toMatchObject({ stream: true, store: false })
  })

  it('fails closed if credentials are unavailable or OAuth is requested on another provider', async () => {
    setOAuthCredentialResolver(null)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(
      streamForProvider('openai', config, '', [], [], 10, collector().cb),
    ).rejects.toThrow(/Sign in/)
    expect(await chatForProvider('openai', config, '', '')).toMatchObject({
      ok: false,
      error: expect.stringMatching(/Sign in/),
    })
    await expect(
      streamForProvider('custom', config, '', [], [], 10, collector().cb),
    ).rejects.toThrow(/not supported/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('keeps API-key OpenAI calls on their existing chat-completions route', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        okResponse(
          sseStream(['data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}']),
        ),
      )
    vi.stubGlobal('fetch', fetchMock)
    await streamForProvider(
      'openai',
      { ...config, authMode: 'api-key' },
      '',
      [],
      [],
      10,
      collector().cb,
    )
    expect(fetchMock.mock.calls[0]![0]).toBe('https://api.openai.com/v1/chat/completions')
    expect((fetchMock.mock.calls[0]![1] as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer public-key',
    })
  })
})

describe('ChatGPT streamed tool conversations', () => {
  it('emits each completed call once and replays its call_id alongside images and tool results', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        response(
          { type: 'response.reasoning_summary_text.delta', delta: 'Inspecting the sheet' },
          { type: 'response.output_text.delta', delta: 'I will inspect it.' },
          {
            type: 'response.output_item.added',
            output_index: 0,
            item: { ...toolItem, arguments: '', status: 'in_progress' },
          },
          {
            type: 'response.function_call_arguments.delta',
            item_id: 'fc_item_1',
            output_index: 0,
            delta: '{"range":',
          },
          {
            type: 'response.function_call_arguments.delta',
            item_id: 'fc_item_1',
            output_index: 0,
            delta: '"A1:B2"}',
          },
          {
            type: 'response.function_call_arguments.done',
            item_id: 'fc_item_1',
            output_index: 0,
            arguments: toolItem.arguments,
          },
          { type: 'response.output_item.done', output_index: 0, item: toolItem },
          { type: 'response.completed', response: { status: 'completed', output: [toolItem] } },
        ),
      )
      .mockResolvedValueOnce(
        response({ type: 'response.output_text.delta', delta: 'Done' }, completed),
      )
    vi.stubGlobal('fetch', fetchMock)
    const first = collector()
    await streamForProvider('openai', config, 'sys', [], [], 10, first.cb)
    expect(first.deltas).toEqual(['I will inspect it.'])
    expect(first.reasoning).toEqual(['Inspecting the sheet'])
    expect(first.cb.onActivity).toHaveBeenCalled()
    expect(first.toolCalls).toEqual([
      { id: 'call_1', name: 'read_cells', input: { range: 'A1:B2' }, inputError: undefined },
    ])

    const messages: AgentMessage[] = [
      { role: 'user', text: 'Inspect', images: [{ mime: 'image/png', base64: 'AQID' }] },
      {
        role: 'assistant',
        text: first.deltas.join(''),
        toolCalls: first.toolCalls,
        reasoning: 'Not replayed as raw reasoning',
      },
      { role: 'tool', results: [{ id: 'call_1', name: 'read_cells', output: '42' }] },
    ]
    await streamForProvider('openai', config, 'sys', messages, [], 10, collector().cb)
    expect(JSON.parse((fetchMock.mock.calls[1]![1] as RequestInit).body as string).input).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'Inspect' },
          { type: 'input_image', image_url: 'data:image/png;base64,AQID' },
        ],
      },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'I will inspect it.' }],
      },
      {
        type: 'function_call',
        call_id: 'call_1',
        name: 'read_cells',
        arguments: toolItem.arguments,
      },
      { type: 'function_call_output', call_id: 'call_1', output: '42' },
    ])
  })

  it('accepts complete function items without argument deltas', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          response({ type: 'response.output_item.done', item: toolItem }, completed),
        ),
    )
    const result = collector()
    await streamForProvider('openai', config, '', [], [], 10, result.cb)
    expect(result.toolCalls).toHaveLength(1)
    expect(result.toolCalls[0]).toMatchObject({ id: 'call_1', input: { range: 'A1:B2' } })
  })

  it.each(['{"range":', 'null', '[]'])(
    'marks invalid arguments for tool-error feedback: %s',
    async (args) => {
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValue(
            response(
              { type: 'response.output_item.done', item: { ...toolItem, arguments: args } },
              completed,
            ),
          ),
      )
      const result = collector()
      await streamForProvider('openai', config, '', [], [], 10, result.cb)
      expect(result.toolCalls[0]).toMatchObject({ input: {}, inputError: expect.any(String) })
    },
  )
})

describe('ChatGPT stream failure boundaries', () => {
  it.each([
    { type: 'response.failed', response: { error: { message: 'Service failure' } } },
    { type: 'error', message: 'Service failure' },
    { error: { message: 'Service failure' } },
    {
      type: 'response.incomplete',
      response: { incomplete_details: { reason: 'max_output_tokens' } },
    },
    { type: 'response.completed', response: { status: 'failed' } },
    { type: 'response.completed' },
    {
      type: 'response.completed',
      response: { status: 'completed', output: [{ ...toolItem, status: 'incomplete' }] },
    },
  ])('rejects %j without emitting completed tools', async (terminal) => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          response({ type: 'response.output_item.done', item: toolItem }, terminal),
        ),
    )
    const result = collector()
    await expect(streamForProvider('openai', config, '', [], [], 10, result.cb)).rejects.toThrow()
    expect(result.toolCalls).toEqual([])
  })

  it('does not treat text followed by EOF or a DONE marker as success', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        okResponse(
          sseStream([
            'data: {"type":"response.output_text.delta","delta":"Partial"}',
            '',
            'data: [DONE]',
            '',
          ]),
        ),
      )
    vi.stubGlobal('fetch', fetchMock)
    await expect(
      streamForProvider('openai', config, '', [], [], 10, collector().cb),
    ).rejects.toThrow(/before the response completed/)
    expect(await chatForProvider('openai', config, '', '')).toMatchObject({
      ok: false,
      error: expect.stringMatching(/before the response completed/),
    })
  })

  it('rejects malformed event JSON and unfinished function calls', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        okResponse(sseStream(['data: {"type":', '', `data: ${JSON.stringify(completed)}`, ''])),
      )
      .mockResolvedValueOnce(
        response({ type: 'response.output_item.added', item: toolItem }, completed),
      )
    vi.stubGlobal('fetch', fetchMock)
    await expect(
      streamForProvider('openai', config, '', [], [], 10, collector().cb),
    ).rejects.toThrow(/malformed/)
    await expect(
      streamForProvider('openai', config, '', [], [], 10, collector().cb),
    ).rejects.toThrow(/unfinished function call/)
  })

  it('reports HTTP errors in one-shot calls', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(errorResponse(401, 'Sign in again')))
    expect(await chatForProvider('openai', config, '', '')).toEqual({
      ok: false,
      error: 'ChatGPT HTTP 401: Sign in to ChatGPT again.',
    })
  })

  it('does not send a request after cancellation', async () => {
    const controller = new AbortController()
    controller.abort()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(
      streamForProvider('openai', config, '', [], [], 10, collector(controller.signal).cb),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([200, 401])(
    'cancels a pending HTTP %i body read and releases the stream',
    async (status) => {
      const controller = new AbortController()
      const cancel = vi.fn()
      const result = collector(controller.signal)
      let headersArrived!: () => void
      const ready = new Promise<void>((resolve) => {
        headersArrived = resolve
      })
      result.cb.onActivity = vi.fn(() => {
        headersArrived()
      })
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(new Response(new ReadableStream({ cancel }), { status })),
      )
      const request = streamForProvider('openai', config, '', [], [], 10, result.cb)
      const rejection = expect(request).rejects.toMatchObject({ name: 'AbortError' })
      await ready
      controller.abort()
      await rejection
      expect(cancel).toHaveBeenCalledOnce()
    },
  )

  it('times out a silent body using the shared idle watchdog', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse(new ReadableStream())))
    const request = streamForProvider('openai', config, '', [], [], 10, collector().cb)
    const rejection = expect(request).rejects.toBeInstanceOf(AiTimeoutError)
    await vi.advanceTimersByTimeAsync(AI_IDLE_TIMEOUT_MS + 1)
    await rejection
  })

  it('rejects a disconnected body even after partial text', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const body = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value
        value.enqueue(
          new TextEncoder().encode(
            'data: {"type":"response.output_text.delta","delta":"Partial"}\n\n',
          ),
        )
      },
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse(body)))
    const result = collector()
    result.cb.onDelta = (text) => {
      result.deltas.push(text)
      controller.error(new Error('Disconnected'))
    }
    await expect(streamForProvider('openai', config, '', [], [], 10, result.cb)).rejects.toThrow(
      'ChatGPT request failed. Please try again.',
    )
    expect(result.deltas).toEqual(['Partial'])
  })

  it('handles UTF-8 chunks, CRLF and multiline SSE data without requiring a final newline', async () => {
    const bytes = new TextEncoder().encode(
      'event: response.output_text.delta\r\ndata: {"type":"response.output_text.delta",\r\ndata: "delta":"안녕"}\r\n\r\n' +
        `data: ${JSON.stringify(completed)}`,
    )
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) controller.enqueue(new Uint8Array([byte]))
        controller.close()
      },
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse(body)))
    const result = collector()
    await streamForProvider('openai', config, '', [], [], 10, result.cb)
    expect(result.deltas).toEqual(['안녕'])
  })
})
