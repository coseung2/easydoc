import type { AgentMessage, AgentToolCall, AgentToolDef } from '@genoffice/agent-core'
import { aiFetch } from '../fetch'
import { isAiNetworkError } from '../network-error'
import type { RuntimeAiConfig } from '../runtime-config'
import type { AiChatResponse } from '../types'
import { AiTimeoutError, createStreamWatchdog } from '../watchdog'
import { parseToolInput, sseLines, type StreamCallbacks } from './shared'

// ChatGPT credentials must never be sent to a caller-configured API endpoint.
const CODEX_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses'

/** Only locally selected messages may cross the OAuth transport boundary. */
class CodexResponseError extends Error {}

function publicServiceMessage(error: unknown, fallback: string): string {
  if (!error || typeof error !== 'object') return fallback
  const detail = error as { code?: unknown; type?: unknown }
  switch (detail.code ?? detail.type) {
    case 'authentication_error':
    case 'invalid_api_key':
    case 'token_expired':
      return 'Sign in to ChatGPT again.'
    case 'insufficient_quota':
    case 'usage_limit_reached':
      return 'Your ChatGPT usage limit has been reached. Please try again later.'
    case 'rate_limit_exceeded':
      return 'ChatGPT rate limit reached. Please try again later.'
    case 'model_not_found':
    case 'unsupported_model':
      return 'This model is unavailable for your ChatGPT account. Choose another model.'
    case 'server_error':
    case 'overloaded_error':
      return 'ChatGPT is temporarily overloaded. Please try again.'
    default:
      return fallback
  }
}

function publicHttpMessage(status: number, body: string): string {
  let detail: unknown
  try {
    const parsed = JSON.parse(body) as { error?: unknown } | null
    detail = parsed?.error ?? parsed
  } catch {
    // Error bodies may contain reflected credentials; never show their raw text.
  }
  const fallback =
    status === 401
      ? 'Sign in to ChatGPT again.'
      : status === 403
        ? 'ChatGPT denied this request. Check your account access.'
        : status === 429
          ? 'ChatGPT rate limit or usage limit reached. Please try again later.'
          : status >= 500
            ? 'ChatGPT is temporarily unavailable. Please try again.'
            : 'ChatGPT could not accept this request. Check the selected model and try again.'
  return `ChatGPT HTTP ${status}: ${publicServiceMessage(detail, fallback)}`
}

function redactCredentials(message: string, config: RuntimeAiConfig): string {
  for (const secret of [config.apiKey, config.oauthAccountId]) {
    if (secret) message = message.split(secret).join('[redacted]')
  }
  return message
}

function responsesInput(messages: AgentMessage[]): unknown[] {
  const input: unknown[] = []
  for (const message of messages) {
    if (message.role === 'user') {
      input.push({
        type: 'message',
        role: 'user',
        content: [
          ...(message.text ? [{ type: 'input_text', text: message.text }] : []),
          ...(message.images ?? []).map((image) => ({
            type: 'input_image',
            image_url: `data:${image.mime};base64,${image.base64}`,
          })),
        ],
      })
    } else if (message.role === 'assistant') {
      if (message.text) {
        input.push({
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: message.text }],
        })
      }
      for (const call of message.toolCalls ?? []) {
        // call_id pairs calls/results. Item IDs would refer to server-side state,
        // which is unavailable with store:false, so replay the full item instead.
        input.push({
          type: 'function_call',
          call_id: call.id,
          name: call.name,
          arguments: JSON.stringify(call.input),
        })
      }
    } else {
      for (const result of message.results) {
        input.push({ type: 'function_call_output', call_id: result.id, output: result.output })
      }
    }
  }
  return input
}

interface OutputItem {
  type?: string
  id?: string
  call_id?: string
  name?: string
  arguments?: string
  status?: string
}

interface ResponseEvent {
  type?: string
  delta?: string
  item?: OutputItem
  item_id?: string
  output_index?: number
  call_id?: string
  name?: string
  arguments?: string
  error?: unknown
  message?: string
  response?: {
    status?: string
    output?: OutputItem[]
    error?: unknown
    incomplete_details?: { reason?: string }
  }
}

