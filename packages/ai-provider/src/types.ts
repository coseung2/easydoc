import type {
  AgentMessage,
  AgentToolCall,
  AgentToolDef,
  UserSkillDefinition,
} from '@genoffice/agent-core'

export type AiProviderId =
  | 'genspark'
  | 'anthropic'
  | 'gemini'
  | 'deepseek'
  | 'openai'
  | 'kimi'
  | 'glm'
  | 'qwen'
  | 'doubao'
  | 'minimax'
  | 'xai'
  | 'mistral'
  | 'openrouter'
  | 'opencode-zen'
  | 'opencode-go'
  | 'custom'

/** Genspark account status (gsk login state; the sole auth source for AI features) */
export interface GenSparkAccountStatus {
  loggedIn: boolean
  email?: string
}

export type OpenAiReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface AiProviderConfig {
  apiKey: string
  model: string
  /** OpenAI can use the ChatGPT account held privately by the main process. */
  authMode?: 'api-key' | 'oauth' | undefined
  /** required for custom; for other direct providers it overrides the default endpoint (regional mirrors) */
  baseUrl?: string | undefined
  /** Direct OpenAI GPT-5.6 only; omitted lets the API use the model default (medium). */
  reasoningEffort?: OpenAiReasoningEffort | undefined
}

export interface AiProviderMeta {
  id: AiProviderId
  label: string
  models: string[]
  defaultModel: string
  keyPlaceholder: string
  needsBaseUrl?: boolean
  supportsOAuth?: boolean
}

/** Public account state only; credentials never cross IPC. */
export interface AiOAuthStatus {
  state: 'disconnected' | 'pending' | 'connected' | 'error'
  authorizationUrl?: string
  expiresAt?: number
  error?: string
}

export interface AiSettings {
  provider: AiProviderId
  providers: Record<AiProviderId, AiProviderConfig>
  /** Runtime-only user SKILL.md catalog/content. Main processes populate it on read and strip it before persistence. */
  userSkills?: UserSkillDefinition[]
  /** Persistent user-authored instructions appended to every user-facing office agent prompt. */
  aiRules?: string | undefined
  /**
   * Genspark cloud tools (web/image search via gsk, image generation, media
   * analysis). Default true; false makes tools skip the gsk backend entirely
   * (search falls back to free sources, gsk-only tools are unavailable).
   * Only meaningful while signed in — signed out, the gsk backend is
   * unavailable regardless.
   */
  gskToolsEnabled?: boolean
  /**
   * Output-token cap for ONE model turn of agent runs (default
   * DEFAULT_MAX_OUTPUT_TOKENS). Reasoning models bill their thinking against
   * this same budget, so a heavy edit turn can consume all of it and close with
   * finish_reason=length and no prose at all — raising it is the user's lever
   * (absent = the default, so pre-existing settings files keep working).
   */
  maxOutputTokens?: number | undefined
}

/** pre-provider settings shape (single OpenAI-compatible endpoint); migrated into "custom" */
export interface LegacyAiSettings {
  baseUrl?: string
  apiKey?: string
  model?: string
}

export interface AiChatRequest {
  settings: AiSettings
  system: string
  user: string
}

export interface AiChatResponse {
  ok: boolean
  content?: string
  error?: string
}

export interface AiStreamRequest {
  requestId: string
  settings: AiSettings
  system: string
  messages: AgentMessage[]
  tools?: AgentToolDef[]
  maxTokens?: number
}

export interface AiStreamChunk {
  requestId: string
  /** 'ping' = wire-level keepalive so the renderer can tell a live stream from a dead one;
   * 'reasoning' = model thinking delta (text carries it), stored for interleaved-thinking echo */
  type: 'delta' | 'reasoning' | 'tool-call' | 'done' | 'error' | 'ping'
  text?: string
  /** complete parsed tool call (emitted once its arguments finish streaming) */
  toolCall?: AgentToolCall
  error?: string
  /** machine-readable error cause ('timeout', exhausted 'credits', 'network' connectivity failure, 'overloaded' capacity/rate limit); lets the renderer localize the message */
  errorCode?: 'timeout' | 'credits' | 'network' | 'overloaded'
  /** normalized stop reason carried on 'done' ('max_tokens' = output cut off by the token limit) */
  stopReason?: string
}
