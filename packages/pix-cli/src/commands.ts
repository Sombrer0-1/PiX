import type { SessionHostCommand } from "@earendil-works/pi-coding-agent";
import {
	executePlanCommand,
	isPlanCommand,
	type PixProcessRuntime,
	type SoloSession,
	setSessionAcp,
} from "@earendil-works/pix-runtime";
import type { PlanCommand, PlanRuntimeSnapshot, TodoSnapshot } from "@earendil-works/pix-runtime/shared";

const PLAN_COMMANDS =
	"Usage: /plan new <request> | status | revise <feedback> | approve | start | continue | cancel | retry <stepId> | skip <stepId> | previous | retry-generation";

export function formatPlan(snapshot: PlanRuntimeSnapshot): string {
	const plan = snapshot.plan;
	if (!plan) {
		const failure = snapshot.failure?.message;
		if (failure) return `Plan ${snapshot.phase}: ${failure}`;
		return snapshot.generation ? `Plan ${snapshot.phase}.` : "No plan. Use /plan new <request> to create one.";
	}
	const steps = plan.steps.map((step) => `[${step.status}] ${step.stepId} ${step.title}`);
	return [`${plan.title} (v${plan.version}, ${snapshot.phase})`, plan.summary, ...steps].join("\n");
}

export function formatTodo(snapshot: TodoSnapshot): string {
	if (!snapshot.items.length) return "Todo list is empty.";
	return snapshot.items.map((item) => `[${item.status}] ${item.content}`).join("\n");
}

function planCommand(input: string, snapshot: PlanRuntimeSnapshot): PlanCommand {
	const [, verb = "status", text = ""] = /^(\S+)(?:\s+([\s\S]+))?$/.exec(input.trim()) ?? [];
	if (verb === "new" && text) return { type: "enter_planning", requestText: text };
	if (verb === "status") return { type: "get_snapshot" };
	if (verb === "retry-generation" && snapshot.failure) {
		return { type: "retry_generation", generationId: snapshot.failure.generationId };
	}
	const { plan, planId } = snapshot;
	if (verb === "cancel" && planId && !plan) {
		const generationId = snapshot.generation?.generationId ?? snapshot.failure?.generationId;
		if (generationId) return { type: "cancel", planId, generationId };
	}
	if (!plan) throw new Error(PLAN_COMMANDS);
	const ref = { planId: plan.planId, version: plan.version };
	switch (verb) {
		case "approve":
			return { type: "approve", ...ref };
		case "start":
			return { type: "start_execution", ...ref };
		case "continue":
			return { type: "continue_plan", ...ref };
		case "cancel":
			return { type: "cancel", ...ref };
		case "revise":
			if (text) return { type: "request_revision", ...ref, feedback: text };
			break;
		case "previous":
			if (snapshot.lastValidPlan) {
				return {
					type: "return_previous_version",
					planId: plan.planId,
					baseVersion: snapshot.lastValidPlan.version,
				};
			}
			break;
		case "retry":
		case "skip": {
			const step = plan.steps.find((item) => item.stepId === text || item.stepKey === text);
			if (step) return { type: verb === "retry" ? "retry_step" : "skip_step", ...ref, stepId: step.stepId };
			break;
		}
	}
	throw new Error(PLAN_COMMANDS);
}

