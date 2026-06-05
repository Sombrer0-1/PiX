import type { TurnDiffSummary } from "./file-change.ts";
import type { CustomMessage } from "./messages.ts";

export interface VerificationGateState {
	hasFileChanges: boolean;
	verificationAttemptedAfterLastChange: boolean;
	verificationSucceededAfterLastChange: boolean;
	continuationCount: number;
	summary: TurnDiffSummary;
}

export function createVerificationGateState(summary: TurnDiffSummary): VerificationGateState {
	return {
		hasFileChanges: false,
		verificationAttemptedAfterLastChange: false,
		verificationSucceededAfterLastChange: false,
		continuationCount: 0,
		summary,
	};
}

export function shouldQueueVerificationContinuation(options: {
	enabled: boolean;
	hasActiveGoal: boolean;
	state: VerificationGateState;
}): boolean {
	const { enabled, hasActiveGoal, state } = options;
	return (
		enabled &&
		hasActiveGoal &&
		state.hasFileChanges &&
		!state.verificationAttemptedAfterLastChange &&
		state.continuationCount < 2
	);
}

export function looksLikeVerificationCommand(command: string): boolean {
	const normalized = command.replace(/\s+/g, " ").trim().toLowerCase();
	return (
		/\b(npm|pnpm|yarn|bun)\s+(run\s+)?(test|check|lint|build|typecheck|package)\b/.test(normalized) ||
		/\b(npm|pnpm|yarn|bun)\s+(test|pack)\b/.test(normalized) ||
		/\b(vitest|jest|mocha|pytest|ruff|eslint|biome|tsc|tsgo|cargo\s+test|go\s+test|mvn\s+test|gradle\s+test)\b/.test(
			normalized,
		) ||
		/\b(electron-builder|vite\s+build|webpack|rollup)\b/.test(normalized)
	);
}

export function createVerificationContinuationMessage(summary: TurnDiffSummary): CustomMessage {
	const fileText = summary.files === 1 ? "1 file" : `${summary.files} files`;
	return {
		role: "custom",
		customType: "pi.verification_required",
		content: `<verification_required>
This run changed ${fileText} with +${summary.added} -${summary.removed}.
Before giving the final answer for a code/configuration change, run the narrowest useful verification now: targeted tests, typecheck, lint, build, or packaging when the user requested a packaged deliverable.
If verification is genuinely not applicable or cannot run in this environment, explain that clearly in the final answer instead of pretending it passed.
Keep this engineering discipline scoped to the current code/project work; do not force it onto creative writing, analysis, translation, or other non-code tasks.
</verification_required>`,
		display: false,
		details: { summary },
		timestamp: Date.now(),
	};
}
