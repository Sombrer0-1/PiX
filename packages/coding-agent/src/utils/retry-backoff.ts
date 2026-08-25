export interface RetryBackoffInput {
	attempt: number; // 1-based
	baseDelayMs: number; // settings.retry.baseDelayMs
	maxBackoffMs: number; // settings.retry.maxBackoffMs (turn-level exponential backoff cap)
	retryAfterMs?: number; // from AssistantMessage.apiError.retryAfterMs
	serverDelayCapMs: number; // settings.retry.provider.maxRetryDelayMs
	random?: () => number; // injectable; default Math.random
}

export type RetryBackoffResult =
	| { action: "wait"; delayMs: number; usedRetryAfter: boolean }
	| { action: "give_up"; retryAfterMs: number };

/**
 * Compute the next turn-level retry delay.
 * Server Retry-After wins when present (no jitter, no maxBackoffMs).
 * Values above serverDelayCapMs abort auto-retry instead of sleeping.
 */
export function computeRetryDelayMs(input: RetryBackoffInput): RetryBackoffResult {
	const random = input.random ?? Math.random;
	const retryAfterMs = input.retryAfterMs;

	if (typeof retryAfterMs === "number") {
		if (retryAfterMs > input.serverDelayCapMs) {
			return { action: "give_up", retryAfterMs };
		}
		return { action: "wait", delayMs: retryAfterMs, usedRetryAfter: true };
	}

	const base = input.baseDelayMs * 2 ** (input.attempt - 1);
	const jitter = base * random() * 0.25;
	const delayMs = Math.min(base + jitter, input.maxBackoffMs);
	return { action: "wait", delayMs, usedRetryAfter: false };
}
