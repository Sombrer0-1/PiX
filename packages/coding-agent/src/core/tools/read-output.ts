import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import type { BackgroundTaskRegistry } from "../background-task-registry.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize } from "./truncate.ts";

const readOutputSchema = Type.Object({
	taskId: Type.String({ description: "Task ID returned by run_background" }),
	fromLine: Type.Optional(Type.Integer({ minimum: 1, description: "First cumulative line to read (1-based). Use the previous total plus 1 for new output. Omit to read the retained output." })),
});

export type ReadOutputInput = Static<typeof readOutputSchema>;

export function createReadOutputToolDefinition(
	registry: BackgroundTaskRegistry,
): ToolDefinition<typeof readOutputSchema> {
	return {
		name: "read_output",
		label: "Read Background Output",
		description: `Check a background command's status, exit code when available, and recent output. The latest ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)} are retained. When output is truncated, use the full output path in the result to read earlier lines.`,
		promptSnippet: "Read a background command's output and exit status",
		parameters: readOutputSchema,
		async execute(_toolCallId, { taskId, fromLine }: ReadOutputInput) {
			const result = registry.read(taskId, fromLine);
			if (!result.found) {
				return { content: [{ type: "text", text: `No background task found with ID: ${taskId}` }], details: undefined };
			}
			const exitCode = result.exitCode === null ? "" : `, exit code ${result.exitCode}`;
			return {
				content: [
					{
						type: "text",
						text: `Output for task ${taskId} (${result.status}${exitCode}) (${result.lines} lines, ${result.totalLines} total):\n\n${result.text}`,
					},
				],
				details: undefined,
			};
		},
	};
}
