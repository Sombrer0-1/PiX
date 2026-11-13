import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type * as FsPromises from "fs/promises";
import { createReadTool } from "../src/core/tools/read.ts";
import { DEFAULT_MAX_BYTES } from "../src/core/tools/truncate.ts";

const opened = vi.hoisted(() => ({
	abort: undefined as (() => void) | undefined,
	closed: undefined as (() => void) | undefined,
}));
vi.mock("fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof FsPromises>();
	return {
		...actual,
		open: async (...args: Parameters<typeof actual.open>) => {
			const handle = await actual.open(...args);
			if (opened.closed) handle.once("close", opened.closed);
			opened.abort?.();
			return handle;
		},
	};
});

describe("read tool streaming", () => {
	it("matches buffered reads when UTF-8 and CRLF cross chunk boundaries", async () => {
		const bytes = Buffer.from("\uFEFFfirst\r\n你好 🙂\r\nlast\n");
		const operations = { access: async () => {}, readFile: async () => bytes };
		const buffered = createReadTool(process.cwd(), { operations });
		const readFile = vi.fn(operations.readFile);
		const streamed = createReadTool(process.cwd(), {
			operations: {
				...operations,
				readFile,
				async *createReadStream() {
					for (const byte of bytes) yield Uint8Array.of(byte);
				},
			},
		});
		for (const range of [{}, { offset: 2, limit: 1 }, { offset: 4 }, { limit: 0 }]) {
			const args = { path: "test.txt", ...range };
			expect(await streamed.execute("read", args)).toEqual(await buffered.execute("read", args));
		}
		expect(readFile).not.toHaveBeenCalled();
	});

	it("reports a line larger than the byte cap without buffering its contents", async () => {
		const streamed = createReadTool(process.cwd(), {
			operations: {
				access: async () => {},
				readFile: async () => {
					throw new Error("Unexpected buffered read");
				},
				async *createReadStream() {
					for (let i = 0; i < 100; i++) yield Buffer.alloc(1024, "a");
					yield Buffer.from("\nnext\n");
				},
			},
		});
		const result = await streamed.execute("read", { path: "test.txt", limit: 1 });
		expect(result.content).toEqual([{ type: "text", text: expect.stringContaining("Line 1 is 100.0KB") }]);
		expect(result.details).toMatchObject({
			truncation: { totalBytes: 100 * 1024, maxBytes: DEFAULT_MAX_BYTES, firstLineExceedsLimit: true },
		});
	});

	it("can be cancelled while the local file opens", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-read-cancel-"));
		try {
			await writeFile(join(dir, "test.txt"), "line\n".repeat(30_000));
			const controller = new AbortController();
			const closed = new Promise<void>((resolve) => {
				opened.closed = resolve;
			});
			opened.abort = () => controller.abort();
			await expect(createReadTool(dir).execute("read", { path: "test.txt" }, controller.signal)).rejects.toThrow(
				"Operation aborted",
			);
			await closed;
		} finally {
			opened.abort = undefined;
			opened.closed = undefined;
			await rm(dir, { recursive: true, force: true });
		}
	});
});
