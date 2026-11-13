import { describe, expect, it } from "vitest";
import { ToolCallArgumentsStream } from "../src/utils/streaming-json.ts";

describe("streamed tool arguments", () => {
	it("keeps snapshots stable across split strings, escapes, and nested values", () => {
		const stream = new ToolCallArgumentsStream();
		const before = stream.append('{"path":"a.ts","items":[{"content":"one \\u00');
		expect(before).toEqual({ path: "a.ts", items: [{ content: "one " }] });
		expect(stream.append('e9","enabled":tru')).toEqual({
			path: "a.ts",
			items: [{ content: "one é", enabled: true }],
		});
		stream.append("e}]}");
		expect(before).toEqual({ path: "a.ts", items: [{ content: "one " }] });
		expect(stream.finish()).toEqual({ arguments: { path: "a.ts", items: [{ content: "one é", enabled: true }] } });
	});

	it("handles long write arguments split across many deltas", () => {
		const content = 'const item = "a";\n'.repeat(20_000);
		const json = JSON.stringify({ path: "a.ts", content });
		const stream = new ToolCallArgumentsStream();
		for (let offset = 0; offset < json.length; offset += 32) {
			stream.append(json.slice(offset, offset + 32));
		}
		expect(stream.finish()).toEqual({ arguments: { path: "a.ts", content } });
	});

	it("rejects a malformed final object while keeping existing string repairs", () => {
		const stream = new ToolCallArgumentsStream();
		expect(stream.append('{"path":"a.ts",')).toEqual({ path: "a.ts" });
		expect(stream.finish()).toEqual({
			arguments: {},
			argumentsError: expect.stringContaining('Received arguments:\n{"path":"a.ts",'),
		});
		expect(stream.replace(String.raw`{"path":"C:\dev\code.ts"}`).delta).toBeUndefined();
		expect(stream.finish()).toEqual({ arguments: { path: String.raw`C:\dev\code.ts` } });
	});
});
