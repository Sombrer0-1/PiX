import { randomUUID } from "node:crypto";
import { spawn } from "child_process";
import { constants } from "node:fs";
import { access as fsAccess } from "node:fs/promises";
import { getShellConfig, getShellEnv, killProcessTree, normalizeWindowsNullDeviceRedirects, trackDetachedChildPid, untrackDetachedChildPid } from "../utils/shell.ts";
import { OutputAccumulator } from "./tools/output-accumulator.ts";
import { truncateTail } from "./tools/truncate.ts";

export interface BackgroundTask {
	taskId: string;
	command: string;
	pid: number | undefined;
	startedAt: number;
	status: "running" | "stopped" | "error";
	exitCode: number | null;
}

interface InternalTask extends BackgroundTask {
	output: OutputAccumulator;
	child: ReturnType<typeof spawn> | null;
}

export class BackgroundTaskRegistry {
	private _tasks = new Map<string, InternalTask>();

	async start(command: string, cwd: string, signal?: AbortSignal): Promise<{ taskId: string; pid: number | undefined }> {
		const taskId = `bg_${randomUUID().slice(0, 8)}`;
		const { shell, args } = getShellConfig();

		try {
			await fsAccess(cwd, constants.F_OK);
		} catch {
			throw new Error(`Working directory does not exist: ${cwd}`);
		}

		if (signal?.aborted) {
			throw new Error("aborted");
		}

		const commandForShell = normalizeWindowsNullDeviceRedirects(command, shell);
		const child = spawn(shell, [...args, commandForShell], {
			cwd,
			detached: process.platform !== "win32",
			env: getShellEnv(),
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});

		const pid = child.pid ?? undefined;
		if (pid) trackDetachedChildPid(pid);

		const task: InternalTask = {
			taskId,
			command,
			pid,
			startedAt: Date.now(),
			status: "running",
			exitCode: null,
			output: new OutputAccumulator({ tempFilePrefix: `pi-bg-${taskId}` }),
			child,
		};

		this._tasks.set(taskId, task);

		// Pipe output to accumulator
		child.stdout?.on("data", (data: Buffer) => task.output.append(data));
		child.stderr?.on("data", (data: Buffer) => task.output.append(data));

		// Handle abort signal
		const onAbort = () => {
			if (task.child?.pid) killProcessTree(task.child.pid);
		};
		if (signal) {
			if (signal.aborted) {
				onAbort();
			} else {
				signal.addEventListener("abort", onAbort, { once: true });
			}
		}

		// Handle process exit
		child.on("exit", (code) => {
			task.output.finish();
			task.exitCode = code;
			task.status = code === 0 || code === null ? "stopped" : "error";
			task.child = null;
			if (pid) untrackDetachedChildPid(pid);
			if (signal) signal.removeEventListener("abort", onAbort);
		});

		child.on("error", () => {
			task.output.finish();
			task.status = "error";
			task.child = null;
			if (pid) untrackDetachedChildPid(pid);
			if (signal) signal.removeEventListener("abort", onAbort);
		});

		return { taskId, pid };
	}

	read(
		taskId: string,
		fromLine?: number,
	):
		| { found: false }
		| {
				found: true;
				text: string;
				lines: number;
				totalLines: number;
				running: boolean;
		  } {
		const task = this._tasks.get(taskId);
		if (!task) return { found: false };

		const snapshot = task.output.snapshot({ persistIfTruncated: true });
		let text = snapshot.content || "(no output yet)";

		// If fromLine specified, return only lines from that point forward
		if (fromLine !== undefined && fromLine > 0) {
			const allLines = text.split("\n");
			if (fromLine >= allLines.length) {
				text = "";
			} else {
				text = allLines.slice(fromLine).join("\n");
			}
		}

		// Add truncation footer if output was truncated
		const truncation = snapshot.truncation;
		if (truncation.truncated) {
			const endLine = truncation.totalLines ?? 1;
			text += `\n\n[Showing last ${formatSize(truncation.outputBytes ?? 0)} of ${formatSize(truncation.totalBytes ?? 0)}, lines ${endLine - (truncation.outputLines ?? 1) + 1}-${endLine} of ${truncation.totalLines ?? 1}]`;
		}

		return {
			found: true,
			text,
			lines: text.split("\n").length,
			totalLines: snapshot.truncation.totalLines ?? text.split("\n").length,
			running: task.status === "running",
		};
	}

	stop(taskId: string): { found: boolean; status?: string; text?: string } {
		const task = this._tasks.get(taskId);
		if (!task) return { found: false };

		if (task.child?.pid) {
			killProcessTree(task.child.pid);
		}
		task.output.finish();
		task.status = "stopped";

		const snapshot = task.output.snapshot();
		return { found: true, status: "stopped", text: snapshot.content || "(no output)" };
	}

	stopAll(): void {
		for (const taskId of this._tasks.keys()) {
			this.stop(taskId);
		}
	}

	getTask(taskId: string): BackgroundTask | undefined {
		const task = this._tasks.get(taskId);
		if (!task) return undefined;
		const { output, child, ...rest } = task;
		return rest;
	}

	getRunning(): BackgroundTask[] {
		return Array.from(this._tasks.values())
			.filter((t) => t.status === "running")
			.map(({ output, child, ...rest }) => rest);
	}
}

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
