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
			"Start a long-lived command such as a server or watcher. Returns a taskId immediately. Use bash when you need the command to finish before continuing.",
		promptSnippet: "Start a background command",
		parameters: runBackgroundSchema,
		async execute(_toolCallId, { command }: RunBackgroundInput, signal) {
			try {
				const { taskId, pid } = await registry.start(command, cwd, signal);
				return {
					content: [
						{
							type: "text",
							text: `Background task started.\nTask ID: ${taskId}\nPID: ${pid ?? "unknown"}\nCommand: ${command}\n\nUse read_output with taskId="${taskId}" to check output or status. Use stop_process with the same taskId to stop it.`,
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
