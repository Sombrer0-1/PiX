import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import type { BackgroundTaskRegistry } from "../background-task-registry.ts";

const stopProcessSchema = Type.Object({
	taskId: Type.String({ description: "Task ID returned by run_background" }),
});

export type StopProcessInput = Static<typeof stopProcessSchema>;

export function createStopProcessToolDefinition(
	registry: BackgroundTaskRegistry,
): ToolDefinition<typeof stopProcessSchema> {
	return {
		name: "stop_process",
		label: "Stop Background Process",
		description:
			"Stop a running background task by its taskId. Returns the final output collected before the process was killed.",
		promptSnippet: "Stop a running background task",
		parameters: stopProcessSchema,
		async execute(_toolCallId, { taskId }: StopProcessInput) {
			const result = registry.stop(taskId);
			if (!result.found) {
				return { content: [{ type: "text", text: `No background task found with ID: ${taskId}` }], details: undefined };
			}
			const outputPreview = result.text
				? `\n\nFinal output:\n${result.text.slice(0, 2000)}${result.text.length > 2000 ? "\n...(truncated)" : ""}`
				: "";
			return {
				content: [
					{
						type: "text",
						text: `Task ${taskId} stopped.${outputPreview}`,
					},
				],
				details: undefined,
			};
		},
	};
}
