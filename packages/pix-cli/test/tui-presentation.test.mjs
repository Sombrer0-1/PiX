// Requires a prior build. This file imports packages/pix-cli/dist/tui-presentation.js.
// Run: node --test packages/pix-cli/test/tui-presentation.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { isAgentTaskInfo, isPlanRuntimeSnapshot, isSubagentDetails, isWorkflowToolDetails, isWorkflowViewState } from "@earendil-works/pix-runtime/shared";
import { createPixInteractivePresentation } from "../dist/tui-presentation.js";

function task(overrides = {}) {
	return {
		schemaVersion: 1,
		taskId: "task-1",
		groupId: "group-1",
		groupMode: "single",
		workspaceId: "workspace-1",
		parentSessionId: "session-1",
		parentToolCallId: "call-1",
		itemSummaries: [],
		thinkingLevel: "medium",
		executionMode: "approval",
		project: {
			path: "E:/develop/demo",
			physicalPath: "E:/develop/demo",
			name: "demo",
			environment: { kind: "windows" },
		},
		presentation: "foreground",
		status: "running",
		description: "Scan the project",
		finalOutput: "",
		outputTruncated: false,
		originalOutputBytes: 0,
		results: [],
		activities: [],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0, turns: 0 },
		toolUseCount: 0,
		createdAt: 1,
		startedAt: 1,
		updatedAt: 1,
		durationMs: 0,
		deliveredSessionIds: [],
		planLinkState: "none",
		generation: 0,
		...overrides,
	};
}

function plan(phase, updatedAt = 1) {
	return {
		schemaVersion: 1,
		phase,
		planId: "plan-1",
		plan: null,
		deviations: [],
		updatedAt,
	};
}

function workflowRun(overrides = {}) {
	return {
		runId: "run-1",
		toolCallId: "wf-1",
		toolName: "workflow",
		name: "scan-files",
		members: [],
		logs: [],
		status: "running",
		...overrides,
	};
}

function agentTool(overrides = {}) {
	return {
		toolCallId: "call-1",
		toolName: "agent",
		args: { prompt: "full prompt stays in the detail", description: "Scan the project" },
		phase: "running",
		...overrides,
	};
}

const failedSubagent = {
	schemaVersion: 1,
	mode: "single",
	agentScope: "user",
	results: [{
		id: "result-1",
		index: 0,
		agentName: "scout",
		agentSource: "user",
		description: "Scan the project",
		status: "failed",
		finalOutput: "",
		outputTruncated: false,
		originalOutputBytes: 0,
		toolUseCount: 0,
		activities: [],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0, turns: 0 },
		failureReason: "api_error",
		errorMessage: "child exploded",
		startedAt: 1,
		endedAt: 2,
		durationMs: 1,
	}],
	startedAt: 1,
	updatedAt: 2,
	durationMs: 1,
};

test("task state arrives before the tool row and plan-linked text stays", () => {
	assert.equal(isAgentTaskInfo(task()), true);
	const view = createPixInteractivePresentation();
	const first = view.acceptHostEvent({ type: "task_state", sessionId: "session-1", task: task() });
	assert.equal(first.consumeText, true);
	assert.deepEqual(first.toolCallIds, ["call-1"]);
	const repeated = view.acceptHostEvent({ type: "task_state", sessionId: "session-1", task: task() });
	assert.deepEqual(repeated.toolCallIds, ["call-1"]);
	assert.equal(view.acceptHostEvent({ type: "unrelated" }), undefined);

	const described = view.describeTool(agentTool());
	assert.equal(described.subject, "Scan the project");
	assert.equal(described.progress, "0/1 complete, 0 failed");
	assert.equal(described.status, undefined);
	assert.match(described.details(), /full prompt stays in the detail/);
	assert.equal(described.subject.includes("full prompt"), false);

	const linked = task({
		taskId: "plan-task",
		groupId: "plan-group",
		parentToolCallId: "plan-call",
		planLink: { planId: "plan-1", version: 1, stepId: "step-1" },
		planLinkState: "pending",
	});
	assert.equal(isAgentTaskInfo(linked), true);
	const planTask = view.acceptHostEvent({ type: "task_state", sessionId: "session-1", task: linked });
	assert.equal(planTask.consumeText, undefined);
	assert.deepEqual(planTask.toolCallIds, ["plan-call"]);

	const owned = view.acceptHostEvent({
		type: "task_state",
		sessionId: "session-1",
		task: task({ taskId: "workflow-child", groupId: "workflow-group", parentToolCallId: "wf-call", workflowOwned: true }),
	});
	assert.equal(owned.consumeText, true);
	assert.deepEqual(owned.toolCallIds, ["wf-call"]);
	assert.equal(view.describeTool(agentTool()).progress, "0/1 complete, 0 failed");
});

