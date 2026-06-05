import { describe, expect, it } from "vitest";
import { emptyTurnDiffSummary } from "../src/core/file-change.ts";
import { createVerificationGateState, shouldQueueVerificationContinuation } from "../src/core/verification-gate.ts";

describe("verification gate", () => {
	it("does not queue verification continuations outside active goals", () => {
		const state = createVerificationGateState(emptyTurnDiffSummary());
		state.hasFileChanges = true;

		expect(
			shouldQueueVerificationContinuation({
				enabled: true,
				hasActiveGoal: false,
				state,
			}),
		).toBe(false);
	});

	it("queues verification continuations for active goals with unverified file changes", () => {
		const state = createVerificationGateState(emptyTurnDiffSummary());
		state.hasFileChanges = true;

		expect(
			shouldQueueVerificationContinuation({
				enabled: true,
				hasActiveGoal: true,
				state,
			}),
		).toBe(true);
	});
});
