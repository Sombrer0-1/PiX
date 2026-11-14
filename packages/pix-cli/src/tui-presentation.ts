import type {
	InteractivePresentation,
	InteractivePresentationUpdate,
	InteractiveToolDescription,
	InteractiveToolSnapshot,
	ToolDisplayStatus,
} from "@earendil-works/pi-coding-agent";
import {
	type AgentTaskGroupHandle,
	type AgentTaskInfo,
	isAgentTaskGroupHandle,
	isAgentTaskInfo,
	isPlanRuntimeSnapshot,
	isSubagentDetails,
	isWorkflowToolDetails,
	isWorkflowViewState,
	type PlanRuntimeSnapshot,
	type SubagentDetails,
	type SubagentSingleResult,
	type WorkflowToolDetails,
	type WorkflowViewState,
} from "@earendil-works/pix-runtime/shared";

const PLAN_APPROVAL_NOTICE = "Plan awaiting approval · /plan approve";
const AGENT_TOOL = "agent";
const WORKFLOW_TOOLS = new Set(["workflow", "ralph"]);

interface MemberCounts {
	total: number;
	succeeded: number;
	failed: number;
	interrupted: number;
	cancelled: number;
	waiting: number;
	open: number;
}

interface StoredRun {
	run: WorkflowViewState;
	observedStart: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function field(event: object, key: string): unknown {
	if (!(key in event)) return undefined;
	return (event as Record<string, unknown>)[key];
}

function emptyCounts(): MemberCounts {
	return { total: 0, succeeded: 0, failed: 0, interrupted: 0, cancelled: 0, waiting: 0, open: 0 };
}

function countTasks(tasks: readonly AgentTaskInfo[]): MemberCounts {
	const counts = emptyCounts();
	counts.total = tasks.length;
	for (const task of tasks) {
		switch (task.status) {
			case "completed":
				counts.succeeded++;
				break;
			case "failed":
				counts.failed++;
				break;
			case "interrupted":
				counts.interrupted++;
				break;
			case "cancelled":
				counts.cancelled++;
				break;
			case "waiting_input":
				counts.waiting++;
				counts.open++;
				break;
			default:
				counts.open++;
				break;
		}
	}
	return counts;
}

function countResults(results: readonly SubagentSingleResult[]): MemberCounts {
	const counts = emptyCounts();
	counts.total = results.length;
	for (const result of results) {
		switch (result.status) {
			case "completed":
				counts.succeeded++;
				break;
			case "failed":
				counts.failed++;
				break;
			case "aborted":
				counts.cancelled++;
				break;
			default:
				counts.open++;
				break;
		}
	}
	return counts;
}

function unique(ids: readonly string[]): string[] {
	return [...new Set(ids.filter((id) => id.length > 0))];
}

function combine(parts: Array<string | undefined>): string | undefined {
	const lines: string[] = [];
	for (const part of parts) {
		if (!part || lines.includes(part)) continue;
		lines.push(part);
	}
	return lines.length > 0 ? lines.join("\n") : undefined;
}

function resultText(tool: InteractiveToolSnapshot): string | undefined {
	const text = tool.result?.content
		.map((item) => item.text ?? "")
		.filter((item) => item.length > 0)
		.join("\n");
	return text || undefined;
}

function presentationUpdate(input: InteractivePresentationUpdate): InteractivePresentationUpdate | undefined {
	const update: {
		toolCallIds?: readonly string[];
		pendingNotice?: string | null;
		consumeText?: boolean;
	} = {};
	if (input.toolCallIds && input.toolCallIds.length > 0) update.toolCallIds = input.toolCallIds;
	if (input.pendingNotice !== undefined) update.pendingNotice = input.pendingNotice;
	if (input.consumeText) update.consumeText = true;
	return update.toolCallIds || update.pendingNotice !== undefined || update.consumeText ? update : undefined;
}

function toolDescription(fields: InteractiveToolDescription): InteractiveToolDescription | undefined {
	const description: {
		status?: InteractiveToolDescription["status"];
		subject?: string;
		progress?: string;
		diagnostic?: string;
		details?: InteractiveToolDescription["details"];
	} = {};
	if (fields.status) description.status = fields.status;
	if (fields.subject) description.subject = fields.subject;
	if (fields.progress) description.progress = fields.progress;
	if (fields.diagnostic) description.diagnostic = fields.diagnostic;
	if (fields.details) description.details = fields.details;
	return description.status ||
		description.subject ||
		description.progress ||
		description.diagnostic ||
		description.details
		? description
		: undefined;
}

function isTaskList(value: unknown): value is AgentTaskInfo[] {
	return Array.isArray(value) && value.every((item) => isAgentTaskInfo(item));
}

function argText(args: unknown, key: string): string | undefined {
	if (!isRecord(args) || typeof args[key] !== "string") return undefined;
	const text = args[key].trim();
	return text.length > 0 ? text : undefined;
}

function argSubject(args: unknown): string | undefined {
	const description = argText(args, "description");
	if (description) return description;
	if (!isRecord(args)) return undefined;
	const lists = [args.tasks, args.chain];
	const names: string[] = [];
	for (const list of lists) {
		if (!Array.isArray(list)) continue;
		for (const item of list) {
			if (!isRecord(item) || typeof item.description !== "string") continue;
			const name = item.description.trim();
			if (name.length > 0) names.push(name);
		}
	}
	if (names.length > 0) return names.join(", ");
	return metaName(args);
}

function metaName(args: unknown): string | undefined {
	if (!isRecord(args) || !isRecord(args.meta) || typeof args.meta.name !== "string") return undefined;
	const name = args.meta.name.trim();
	return name.length > 0 ? name : undefined;
}

function promptLines(args: unknown): string[] {
	if (!isRecord(args)) return [];
	const lines: string[] = [];
	for (const key of ["prompt", "objective", "script"]) {
		const text = argText(args, key);
		if (text) lines.push(text);
	}
	for (const list of [args.tasks, args.chain]) {
		if (!Array.isArray(list)) continue;
		for (const item of list) {
			if (isRecord(item) && typeof item.prompt === "string" && item.prompt.trim().length > 0)
				lines.push(item.prompt);
		}
	}
	return lines;
}

function returned(tool: InteractiveToolSnapshot): boolean {
	return tool.phase !== "queued" && tool.phase !== "running";
}

function settledStatus(counts: MemberCounts, isError: boolean): ToolDisplayStatus {
	if (counts.failed > 0) return "failed";
	if (counts.interrupted > 0) return "interrupted";
	if (counts.cancelled > 0) return "cancelled";
	if (isError) return "failed";
	return "succeeded";
}

function agentProgress(counts: MemberCounts): string {
	if (counts.open > 0) return `${counts.succeeded}/${counts.total} complete, ${counts.failed} failed`;
	return `${counts.failed} failed, ${counts.interrupted} interrupted, ${counts.cancelled} cancelled, ${counts.succeeded} succeeded`;
}

function taskDiagnostic(tasks: readonly AgentTaskInfo[]): string | undefined {
	const lines = tasks.flatMap((task) => {
		if (task.status !== "failed" && task.status !== "cancelled" && task.status !== "interrupted") return [];
		const reason = task.errorMessage || task.failureReason;
		return reason ? [`${task.description}: ${reason}`] : [];
	});
	return lines.length > 0 ? lines.join("\n") : undefined;
}

function resultDiagnostic(results: readonly SubagentSingleResult[]): string | undefined {
	const lines = results.flatMap((result) => {
		if (result.status !== "failed" && result.status !== "aborted") return [];
		const reason = result.errorMessage || result.failureReason;
		return reason ? [`${result.description || result.agentName}: ${reason}`] : [];
	});
	return lines.length > 0 ? lines.join("\n") : undefined;
}

function planNotice(snapshot: PlanRuntimeSnapshot): InteractivePresentationUpdate {
	return { pendingNotice: snapshot.phase === "awaiting_approval" ? PLAN_APPROVAL_NOTICE : null };
}

export function createPixInteractivePresentation(): InteractivePresentation {
	const tasks = new Map<string, AgentTaskInfo>();
	const byTool = new Map<string, Set<string>>();
	const byGroup = new Map<string, Set<string>>();
	const runs = new Map<string, StoredRun>();
	const runsByTool = new Map<string, string>();

	const rememberTask = (info: AgentTaskInfo) => {
		tasks.set(info.taskId, info);
		const group = byGroup.get(info.groupId) ?? new Set<string>();
		group.add(info.taskId);
		byGroup.set(info.groupId, group);
		const owned = byTool.get(info.parentToolCallId) ?? new Set<string>();
		owned.add(info.taskId);
		byTool.set(info.parentToolCallId, owned);
	};

	const toolIdsForTask = (info: AgentTaskInfo): string[] => {
		const ids = [info.parentToolCallId];
		for (const taskId of byGroup.get(info.groupId) ?? []) {
			const sibling = tasks.get(taskId);
			if (sibling) ids.push(sibling.parentToolCallId);
		}
		if (info.workflowOwned) {
			for (const stored of runs.values()) {
				if (stored.run.members.some((member) => member.childId === info.taskId)) ids.push(stored.run.toolCallId);
			}
		}
		return unique(ids);
	};

	const forgetTask = (taskId: string) => {
		const info = tasks.get(taskId);
		if (!info) return;
		tasks.delete(taskId);
		const group = byGroup.get(info.groupId);
		group?.delete(taskId);
		if (group && group.size === 0) byGroup.delete(info.groupId);
		const owned = byTool.get(info.parentToolCallId);
		owned?.delete(taskId);
		if (owned && owned.size === 0) byTool.delete(info.parentToolCallId);
	};

	const taskUpdate = (info: AgentTaskInfo): InteractivePresentationUpdate | undefined => {
		rememberTask(info);
		const consume = info.workflowOwned === true || (info.planLink === undefined && info.parentToolCallId.length > 0);
		return presentationUpdate({
			toolCallIds: toolIdsForTask(info),
			...(consume ? { consumeText: true } : {}),
		});
	};

	const rememberRun = (run: WorkflowViewState, observedStart: boolean) => {
		const previous = runs.get(run.runId);
		runs.set(run.runId, { run, observedStart: observedStart || previous?.observedStart === true });
		const replaced = runsByTool.get(run.toolCallId);
		if (replaced && replaced !== run.runId) runs.delete(replaced);
		runsByTool.set(run.toolCallId, run.runId);
	};

	const liveTasksFor = (
		tool: InteractiveToolSnapshot,
		handle: AgentTaskGroupHandle | undefined,
		details: SubagentDetails | undefined,
	): AgentTaskInfo[] => {
		const ids = new Set<string>(byTool.get(tool.toolCallId) ?? []);
		if (handle) {
			for (const task of handle.tasks) ids.add(task.taskId);
			for (const taskId of byGroup.get(handle.groupId) ?? []) ids.add(taskId);
		}
		if (details?.taskId) ids.add(details.taskId);
		if (details?.groupId) {
			for (const taskId of byGroup.get(details.groupId) ?? []) ids.add(taskId);
		}
		return [...ids].flatMap((id) => {
			const info = tasks.get(id);
			return info && info.workflowOwned !== true ? [info] : [];
		});
	};

	const describeAgent = (tool: InteractiveToolSnapshot): InteractiveToolDescription | undefined => {
		const raw = tool.result?.details;
		if (raw !== undefined && !isSubagentDetails(raw) && !isAgentTaskGroupHandle(raw)) return undefined;
		const details = isSubagentDetails(raw) ? raw : undefined;
		const handle = isAgentTaskGroupHandle(raw) ? raw : undefined;
		const live = liveTasksFor(tool, handle, details);
		const detailCounts = details ? countResults(details.results) : undefined;
		const liveCounts = live.length > 0 ? countTasks(live) : undefined;
		const background = handle !== undefined || live.some((task) => task.presentation === "background");
		const isError = tool.result?.isError === true;
		let counts: MemberCounts | undefined;
		let unavailable = false;
		if (handle && live.length === 0) unavailable = true;
		else if (liveCounts && (!detailCounts || liveCounts.open > 0 || liveCounts.waiting > 0)) {
			counts = liveCounts;
			if (detailCounts) {
				counts.failed = Math.max(counts.failed, detailCounts.failed);
				counts.total = Math.max(counts.total, detailCounts.total);
			}
		} else if (detailCounts) counts = detailCounts;
		else if (liveCounts) counts = liveCounts;

		const subject =
			live
				.map((task) => task.description)
				.filter((item) => item.length > 0)
				.join(", ") ||
			handle?.tasks
				.map((task) => task.description)
				.filter((item) => item.length > 0)
				.join(", ") ||
			details?.results
				.map((result) => result.description)
				.filter((item) => item.length > 0)
				.join(", ") ||
			argSubject(tool.args);
		const diagnostic = combine([
			isError ? resultText(tool) : undefined,
			live.length > 0 ? taskDiagnostic(live) : undefined,
			details ? resultDiagnostic(details.results) : undefined,
		]);
		const detailText = (): string | undefined => {
			const lines = [
				...promptLines(tool.args),
				...(details?.results.flatMap((result) => [
					`${result.description}: ${result.status}`,
					result.finalOutput,
					result.errorMessage,
				]) ?? []),
				...live.flatMap((task) => [`${task.description}: ${task.status}`, task.finalOutput, task.errorMessage]),
			].filter((line): line is string => typeof line === "string" && line.length > 0);
			return lines.length > 0 ? lines.join("\n") : undefined;
		};

		if (unavailable) {
			return toolDescription({
				status: "background",
				subject,
				progress: "status unavailable",
				diagnostic,
				details: detailText,
			});
		}
		if (!counts) return toolDescription({ subject, diagnostic, details: detailText });

		let status: ToolDisplayStatus | undefined;
		if (counts.waiting > 0) status = "waiting-input";
		else if (counts.open > 0 && returned(tool) && background && !isError) status = "background";
		else if (counts.open === 0) status = settledStatus(counts, isError);
		else if (isError) status = settledStatus(counts, true);
		return toolDescription({
			status,
			subject,
			progress: agentProgress(counts),
			diagnostic,
			details: detailText,
		});
	};

	const storedRunFor = (
		tool: InteractiveToolSnapshot,
		details: WorkflowToolDetails | undefined,
	): StoredRun | undefined => {
		const runId = details?.view?.runId ?? runsByTool.get(tool.toolCallId);
		return runId ? runs.get(runId) : undefined;
	};

	const selectedView = (
		details: WorkflowToolDetails | undefined,
		stored: StoredRun | undefined,
	): WorkflowViewState | undefined => {
		const detailView = details?.view;
		const storedView = stored?.run;
		if (detailView?.stopReason) return detailView;
		if (storedView?.stopReason) return storedView;
		return storedView ?? detailView;
	};

	const runWaiting = (view: WorkflowViewState | undefined): boolean =>
		view?.members.some((member) => tasks.get(member.childId)?.status === "waiting_input") === true;

	const describeWorkflow = (tool: InteractiveToolSnapshot): InteractiveToolDescription | undefined => {
		const raw = tool.result?.details;
		if (raw !== undefined && !isWorkflowToolDetails(raw)) return undefined;
		const details = isWorkflowToolDetails(raw) ? raw : undefined;
		const stored = storedRunFor(tool, details);
		const view = selectedView(details, stored);
		const name = view?.name || metaName(tool.args);
		const isError = tool.result?.isError === true;
		const stop = view?.stopReason;
		const historical = stored !== undefined && stored.observedStart === false && stop === undefined;
		const failedMembers = view?.members.filter((member) => member.outcome === "failed").length ?? 0;
		const done = view?.members.filter((member) => member.outcome).length ?? 0;
		const total = view?.members.length ?? 0;
		const phase = view?.currentPhase ? `${view.currentPhase} · ` : "";
		const memberErrors =
			view?.members.flatMap((member) => (member.error ? [`${member.label}: ${member.error}`] : [])) ?? [];
		const diagnostic = combine([
			isError ? resultText(tool) : undefined,
			details?.error,
			memberErrors.join("\n") || undefined,
		]);
		const detailText = (): string | undefined => {
			const current = selectedView(details, storedRunFor(tool, details));
			const lines = [
				...promptLines(tool.args),
				...(current?.members.map(
					(member) => `${member.label}: ${member.outcome ?? "running"}${member.error ? ` (${member.error})` : ""}`,
				) ?? []),
				...(current?.logs.map((line) => line.message) ?? []),
			];
			const text = lines.filter((line) => line.length > 0).join("\n");
			return text.length > 0 ? text : undefined;
		};
		const progress = (suffix?: string) =>
			name ? `${name} · ${phase}${done}/${total} complete${suffix ? `, ${suffix}` : ""}` : undefined;

		let status: ToolDisplayStatus | undefined;
		let progressText: string | undefined;
		if (!view && !stored) {
			if (isError) status = "failed";
			else if (returned(tool) && details && details.view === undefined) {
				status = "background";
				progressText = "status unavailable";
			}
		} else if (stop) {
			status = stop === "cancelled" ? "cancelled" : isError || stop === "error" ? "failed" : "succeeded";
			progressText = progress(failedMembers > 0 ? `${failedMembers} failed` : undefined);
		} else if (runWaiting(view)) {
			status = "waiting-input";
			progressText = progress();
		} else if (historical) {
			status = "interrupted";
			progressText = progress("unfinished");
		} else if (returned(tool)) {
			status = "background";
			progressText = progress();
		} else {
			progressText = progress();
		}
		if (isError && status !== "cancelled" && status !== "interrupted") status = "failed";
		return toolDescription({
			status,
			subject: name,
			progress: progressText,
			diagnostic,
			details: detailText,
		});
	};

	const acceptHostEvent = (event: Readonly<{ type: string }>): InteractivePresentationUpdate | undefined => {
		if (event.type === "task_state") {
			const task = field(event, "task");
			return isAgentTaskInfo(task) ? taskUpdate(task) : undefined;
		}
		if (event.type === "task_removed") {
			const taskId = field(event, "taskId");
			if (typeof taskId !== "string") return undefined;
			const info = tasks.get(taskId);
			if (!info) return undefined;
			const ids = toolIdsForTask(info);
			const consume =
				info.workflowOwned === true || (info.planLink === undefined && info.parentToolCallId.length > 0);
			forgetTask(taskId);
			return presentationUpdate({ toolCallIds: ids, ...(consume ? { consumeText: true } : {}) });
		}
		if (event.type === "workflow_event") {
			const inner = field(event, "event");
			const run = isRecord(inner) && inner.type === "upsert" ? inner.run : undefined;
			if (!isWorkflowViewState(run)) return undefined;
			rememberRun(run, field(event, "observedStart") === true);
			const ids = [run.toolCallId];
			for (const member of run.members) {
				const child = tasks.get(member.childId);
				if (child?.workflowOwned && child.parentToolCallId) ids.push(child.parentToolCallId);
			}
			return presentationUpdate({ toolCallIds: unique(ids), consumeText: true });
		}
		if (event.type === "plan_state") {
			const snapshot = field(event, "snapshot");
			return isPlanRuntimeSnapshot(snapshot) ? planNotice(snapshot) : undefined;
		}
		if (event.type === "pix_tui_snapshot") {
			const listed = field(event, "tasks");
			const snapshot = field(event, "plan");
			if (!isTaskList(listed) || !isPlanRuntimeSnapshot(snapshot)) return undefined;
			const ids: string[] = [];
			for (const task of listed) {
				rememberTask(task);
				ids.push(...toolIdsForTask(task));
			}
			return presentationUpdate({ ...planNotice(snapshot), toolCallIds: unique(ids) });
		}
		return undefined;
	};

	return {
		acceptHostEvent,
		describeTool(tool) {
			if (tool.toolName === AGENT_TOOL) return describeAgent(tool);
			if (WORKFLOW_TOOLS.has(tool.toolName)) return describeWorkflow(tool);
			return undefined;
		},
	};
}