test("background task is restored from the session snapshot and drops its live state when removed", () => {
	const restored = task({ presentation: "background", description: "Keep scanning" });
	const snapshotPlan = plan("executing");
	assert.equal(isAgentTaskInfo(restored), true);
	assert.equal(isPlanRuntimeSnapshot(snapshotPlan), true);
	const view = createPixInteractivePresentation();
	const update = view.acceptHostEvent({
		type: "pix_tui_snapshot",
		sessionId: "session-1",
		tasks: [restored],
		plan: snapshotPlan,
	});
	assert.equal(update.pendingNotice, null);
	assert.deepEqual(update.toolCallIds, ["call-1"]);
	const handle = {
		kind: "agent_task_group",
		groupId: "group-1",
		mode: "single",
		tasks: [{
			kind: "agent_task",
			taskId: "task-1",
			generation: 0,
			status: "running",
			description: "Keep scanning",
			presentation: "background",
		}],
	};
	const tool = agentTool({
		phase: "succeeded",
		args: { description: "Keep scanning" },
		result: { content: [{ type: "text", text: "background" }], details: handle, isError: false },
	});
	const live = view.describeTool(tool);
	assert.equal(live.status, "background");
	assert.equal(live.progress, "0/1 complete, 0 failed");
	assert.equal(live.subject, "Keep scanning");

	const removed = view.acceptHostEvent({ type: "task_removed", sessionId: "session-1", taskId: "task-1" });
	assert.deepEqual(removed.toolCallIds, ["call-1"]);
	const historical = view.describeTool(tool);
	assert.equal(historical.status, "background");
	assert.equal(historical.progress, "status unavailable");
	assert.equal(view.describeTool({ ...tool, result: { ...tool.result, details: { schemaVersion: 99 } } }), undefined);
});

