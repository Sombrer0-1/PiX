import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { describe, expect, it, vi } from "vitest";
import { processResponsesStream } from "../src/providers/openai-responses-shared.ts";
import type { AssistantMessage, AssistantMessageEvent, Model } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";

function createOutput(model: Model<"openai-responses">): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

async function* createFunctionCallEvents(argumentsJson: string): AsyncIterable<ResponseStreamEvent> {
	yield {
		type: "response.output_item.added",
		item: {
			type: "function_call",
			id: "fc_test",
			call_id: "call_test",
			name: "edit",
			arguments: "",
		},
	} as ResponseStreamEvent;
	yield {
		type: "response.function_call_arguments.delta",
		delta: '{"path":"README.md"',
	} as ResponseStreamEvent;
	yield {
		type: "response.function_call_arguments.delta",
		delta: ',"content":"updated"}',
	} as ResponseStreamEvent;
	yield {
		type: "response.function_call_arguments.done",
		arguments: argumentsJson,
	} as ResponseStreamEvent;
	yield {
		type: "response.output_item.done",
		item: {
			type: "function_call",
			id: "fc_test",
			call_id: "call_test",
			name: "edit",
			arguments: argumentsJson,
		},
	} as ResponseStreamEvent;
}

describe("openai responses tool arguments", () => {
	const model: Model<"openai-responses"> = {
		id: "gpt-5-mini",
		name: "GPT-5 Mini",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 400000,
		maxTokens: 128000,
	};

	it("keeps parser state out of streamed and persisted tool calls", async () => {
		const output = createOutput(model);
		const stream = new AssistantMessageEventStream();
		const previews: unknown[] = [];
		const pushSpy = vi.spyOn(stream, "push").mockImplementation((event) => {
			if (event.type === "toolcall_delta") previews.push(structuredClone(event.partial.content[event.contentIndex]));
		});
		const argumentsJson = '{"path":"README.md","content":"updated"}';

		await processResponsesStream(createFunctionCallEvents(argumentsJson), output, stream, model);

		expect(output.content).toHaveLength(1);
		const persistedToolCall = output.content[0];
		expect(persistedToolCall?.type).toBe("toolCall");
		if (!persistedToolCall || persistedToolCall.type !== "toolCall") {
			throw new Error("Expected toolCall block");
		}
		expect(persistedToolCall.arguments).toEqual({ path: "README.md", content: "updated" });
		expect("partialJson" in persistedToolCall).toBe(false);
		expect(previews[0]).toEqual({
			type: "toolCall",
			id: "call_test|fc_test",
			name: "edit",
			arguments: { path: "README.md" },
		});

		const emittedEvents = pushSpy.mock.calls.map(([event]) => event as AssistantMessageEvent);
		const toolCallEnd = emittedEvents.find((event) => event.type === "toolcall_end");
		expect(toolCallEnd).toBeDefined();
		if (!toolCallEnd || toolCallEnd.type !== "toolcall_end") {
			throw new Error("Expected toolcall_end event");
		}
		expect(toolCallEnd.toolCall).toBe(persistedToolCall);
		expect("partialJson" in toolCallEnd.toolCall).toBe(false);
	});

	it("reports invalid final arguments even after a valid preview", async () => {
		const output = createOutput(model);
		const argumentsJson = '{"path":"README.md","content":"updated",';
		await processResponsesStream(
			createFunctionCallEvents(argumentsJson),
			output,
			new AssistantMessageEventStream(),
			model,
		);
		expect(output.content).toEqual([
			{
				type: "toolCall",
				id: "call_test|fc_test",
				name: "edit",
				arguments: {},
				argumentsError: expect.stringContaining(argumentsJson),
			},
		]);
	});
});
