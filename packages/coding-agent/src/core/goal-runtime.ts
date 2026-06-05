import { randomUUID } from "node:crypto";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "./extensions/types.ts";
import { defineTool } from "./extensions/types.ts";
import type { SessionManager } from "./session-manager.ts";

export type ThreadGoalStatus = "active" | "paused" | "blocked" | "usage_limited" | "budget_limited" | "complete";

export interface ThreadGoal {
	id: string;
	objective: string;
	status: ThreadGoalStatus;
	tokenBudget?: number;
	tokensUsed: number;
	timeUsedMs: number;
	createdAt: number;
	updatedAt: number;
}

export interface CreateGoalOptions {
	objective: string;
	tokenBudget?: number;
}

export interface UpdateGoalOptions {
	objective?: string;
	status?: ThreadGoalStatus;
	tokenBudget?: number;
}

export interface GoalToolHost {
	getGoal(): ThreadGoal | undefined;
	createGoal(options: CreateGoalOptions): ThreadGoal;
	updateGoal(options: UpdateGoalOptions): ThreadGoal;
}

interface StoredGoal extends ThreadGoal {
	activeStartedAt?: number;
}

interface GoalEntryData {
	version: 1;
	goal?: StoredGoal;
}

const GOAL_CUSTOM_TYPE = "pi.goal";
export const GOAL_TOOL_NAMES = new Set(["get_goal", "create_goal", "update_goal"]);

function now(): number {
	return Date.now();
}

function cloneGoal(goal: StoredGoal): ThreadGoal {
	const current = now();
	const activeDelta = goal.status === "active" && goal.activeStartedAt ? current - goal.activeStartedAt : 0;
	return {
		id: goal.id,
		objective: goal.objective,
		status: goal.status,
		tokenBudget: goal.tokenBudget,
		tokensUsed: goal.tokensUsed,
		timeUsedMs: Math.max(0, goal.timeUsedMs + activeDelta),
		createdAt: goal.createdAt,
		updatedAt: goal.updatedAt,
	};
}

function validateObjective(objective: string): string {
	const trimmed = objective.trim();
	if (!trimmed) {
		throw new Error("Goal objective cannot be empty");
	}
	if (trimmed.length > 4000) {
		throw new Error("Goal objective is too long");
	}
	return trimmed;
}

function validateBudget(tokenBudget: number | undefined): number | undefined {
	if (tokenBudget === undefined) return undefined;
	if (!Number.isFinite(tokenBudget) || tokenBudget <= 0) {
		throw new Error("Goal token budget must be positive when provided");
	}
	return Math.floor(tokenBudget);
}

function isStoredGoal(value: unknown): value is StoredGoal {
	if (!value || typeof value !== "object") return false;
	const goal = value as Partial<StoredGoal>;
	return (
		typeof goal.id === "string" &&
		typeof goal.objective === "string" &&
		typeof goal.status === "string" &&
		typeof goal.tokensUsed === "number" &&
		typeof goal.timeUsedMs === "number" &&
		typeof goal.createdAt === "number" &&
		typeof goal.updatedAt === "number"
	);
}

function tokenDeltaFromAssistant(message: AssistantMessage): number {
	const usage = message.usage;
	return Math.max(0, Math.floor((usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheWrite ?? 0)));
}

export class GoalRuntime {
	private goal: StoredGoal | undefined;
	private readonly sessionManager: SessionManager;

	constructor(sessionManager: SessionManager) {
		this.sessionManager = sessionManager;
		this.goal = this.loadLatestGoal();
	}

	getGoal(): ThreadGoal | undefined {
		return this.goal ? cloneGoal(this.goal) : undefined;
	}

	createGoal(options: CreateGoalOptions): ThreadGoal {
		const existing = this.goal;
		if (existing?.status === "active") {
			throw new Error("An active goal already exists. Complete, block, pause, or update it first.");
		}

		const current = now();
		this.goal = {
			id: randomUUID(),
			objective: validateObjective(options.objective),
			status: "active",
			tokenBudget: validateBudget(options.tokenBudget),
			tokensUsed: 0,
			timeUsedMs: 0,
			activeStartedAt: current,
			createdAt: current,
			updatedAt: current,
		};
		this.persist();
		return cloneGoal(this.goal);
	}

	updateGoal(options: UpdateGoalOptions): ThreadGoal {
		if (!this.goal) {
			throw new Error("No goal exists for this session");
		}

		const current = now();
		let next: StoredGoal = { ...this.goal };
		if (options.objective !== undefined) {
			next.objective = validateObjective(options.objective);
		}
		if (options.tokenBudget !== undefined) {
			next.tokenBudget = validateBudget(options.tokenBudget);
		}
		if (options.status !== undefined) {
			next = this.applyStatus(next, options.status, current);
		}
		next.updatedAt = current;
		this.goal = next;
		this.persist();
		return cloneGoal(this.goal);
	}

	accountAssistantUsage(message: AssistantMessage): ThreadGoal | undefined {
		if (!this.goal || this.goal.status !== "active") return undefined;
		const delta = tokenDeltaFromAssistant(message);
		if (delta <= 0) return undefined;

		const current = now();
		let next: StoredGoal = {
			...this.goal,
			tokensUsed: this.goal.tokensUsed + delta,
			updatedAt: current,
		};
		if (next.tokenBudget !== undefined && next.tokensUsed >= next.tokenBudget) {
			next = this.applyStatus(next, "budget_limited", current);
		}
		this.goal = next;
		this.persist();
		return cloneGoal(this.goal);
	}

