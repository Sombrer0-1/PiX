import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BackgroundTaskRegistry } from "../src/core/background-task-registry.ts";
import { createEditToolDefinition } from "../src/core/tools/edit.ts";
import { applyEditsToNormalizedContent, computeEditsDiff } from "../src/core/tools/edit-diff.ts";
import { createGrepToolDefinition } from "../src/core/tools/grep.ts";
import { OutputAccumulator } from "../src/core/tools/output-accumulator.ts";
import { createReadOutputToolDefinition } from "../src/core/tools/read-output.ts";

describe("targeted fuzzy edits", () => {
	it("preserves unrelated Unicode, Markdown hard breaks, BOM and CRLF in execution and preview", async () => {
		const original = '\uFEFFtarget: “old”\r\nuntouched: “keep”—①  \r\nnext line\r\n';
		let written = "";
		const operations = {
			access: async () => {},
			readFile: async () => Buffer.from(original),
			writeFile: async (_path: string, text: string) => { written = text; },
		};
		const edits = [{ oldText: 'target: "old"', newText: 'target: "new"' }];
		const preview = await computeEditsDiff("example.md", edits, process.cwd(), { operations });
		const result = await createEditToolDefinition(process.cwd(), { operations }).execute(
			"edit", { path: "example.md", edits }, undefined, undefined, {} as never,
		);
		expect(written).toBe(original.replace('target: “old”', 'target: "new"'));
		expect(preview).not.toHaveProperty("error");
		expect("diff" in preview && preview.diff).toBe(result.details?.diff);
		expect(result.details?.patch).toContain('-target: “old”');
		expect(result.details?.patch).toContain(' untouched: “keep”—①  ');
	});

	it("maps changing Unicode lengths and mixed exact/fuzzy edits to the original file", () => {
		const original = "keep: ⑩ ﬃ cafe\u0301  \nＡＢＣ ⑩ ﬃ cafe\u0301\nexact\n";
		const result = applyEditsToNormalizedContent(original, [
			{ oldText: "ABC 10 ffi café", newText: "changed" },
			{ oldText: "exact", newText: "EXACT" },
		], "unicode.md");
		expect(result.baseContent).toBe(original);
		expect(result.newContent).toBe("keep: ⑩ ﬃ cafe\u0301  \nchanged\nEXACT\n");
	});

	it("does not replace half of a compatibility-expanded character", () => {
		expect(() => applyEditsToNormalizedContent("ﬃ", [{ oldText: "fi", newText: "X" }], "unicode.txt")).toThrow("Could not find");
	});
});

describe("background output cursors", () => {
	const accumulators: OutputAccumulator[] = [];
	afterEach(async () => {
		for (const output of accumulators.splice(0)) {
			output.finish();
			const path = output.snapshot().fullOutputPath;
			await output.closeTempFile();
			if (path) await rm(path);
		}
	});

	function fixture(options?: { maxBytes: number }) {
		const registry = new BackgroundTaskRegistry();
		const output = new OutputAccumulator({ ...options, tempFilePrefix: "pi-output-contract-test" });
		accumulators.push(output);
		(registry as unknown as { _tasks: Map<string, unknown> })._tasks.set("task", { output, status: "running" });
		return { registry, output };
	}

	it("uses inclusive 1-based cumulative line numbers and excludes notices from line counts", async () => {
		const { registry, output } = fixture();
		output.append(Buffer.from("one\ntwo\nthree\n"));
		expect(registry.read("task", 1)).toMatchObject({ text: "one\ntwo\nthree\n", lines: 3, totalLines: 3 });
		expect(registry.read("task", 3)).toMatchObject({ text: "three\n", lines: 1, totalLines: 3 });
		expect(registry.read("task", 4)).toMatchObject({ text: "(no new output)", lines: 0, totalLines: 3 });
		const result = await createReadOutputToolDefinition(registry).execute("read", { taskId: "task", fromLine: 3 }, undefined, undefined, {} as never);
		expect(result.content[0]).toMatchObject({ text: expect.stringContaining("(1 lines, 3 total)") });
	});

	it("continues polling after the retained tail moves and reports expired cursor ranges", () => {
		const { registry, output } = fixture();
		output.append(Buffer.from(Array.from({ length: 3000 }, (_, i) => `L${i + 1}`).join("\n")));
		expect(registry.read("task")).toMatchObject({ lines: 2000, totalLines: 3000 });
		output.append(Buffer.from("\nL3001"));
		expect(registry.read("task", 3001)).toMatchObject({ text: expect.stringMatching(/^L3001\n/), lines: 1, totalLines: 3001 });
		expect(registry.read("task", 1)).toMatchObject({ text: expect.stringContaining("Requested lines 1-1001 are no longer") });
		expect(registry.read("task", 3002)).toMatchObject({ lines: 0, totalLines: 3001 });
	});

	it("maps cumulative cursors when the byte limit truncates before the line limit", () => {
		const { registry, output } = fixture({ maxBytes: 12 });
		output.append(Buffer.from("first\nsecond\nthird\nfourth"));
		expect(registry.read("task", 4)).toMatchObject({ text: expect.stringMatching(/^fourth\n/), lines: 1, totalLines: 4 });
	});
});

it("grep respects hierarchical .gitignore files outside Git repositories", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-grep-ignore-test-"));
	try {
		await mkdir(join(root, "node_modules"));
		await mkdir(join(root, "src"));
		await writeFile(join(root, ".gitignore"), "node_modules/\n");
		await writeFile(join(root, "src", ".gitignore"), "generated.txt\n");
		await writeFile(join(root, "node_modules", "ignored.txt"), "needle");
		await writeFile(join(root, "src", "generated.txt"), "needle");
		await writeFile(join(root, "src", "main.txt"), "needle");
		const result = await createGrepToolDefinition(root).execute("grep", { pattern: "needle" }, undefined, undefined, {} as never);
		expect(result.content).toEqual([{ type: "text", text: "src/main.txt:1: needle" }]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
