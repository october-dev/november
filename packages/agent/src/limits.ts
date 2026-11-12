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
  maxRetryDelayMs: 10_000,
  requestTimeoutMs: 30_000,
  maxResponseBytes: 1_048_576,
  maxContextMessages: 40,
  maxSessionMessages: 40,
  maxSessionBytes: 256 * 1024,
} as const;

export interface AgentLimits {
  maxTurns: number;
  maxContextTokens: number;
  maxOutputTokens: number;
  maxRetries: number;
  maxRetryDelayMs: number;
  requestTimeoutMs: number;
  maxResponseBytes: number;
  maxContextMessages: number;
  maxSessionMessages: number;
  maxSessionBytes: number;
}

const MINIMUMS: Record<keyof AgentLimits, number> = {
  maxTurns: 1,
  maxContextTokens: 1,
  maxOutputTokens: 1,
  maxRetries: 0,
  maxRetryDelayMs: 0,
  requestTimeoutMs: 1,
  maxResponseBytes: 1,
  maxContextMessages: 1,
  maxSessionMessages: 1,
  maxSessionBytes: 1,
};

export function resolveLimits(overrides?: Partial<AgentLimits>): AgentLimits {
  const limits = { ...AGENT_LIMITS, ...overrides };
  for (const [name, minimum] of Object.entries(MINIMUMS) as Array<
    [keyof AgentLimits, number]
  >) {
    const value = limits[name];
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      !Number.isInteger(value) ||
      value < minimum
    ) {
      throw new RangeError(`${name} must be an integer >= ${minimum}`);
    }
  }
  return limits;
}

/** Rough token count used only to enforce the context and session caps. */
export function estimateTokens(value: unknown): number {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}