	private applyStatus(goal: StoredGoal, status: ThreadGoalStatus, current: number): StoredGoal {
		if (goal.status === "active" && status !== "active" && goal.activeStartedAt) {
			goal.timeUsedMs += current - goal.activeStartedAt;
			goal.activeStartedAt = undefined;
		} else if (goal.status !== "active" && status === "active") {
			goal.activeStartedAt = current;
		}
		goal.status = status;
		return goal;
	}

	private persist(): void {
		this.sessionManager.appendCustomEntry(GOAL_CUSTOM_TYPE, {
			version: 1,
			goal: this.goal,
		} satisfies GoalEntryData);
	}

	private loadLatestGoal(): StoredGoal | undefined {
		const entries = this.sessionManager.getEntries();
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i];
			if (entry.type !== "custom" || entry.customType !== GOAL_CUSTOM_TYPE) continue;
			const data = entry.data as Partial<GoalEntryData> | undefined;
			if (!data || data.version !== 1) continue;
			return isStoredGoal(data.goal) ? data.goal : undefined;
		}
		return undefined;
	}
}

function escapeXml(input: string): string {
	return input.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function createGoalContinuationPrompt(goal: ThreadGoal): string {
	const budget = goal.tokenBudget === undefined ? "none" : String(goal.tokenBudget);
	const remaining =
		goal.tokenBudget === undefined ? "unbounded" : String(Math.max(0, goal.tokenBudget - goal.tokensUsed));
	return `<pi_internal_context source="goal">
Active goal:
<objective>${escapeXml(goal.objective)}</objective>
<tokens_used>${goal.tokensUsed}</tokens_used>
<token_budget>${budget}</token_budget>
<remaining_tokens>${remaining}</remaining_tokens>

Continue working toward this active goal without waiting for new user input. Before doing more work, audit the current conversation and repository state. Call update_goal with status "complete" only when the objective is actually achieved. Call update_goal with status "blocked" only after the same blocking condition has repeated for at least three consecutive goal turns and you cannot make meaningful progress. Respect the token budget when one is set.
</pi_internal_context>`;
}

export function createGoalUpdatedPrompt(goal: ThreadGoal): string {
	const budget = goal.tokenBudget === undefined ? "none" : String(goal.tokenBudget);
	const remaining =
		goal.tokenBudget === undefined ? "unbounded" : String(Math.max(0, goal.tokenBudget - goal.tokensUsed));
	return `<pi_internal_context source="goal">
The active goal has been updated and supersedes any previous goal context:
<objective>${escapeXml(goal.objective)}</objective>
<tokens_used>${goal.tokensUsed}</tokens_used>
<token_budget>${budget}</token_budget>
<remaining_tokens>${remaining}</remaining_tokens>

Continue using this updated goal. Do not call update_goal unless the updated goal is actually complete, blocked, or otherwise changes status.
</pi_internal_context>`;
}

export function formatGoalForTool(goal: ThreadGoal | undefined): string {
	if (!goal) return "No goal is set for this session.";
	const budget = goal.tokenBudget === undefined ? "none" : String(goal.tokenBudget);
	return JSON.stringify(
		{
			id: goal.id,
			objective: goal.objective,
			status: goal.status,
			token_budget: budget,
			tokens_used: goal.tokensUsed,
			time_used_seconds: Math.floor(goal.timeUsedMs / 1000),
		},
		null,
		2,
	);
}

const createGoalSchema = Type.Object({
	objective: Type.String({ description: "Concrete objective to start pursuing." }),
	token_budget: Type.Optional(Type.Number({ description: "Optional positive token budget for this goal." })),
});

const updateGoalSchema = Type.Object({
	objective: Type.Optional(Type.String({ description: "Optional replacement objective." })),
	status: Type.Optional(
		Type.Union([
			Type.Literal("active"),
			Type.Literal("paused"),
			Type.Literal("blocked"),
			Type.Literal("usage_limited"),
			Type.Literal("budget_limited"),
			Type.Literal("complete"),
		]),
	),
	token_budget: Type.Optional(Type.Number({ description: "Optional positive token budget." })),
});

export function createGoalToolDefinitions(host: GoalToolHost): ToolDefinition[] {
	return [
		defineTool({
			name: "get_goal",
			label: "Get goal",
			description: "Get the current session goal, status, budget, and usage.",
			promptSnippet: "Inspect the current active goal and its budget/status.",
			parameters: Type.Object({}),
			async execute() {
				const goal = host.getGoal();
				return {
					content: [{ type: "text", text: formatGoalForTool(goal) }],
					details: { goal },
				};
			},
		}),
		defineTool({
			name: "create_goal",
			label: "Create goal",
			description:
				"Create a new active goal for the session. Use only when the user explicitly asks to start a goal.",
			promptSnippet: "Create a persistent session goal when explicitly requested by the user.",
			parameters: createGoalSchema,
			executionMode: "sequential",
			async execute(_toolCallId, params: Static<typeof createGoalSchema>) {
				const goal = host.createGoal({
					objective: params.objective,
					tokenBudget: params.token_budget,
				});
				return {
					content: [{ type: "text", text: `Created goal:\n${formatGoalForTool(goal)}` }],
					details: { goal },
				};
			},
		}),
		defineTool({
			name: "update_goal",
			label: "Update goal",
			description: "Update the current goal objective, budget, or status.",
			promptSnippet: "Mark an active goal complete, blocked, paused, or update its objective/budget.",
			parameters: updateGoalSchema,
			executionMode: "sequential",
			async execute(_toolCallId, params: Static<typeof updateGoalSchema>) {
				const goal = host.updateGoal({
					objective: params.objective,
					status: params.status,
					tokenBudget: params.token_budget,
				});
				return {
					content: [{ type: "text", text: `Updated goal:\n${formatGoalForTool(goal)}` }],
					details: { goal },
				};
			},
		}),
	];
}
