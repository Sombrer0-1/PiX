import { describe, expect, it } from "vitest";
import {
	addFileChangeToTurnSummary,
	countDiffStat,
	emptyTurnDiffSummary,
	extractFileChangeFromToolResult,
} from "../src/core/file-change.ts";

describe("file change summaries", () => {
	it("counts display diff additions and removals", () => {
		const diff = ["  1 keep", "- 2 old", "- 3 old", "+ 2 new", "  4 keep"].join("\n");

		expect(countDiffStat(diff)).toEqual({ added: 1, removed: 2 });
	});

	it("extracts tool result diff details into a file change summary", () => {
		const change = extractFileChangeFromToolResult({
			toolCallId: "tool-1",
			toolName: "write",
			args: { path: "src/app.ts" },
			isError: false,
			result: {
				content: [{ type: "text", text: "ok" }],
				details: {
					diff: "- 1 old\n+ 1 new\n+ 2 next",
					patch: "--- src/app.ts\n+++ src/app.ts\n",
					firstChangedLine: 1,
				},
			},
		});

		expect(change).toMatchObject({
			toolCallId: "tool-1",
			toolName: "write",
			path: "src/app.ts",
			added: 2,
			removed: 1,
			firstChangedLine: 1,
		});
	});

	it("aggregates changes across a turn", () => {
		const first = {
			toolCallId: "tool-1",
			toolName: "edit",
			path: "a.ts",
			added: 2,
			removed: 1,
		};
		const second = {
			toolCallId: "tool-2",
			toolName: "write",
			path: "b.ts",
			added: 3,
			removed: 0,
		};

		const summary = addFileChangeToTurnSummary(addFileChangeToTurnSummary(emptyTurnDiffSummary(), first), second);

		expect(summary).toMatchObject({ files: 2, added: 5, removed: 1 });
	});
});