test("a restored workflow without a run-end is unfinished, and a background run settles in place", () => {
	const historicalRun = workflowRun();
	assert.equal(isWorkflowViewState(historicalRun), true);
	const history = createPixInteractivePresentation();
	const replay = history.acceptHostEvent({
		type: "workflow_event",
		sessionId: "session-1",
		observedStart: false,
		event: { type: "upsert", run: historicalRun },
	});
	assert.equal(replay.consumeText, true);
	assert.deepEqual(replay.toolCallIds, ["wf-1"]);
	const unfinished = history.describeTool({
		toolCallId: "wf-1",
		toolName: "workflow",
		args: { meta: { name: "scan-files", description: "Classify files" }, script: "return await agent('full script')" },
		phase: "no-result",
	});
	assert.equal(unfinished.status, "interrupted");
	assert.equal(unfinished.subject, "scan-files");
	assert.equal(unfinished.progress, "scan-files · 0/0 complete, unfinished");
	assert.match(unfinished.details(), /full script/);
	assert.equal(unfinished.subject.includes("full script"), false);

	const live = createPixInteractivePresentation();
	const running = workflowRun({ currentPhase: "scan" });
	live.acceptHostEvent({
		type: "workflow_event",
		sessionId: "session-1",
		observedStart: true,
		event: { type: "upsert", run: running },
	});
	const handle = { kind: "pix-workflow-run", schemaVersion: 1, value: null, agentsStarted: 0 };
	assert.equal(isWorkflowToolDetails(handle), true);
	const tool = {
		toolCallId: "wf-1",
		toolName: "workflow",
		args: { meta: { name: "scan-files", description: "Classify files" }, script: "return 1" },
		phase: "succeeded",
		result: { content: [{ type: "text", text: "background" }], details: handle, isError: false },
	};
	assert.equal(live.describeTool(tool).status, "background");
	const settledRun = workflowRun({
		currentPhase: "scan",
		stopReason: "completed",
		status: "completed",
		members: [{ seq: 1, label: "read", childId: "child-1", outcome: "failed", error: "missing file" }],
	});
	assert.equal(isWorkflowViewState(settledRun), true);
	const settled = live.acceptHostEvent({
		type: "workflow_event",
		sessionId: "session-1",
		observedStart: true,
		event: { type: "upsert", run: settledRun },
	});
	assert.deepEqual(settled.toolCallIds, ["wf-1"]);
	const done = live.describeTool(tool);
	assert.equal(done.status, "succeeded");
	assert.equal(done.progress, "scan-files · scan · 1/1 complete, 1 failed");
	assert.match(done.details(), /missing file/);

	const ralphView = {
		runId: "ralph-run",
		toolCallId: "ralph-1",
		toolName: "ralph",
		name: "ralph",
		members: [{ seq: 1, label: "round", childId: "child-1", outcome: "failed", error: "report rejected" }],
		logs: [{ message: "round log" }],
		stopReason: "completed",
		status: "completed",
	};
	const ralphDetails = {
		kind: "pix-workflow-run",
		schemaVersion: 1,
		view: ralphView,
		value: null,
		agentsStarted: 1,
		error: "child step failed",
	};
	assert.equal(isWorkflowToolDetails(ralphDetails), true);
	const ralph = createPixInteractivePresentation().describeTool({
		toolCallId: "ralph-1",
		toolName: "ralph",
		args: { objective: "Keep going until the report is clean." },
		phase: "failed",
		result: { content: [{ type: "text", text: "child step failed" }], details: ralphDetails, isError: true },
	});
	assert.equal(ralph.status, "failed");
	assert.match(ralph.diagnostic, /child step failed/);
	assert.equal(ralph.progress, "ralph · 1/1 complete, 1 failed");
	assert.match(ralph.details(), /Keep going until the report is clean/);
	assert.equal(ralph.subject, "ralph");
});

test("a successful agent result still shows a confirmed child failure", () => {
	assert.equal(isSubagentDetails(failedSubagent), true);
	const described = createPixInteractivePresentation().describeTool(agentTool({
		phase: "succeeded",
		result: { content: [{ type: "text", text: "partial" }], details: failedSubagent, isError: false },
	}));
	assert.equal(described.status, "failed");
	assert.equal(described.progress, "1 failed, 0 interrupted, 0 cancelled, 0 succeeded");
	assert.match(described.diagnostic, /child exploded/);
});

test("plan approval notice is restored from the snapshot and cleared when the phase leaves", () => {
	const waiting = plan("awaiting_approval");
	const executing = plan("executing", 2);
	assert.equal(isPlanRuntimeSnapshot(waiting), true);
	assert.equal(isPlanRuntimeSnapshot(executing), true);
	const view = createPixInteractivePresentation();
	const initial = view.acceptHostEvent({
		type: "pix_tui_snapshot",
		sessionId: "session-1",
		tasks: [],
		plan: waiting,
	});
	assert.equal(initial.pendingNotice, "Plan awaiting approval · /plan approve");
	assert.equal(view.acceptHostEvent({ type: "todo_state" }), undefined);
	const cleared = view.acceptHostEvent({ type: "plan_state", sessionId: "session-1", snapshot: executing });
	assert.equal(cleared.pendingNotice, null);
	assert.equal(cleared.consumeText, undefined);
});
