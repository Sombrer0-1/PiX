import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import type { BackgroundTaskRegistry } from "../background-task-registry.ts";

const runBackgroundSchema = Type.Object({
	command: Type.String({ description: "Shell command to run in the background" }),
});

export type RunBackgroundInput = Static<typeof runBackgroundSchema>;

export function createRunBackgroundToolDefinition(
	cwd: string,
	registry: BackgroundTaskRegistry,
): ToolDefinition<typeof runBackgroundSchema> {
	return {
		name: "run_background",
		label: "Run Background",
		description:
			"Run a long-lived command in the background (dev servers, watchers, containers). Returns a taskId immediately without waiting for the process to exit. Use read_output to check the accumulated output, and stop_process to terminate the task.",
		promptSnippet: "Run long-lived commands in the background (dev servers, watchers, containers)",
		promptGuidelines: [
			"Use run_background for dev servers, watchers, containers, and other processes that should not block the agent. Use bash for short-lived commands that return and exit.",
			"Use read_output(taskId) to check what a background task has printed.",
			"Use stop_process(taskId) to terminate a background task when it is no longer needed.",
		],
		parameters: runBackgroundSchema,
		async execute(_toolCallId, { command }: RunBackgroundInput, signal) {
			try {
				const { taskId, pid } = await registry.start(command, cwd, signal);
				return {
					content: [
						{
							type: "text",
							text: `Background task started.\nTask ID: ${taskId}\nPID: ${pid ?? "unknown"}\nCommand: ${command}\n\nUse read_output("${taskId}") to check its output, or stop_process("${taskId}") to stop it.`,
						},
					],
					details: undefined,
				};
			} catch (err) {
				if (err instanceof Error && err.message === "aborted") {
					return { content: [{ type: "text", text: "Command aborted" }], details: undefined };
				}
				throw err;
			}
		},
	};
}
