/**
 * Engineering limits for one device agent. These are the numbers issue #5
 * supplies for the qualification manifest (docs/support-matrix.md). They are
 * not a frozen seven-day-run manifest; issue #27 records that separately.
 *
 * A user prompt may spend several model turns when the model calls the
 * execution service and then reads the result. The turn cap stops that
 * follow-up chain. Retries apply only to model transport failures, never
 * to hardware submissions.
 */
export const AGENT_LIMITS = {
  maxTurns: 4,
  maxContextTokens: 8_192,
  maxOutputTokens: 1_024,
  maxRetries: 2,
  requestTimeoutMs: 30_000,
  maxContextMessages: 40,
  maxSessionMessages: 40,
  maxSessionBytes: 256 * 1024,
} as const;

export interface AgentLimits {
  maxTurns: number;
  maxContextTokens: number;
  maxOutputTokens: number;
  maxRetries: number;
  requestTimeoutMs: number;
  maxContextMessages: number;
  maxSessionMessages: number;
  maxSessionBytes: number;
}

export function resolveLimits(overrides?: Partial<AgentLimits>): AgentLimits {
  return { ...AGENT_LIMITS, ...overrides };
}

/** Rough token count used only to enforce the context and session caps. */
export function estimateTokens(value: unknown): number {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}
