import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import type { BackgroundTaskRegistry } from "../background-task-registry.ts";

const readOutputSchema = Type.Object({
	taskId: Type.String({ description: "Task ID returned by run_background" }),
	fromLine: Type.Optional(Type.Number({ description: "Return only lines starting from this line number (1-based). Omit to get all output." })),
});

export type ReadOutputInput = Static<typeof readOutputSchema>;

export function createReadOutputToolDefinition(
	registry: BackgroundTaskRegistry,
): ToolDefinition<typeof readOutputSchema> {
	return {
		name: "read_output",
		label: "Read Background Output",
		description:
			"Read the accumulated stdout and stderr output of a running background task. Pass fromLine to get only newer lines (useful for polling). Returns (no output yet) if nothing has been printed.",
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
