import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import type { BackgroundTaskRegistry } from "../background-task-registry.ts";

const readOutputSchema = Type.Object({
	taskId: Type.String({ description: "Task ID returned by run_background" }),
	fromLine: Type.Optional(Type.Integer({ minimum: 1, description: "Return retained output starting at this cumulative line number (1-based). Poll with the previous total + 1. Omit to get the retained output window." })),
});

export type ReadOutputInput = Static<typeof readOutputSchema>;

export function createReadOutputToolDefinition(
	registry: BackgroundTaskRegistry,
): ToolDefinition<typeof readOutputSchema> {
	return {
		name: "read_output",
		label: "Read Background Output",
		description:
			"Read the retained stdout and stderr output of a background task. Pass fromLine to poll using cumulative line numbers. Output is limited to the latest 2000 lines or 50KB; a truncation notice identifies the retained range and full output file. Returns (no output yet) if nothing has been printed, or (no new output) when the cursor is past the output.",
		promptSnippet: "Read the output of a running background task",
		parameters: readOutputSchema,
		async execute(_toolCallId, { taskId, fromLine }: ReadOutputInput) {
			const result = registry.read(taskId, fromLine);
			if (!result.found) {
				return { content: [{ type: "text", text: `No background task found with ID: ${taskId}` }], details: undefined };
			}
			const status = result.running ? " (still running)" : " (stopped)";
			return {
				content: [
					{
						type: "text",
						text: `Output for task ${taskId}${status} (${result.lines} lines, ${result.totalLines} total):\n\n${result.text}`,
					},
				],
				details: undefined,
			};
		},
	};
}