export function cliCommands({
	getSolo,
	taskService,
}: {
	getSolo(): SoloSession;
	taskService: PixProcessRuntime["taskService"];
}): SessionHostCommand[] {
	return [
		{
			name: "acp",
			description: "Enable, disable, or check active compression (on, off, status)",
			rpc: ["set_acp", "get_acp"],
			async execute(input) {
				const { session } = getSolo();
				if (typeof input === "string") {
					const action = input.trim() || "status";
					if (action === "on" || action === "off") await setSessionAcp(session, action === "on");
					else if (action !== "status") throw new Error("Usage: /acp on | off | status");
				} else if (input.type === "set_acp") {
					if (typeof input.enabled !== "boolean") throw new Error("set_acp requires a boolean enabled value.");
					await setSessionAcp(session, input.enabled);
				}
				const enabled = session.sessionManager.getAcp();
				const locked = session.sessionManager.isAcpLocked();
				return typeof input === "string"
					? `ACP is ${enabled ? "on" : "off"}${locked ? " (locked)" : ""}.`
					: { enabled, locked };
			},
		},
		{
			name: "plan",
			description: "Create, view, revise, approve, execute, or cancel a plan",
			rpc: "plan_command",
			async execute(input) {
				const { planController } = getSolo();
				const command =
					typeof input === "string" ? planCommand(input, planController.getSnapshot()) : input.command;
				if (!isPlanCommand(command)) throw new Error("Invalid plan command.");
				const result = await executePlanCommand(planController, command);
				if (!result.success) throw new Error(result.error ?? result.code);
				return typeof input === "string" ? formatPlan(planController.getSnapshot()) : result.data;
			},
		},
		{
			name: "todo",
			description: "Show the session's todo list",
			rpc: "get_todo",
			async execute(input) {
				const snapshot = getSolo().todoController.getSnapshot();
				return typeof input === "string" ? formatTodo(snapshot) : snapshot;
			},
		},
		{
			name: "tasks",
			description: "List tasks or show a task by ID",
			rpc: ["list_tasks", "get_task"],
			async execute(input) {
				const taskId = typeof input === "string" ? input.trim() : input.taskId;
				if (typeof input !== "string" && input.type === "get_task" && (typeof taskId !== "string" || !taskId)) {
					throw new Error("get_task requires taskId.");
				}
				if (typeof taskId === "string" && taskId) {
					const task = taskService.get(taskId);
					if (!task) throw new Error(`Task not found: ${taskId}`);
					if (typeof input !== "string") return task;
					return [`${task.taskId} [${task.status}] ${task.description}`, task.finalOutput || task.errorMessage]
						.filter(Boolean)
						.join("\n");
				}
				const tasks = taskService.getAll().tasks;
				return typeof input === "string"
					? tasks.map((task) => `${task.taskId} [${task.status}] ${task.description}`).join("\n") || "No tasks."
					: tasks;
			},
		},
		{
			name: "cancel-task",
			description: "Cancel a task by ID",
			rpc: "cancel_task",
			async execute(input) {
				const taskId = typeof input === "string" ? input.trim() : input.taskId;
				if (typeof taskId !== "string" || !taskId) throw new Error("A task ID is required.");
				const task = taskService.get(taskId);
				if (!task) throw new Error(`Task not found: ${taskId}`);
				const result = await taskService.cancel(taskId, task.generation, "user_cancel");
				if (!result.ok) throw new Error(result.reason);
				return typeof input === "string" ? `Cancellation requested for ${taskId}.` : { taskId };
			},
		},
		{
			name: "workflows",
			description: "List workflow runs or show a run by ID",
			rpc: ["list_workflows", "get_workflow"],
			async execute(input) {
				const runs = getSolo().workflowRecorder.getSnapshot();
				const runId = typeof input === "string" ? input.trim() : input.runId;
				if (typeof input !== "string" && input.type === "get_workflow" && (typeof runId !== "string" || !runId)) {
					throw new Error("get_workflow requires runId.");
				}
				if (typeof runId === "string" && runId) {
					const run = runs.find((item) => item.runId === runId);
					if (!run) throw new Error(`Workflow run not found: ${runId}`);
					if (typeof input !== "string") return run;
					return [`${run.runId} [${run.status}] ${run.name}`, ...run.logs.map((log) => log.message)].join("\n");
				}
				return typeof input === "string"
					? runs.map((run) => `${run.runId} [${run.status}] ${run.name}`).join("\n") || "No workflow runs."
					: runs;
			},
		},
		{
			name: "cancel-workflow",
			description: "Cancel a workflow run by ID",
			rpc: "cancel_workflow",
			async execute(input) {
				const runId = typeof input === "string" ? input.trim() : input.runId;
				if (typeof runId !== "string" || !runId) throw new Error("A workflow run ID is required.");
				if (!getSolo().workflowEngine.cancel(runId)) throw new Error(`Active workflow run not found: ${runId}`);
				return typeof input === "string" ? `Cancellation requested for ${runId}.` : { runId };
			},
		},
	];
}
