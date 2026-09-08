import type { OpenAiReasoningEffort } from './types'

/** Shared allowlist for public settings and the credential-stripping runtime boundary. */
export const OPENAI_REASONING_EFFORTS: readonly OpenAiReasoningEffort[] = [
  'none',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]

export function normalizeReasoningEffort(value: unknown): OpenAiReasoningEffort | undefined {
  return typeof value === 'string' &&
    OPENAI_REASONING_EFFORTS.includes(value as OpenAiReasoningEffort)
    ? (value as OpenAiReasoningEffort)
    : undefined
}