interface PendingTool {
  callId: string
  name: string
  json: string
  done: boolean
}

/** Native ChatGPT subscription transport. Every successful turn has a completed response. */
export async function streamCodex(
  config: RuntimeAiConfig,
  system: string,
  messages: AgentMessage[],
  tools: AgentToolDef[],
  cb: StreamCallbacks,
): Promise<void> {
  const wd = createStreamWatchdog(cb.signal)
  return wd
    .guard(async () => {
      wd.signal.throwIfAborted()
      const onBytes = () => {
        wd.touch()
        cb.onActivity?.()
      }
      const response = await aiFetch(CODEX_RESPONSES_URL, {
        method: 'POST',
        redirect: 'error',
        signal: wd.signal,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          Authorization: `Bearer ${config.apiKey}`,
          ...(config.oauthAccountId ? { 'ChatGPT-Account-Id': config.oauthAccountId } : {}),
        },
        body: JSON.stringify({
          model: config.model,
          instructions: system,
          input: responsesInput(messages),
          tools: tools.map((tool) => ({
            type: 'function',
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
          })),
          stream: true,
          store: false,
        }),
      })
      onBytes()
      // Link both successful streams and error-body reads to cancellation, including
      // injected fetch implementations that only abort the initial request.
      const body = response.body?.pipeThrough(new TransformStream<Uint8Array, Uint8Array>(), {
        signal: wd.signal,
      })
      if (!response.ok) {
        const detail = body ? await new Response(body).text() : ''
        throw new CodexResponseError(publicHttpMessage(response.status, detail))
      }
      if (!body) throw new CodexResponseError('ChatGPT returned no response body')

      const pending = new Set<PendingTool>()
      const byItem = new Map<string, PendingTool>()
      const byIndex = new Map<number, PendingTool>()
      const byCall = new Map<string, PendingTool>()
      const toolFor = (event: ResponseEvent, item = event.item): PendingTool => {
        const itemId = item?.id ?? event.item_id
        const callId = item?.call_id ?? event.call_id
        const index = event.output_index
        const tool = (itemId ? byItem.get(itemId) : undefined) ??
          (callId ? byCall.get(callId) : undefined) ??
          (index !== undefined ? byIndex.get(index) : undefined) ?? {
            callId: '',
            name: '',
            json: '',
            done: false,
          }
        pending.add(tool)
        if (itemId) byItem.set(itemId, tool)
        if (index !== undefined) byIndex.set(index, tool)
        if (callId) {
          tool.callId = callId
          byCall.set(callId, tool)
        }
        if (item?.name ?? event.name) tool.name = (item?.name ?? event.name)!
        return tool
      }
      const finishTool = (event: ResponseEvent, item = event.item) => {
        if (item?.status && item.status !== 'completed') {
          throw new CodexResponseError('ChatGPT returned an unfinished function call')
        }
        const tool = toolFor(event, item)
        const args = item?.arguments ?? event.arguments
        if (typeof args === 'string') tool.json = args
        tool.done = true
      }
      let completed = false
      const acceptEvent = (payload: string): void => {
        if (payload === '[DONE]') {
          throw new CodexResponseError('ChatGPT stream ended before the response completed')
        }
        let event: ResponseEvent
        try {
          event = JSON.parse(payload) as ResponseEvent
        } catch {
          throw new CodexResponseError('ChatGPT returned a malformed streaming event')
        }
        if (!event || typeof event !== 'object') {
          throw new CodexResponseError('ChatGPT returned a malformed streaming event')
        }
        if (event.error) {
          throw new CodexResponseError(
            publicServiceMessage(event.error, 'ChatGPT stream failed. Please try again.'),
          )
        }
        switch (event.type) {
          case 'error':
            throw new CodexResponseError(
              publicServiceMessage(event, 'ChatGPT stream failed. Please try again.'),
            )
          case 'response.failed':
            throw new CodexResponseError(
              publicServiceMessage(
                event.response?.error,
                'ChatGPT response failed. Please try again.',
              ),
            )
          case 'response.incomplete': {
            const reason = event.response?.incomplete_details?.reason
            if (reason === 'max_output_tokens') cb.onStopReason?.('max_tokens')
            throw new CodexResponseError(
              reason === 'max_output_tokens'
                ? 'ChatGPT response was incomplete: output limit reached.'
                : 'ChatGPT response was incomplete. Please try again.',
            )
          }
          case 'response.output_text.delta':
            if (typeof event.delta === 'string') cb.onDelta(event.delta)
            break
          case 'response.reasoning_summary_text.delta':
            if (typeof event.delta === 'string') cb.onReasoningDelta?.(event.delta)
            break
          case 'response.output_item.added':
            if (event.item?.type === 'function_call') toolFor(event)
            break
          case 'response.function_call_arguments.delta': {
            const tool = toolFor(event)
            if (!tool.done && typeof event.delta === 'string') tool.json += event.delta
            break
          }
          case 'response.function_call_arguments.done':
            finishTool(event)
            break
          case 'response.output_item.done':
            if (event.item?.type === 'function_call') finishTool(event)
            break
          case 'response.completed':
            if (event.response?.status !== 'completed') {
              throw new CodexResponseError('ChatGPT response did not complete successfully.')
            }
            for (const item of event.response?.output ?? []) {
              if (item.type === 'function_call') finishTool({}, item)
            }
            completed = true
            break
        }
      }

      let data: string[] = []
      for await (const rawLine of sseLines(body, onBytes)) {
        wd.signal.throwIfAborted()
        const line = rawLine.replace(/\r$/, '')
        if (line === '') {
          if (data.length > 0) acceptEvent(data.join('\n'))
          data = []
          if (completed) break
        } else if (line.startsWith('data:')) {
          data.push(line.slice(5).replace(/^ /, ''))
        }
      }
      if (data.length > 0 && !completed) acceptEvent(data.join('\n'))
      wd.signal.throwIfAborted()
      if (!completed)
        throw new CodexResponseError('ChatGPT stream ended before the response completed')

      // Wait for the terminal event before making any tools executable. A completed
      // item followed by a failed/disconnected response must not execute partial work.
      const calls: AgentToolCall[] = []
      for (const tool of pending) {
        if (!tool.done || !tool.callId || !tool.name) {
          throw new CodexResponseError('ChatGPT returned an unfinished function call')
        }
        const parsed = parseToolInput(tool.json)
        const validObject =
          parsed.input && typeof parsed.input === 'object' && !Array.isArray(parsed.input)
        calls.push({
          id: tool.callId,
          name: tool.name,
          input: validObject ? parsed.input : {},
          inputError: parsed.error
            ? 'ChatGPT returned invalid JSON tool arguments.'
            : validObject
              ? undefined
              : 'Tool arguments must be a JSON object',
        })
      }
      for (const call of calls) cb.onToolCall(call)
    })
    .catch((error: unknown) => {
      if (cb.signal.aborted) throw cb.signal.reason
      if (error instanceof AiTimeoutError) throw error
      // Fetch/body failures can reflect request headers in their message or cause.
      // Return a fresh error containing only a safe diagnostic; do not retain causes.
      const message =
        error instanceof CodexResponseError
          ? error.message
          : isAiNetworkError(error)
            ? 'ChatGPT network error. Check your connection and try again.'
            : 'ChatGPT request failed. Please try again.'
      throw new Error(redactCredentials(message, config))
    })
}

/** One-shot UI requests still use the subscription backend's streaming protocol. */
export async function chatCodex(
  config: RuntimeAiConfig,
  system: string,
  user: string,
  signal?: AbortSignal,
): Promise<AiChatResponse> {
  let content = ''
  try {
    await streamCodex(config, system, [{ role: 'user', text: user }], [], {
      signal: signal ?? new AbortController().signal,
      onDelta: (text) => {
        content += text
      },
      onToolCall: () => {
        throw new CodexResponseError('ChatGPT returned an unexpected tool call')
      },
    })
    return content
      ? { ok: true, content }
      : { ok: false, error: 'ChatGPT returned an empty response' }
  } catch (error) {
    if (signal?.aborted || error instanceof AiTimeoutError) throw error
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
