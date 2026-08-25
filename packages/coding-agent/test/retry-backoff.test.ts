import { describe, expect, it } from "vitest";
import { computeRetryDelayMs } from "../src/utils/retry-backoff.ts";

describe("computeRetryDelayMs", () => {
	it("uses exact base delay when random is 0", () => {
		const result = computeRetryDelayMs({
			attempt: 1,
			baseDelayMs: 2000,
			maxBackoffMs: 32000,
			serverDelayCapMs: 60000,
			random: () => 0,
		});
		expect(result).toEqual({ action: "wait", delayMs: 2000, usedRetryAfter: false });
	});

	it("adds 25% jitter when random is 1", () => {
		const result = computeRetryDelayMs({
			attempt: 1,
			baseDelayMs: 2000,
			maxBackoffMs: 32000,
			serverDelayCapMs: 60000,
			random: () => 1,
		});
		expect(result).toEqual({ action: "wait", delayMs: 2500, usedRetryAfter: false });
	});

	it("caps jittered delay at maxBackoffMs", () => {
		const result = computeRetryDelayMs({
			attempt: 1,
			baseDelayMs: 2000,
			maxBackoffMs: 2200,
			serverDelayCapMs: 60000,
			random: () => 1,
		});
		expect(result).toEqual({ action: "wait", delayMs: 2200, usedRetryAfter: false });
	});

	it("caps large attempts at maxBackoffMs", () => {
		const result = computeRetryDelayMs({
			attempt: 10,
			baseDelayMs: 2000,
			maxBackoffMs: 32000,
			serverDelayCapMs: 60000,
			random: () => 0,
		});
		expect(result).toEqual({ action: "wait", delayMs: 32000, usedRetryAfter: false });
	});

	it("uses retryAfterMs without jitter when under the server cap", () => {
		const result = computeRetryDelayMs({
			attempt: 1,
			baseDelayMs: 2000,
			maxBackoffMs: 32000,
			retryAfterMs: 1500,
			serverDelayCapMs: 60000,
			random: () => 1,
		});
		expect(result).toEqual({ action: "wait", delayMs: 1500, usedRetryAfter: true });
	});

	it("gives up when retryAfterMs exceeds the server cap", () => {
		const result = computeRetryDelayMs({
			attempt: 1,
			baseDelayMs: 2000,
			maxBackoffMs: 32000,
			retryAfterMs: 120000,
			serverDelayCapMs: 60000,
			random: () => 0,
		});
		expect(result).toEqual({ action: "give_up", retryAfterMs: 120000 });
	});
});
