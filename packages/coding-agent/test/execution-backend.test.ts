import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join as joinPath, posix as posixPath } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { buildSystemPrompt } from "../src/core/system-prompt.ts";
import { inspectToolExecution } from "../src/core/tool-execution-policy.ts";
import { computeEditsDiff } from "../src/core/tools/edit-diff.ts";
import type {
	ExecutionBackend,
	ToolPathContext,
} from "../src/core/tools/execution-backend.ts";
import {
	createAllToolDefinitions,
	createBashToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
} from "../src/core/tools/index.ts";
import { canonicalizePath, resolvePath } from "../src/utils/paths.ts";
import { fauxModel, createFauxStreamFn } from "./test-harness.ts";
import { createTestResourceLoader } from "./utilities.ts";

function makeTempDir(): string {
	const dir = joinPath(tmpdir(), `pi-exec-backend-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function makePosixPathContext(home = "/home/user"): ToolPathContext {
	return {
		pathStyle: "posix",
		homeDir: home,
		resolvePath: (input, cwd) => posixPath.resolve(cwd, input),
	};
}

/** Build a minimal AgentSession wired with a faux model and in-memory deps. */
function makeSession(options: {
	tempDir: string;
	executionBackend?: ExecutionBackend;
	runtimeCwd?: string;
}): AgentSession {
	const { streamFn } = createFauxStreamFn(["ok"]);
	const agent = new Agent({
		getApiKey: () => "faux-key",
		initialState: { model: fauxModel, systemPrompt: "test", tools: [] },
		streamFn,
	});
	const sessionManager = SessionManager.inMemory(options.tempDir);
	const settingsManager = SettingsManager.create(options.tempDir, options.tempDir);
	const authStorage = AuthStorage.create(`${options.tempDir}/auth.json`);
	authStorage.setRuntimeApiKey(fauxModel.provider, "faux-key");
	const modelRegistry = ModelRegistry.create(authStorage, options.tempDir);
	return new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd: options.tempDir,
		runtimeCwd: options.runtimeCwd,
		executionBackend: options.executionBackend,
		modelRegistry,
		resourceLoader: createTestResourceLoader(),
	});
}

describe("execution backend: dual cwd", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = makeTempDir();
	});

	afterEach(() => {
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	it("separates runtime cwd from host cwd via backend.getCwd", async () => {
		let recordedCwd: string | undefined;
		const backend: ExecutionBackend = {
			paths: makePosixPathContext(),
			getCwd: () => "/home/user/project",
			bash: {
				exec: async (_command, cwd, { onData }) => {
					recordedCwd = cwd;
					onData(Buffer.from(""));
					return { exitCode: 0 };
				},
			},
		};
		const session = makeSession({ tempDir, executionBackend: backend, runtimeCwd: "/home/user/project" });
		try {
			await session.executeBash("pwd");
			// executeBash uses the runtime (logical) cwd, not the host cwd.
			expect(recordedCwd).toBe("/home/user/project");
			// SessionManager is built from host cwd and stays on the physical path.
			expect(session.sessionManager.getCwd()).toBe(tempDir);
		} finally {
			await session.dispose();
		}
	});

	it("without backend, runtimeCwd === hostCwd and sessionManager.getCwd() === cwd", async () => {
		let recordedCwd: string | undefined;
		const session = makeSession({ tempDir });
		// Patch the bash tool fallback to observe the cwd without spawning a real shell.
		const bashDef = session.getToolDefinition("bash");
		expect(bashDef).toBeDefined();
		// executeBash uses createLocalBashOperations({ shellPath }) by default; we instead
		// drive the tool definition directly with a fake operations to observe the cwd.
		const fakeBashDef = createBashToolDefinition(tempDir, {
			operations: {
				exec: async (_command, cwd, { onData }) => {
					recordedCwd = cwd;
					onData(Buffer.from(""));
					return { exitCode: 0 };
				},
			},
		});
		await fakeBashDef.execute("tc", { command: "pwd" }, undefined);
		expect(recordedCwd).toBe(tempDir);
		expect(session.sessionManager.getCwd()).toBe(tempDir);
		await session.dispose();
	});

	it("reload keeps the same backend reference", async () => {
		let calls = 0;
		const backend: ExecutionBackend = {
			paths: makePosixPathContext(),
			getCwd: () => "/home/user/project",
			bash: {
				exec: async (_command, _cwd, { onData }) => {
					calls++;
					onData(Buffer.from(""));
					return { exitCode: 0 };
				},
			},
		};
		const session = makeSession({ tempDir, executionBackend: backend, runtimeCwd: "/home/user/project" });
		try {
			await session.executeBash("pwd");
			const callsBefore = calls;
			await session.reload();
			await session.executeBash("pwd");
			// The same backend bash operations instance is still in use after reload.
			expect(calls).toBe(callsBefore + 1);
		} finally {
			await session.dispose();
		}
	});
});

describe("execution backend: merge helper preserves per-tool fields", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = makeTempDir();
	});

	afterEach(() => {
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	it("preserves commandPrefix and uses per-tool operations over backend", async () => {
		let recordedCommand: string | undefined;
		const backendBash = {
			exec: async () => ({ exitCode: 0 }),
		};
		const perToolBash = {
			exec: async (command: string, _cwd: string, { onData }: { onData: (d: Buffer) => void }) => {
				recordedCommand = command;
				onData(Buffer.from(""));
				return { exitCode: 0 };
			},
		};
		const backend: ExecutionBackend = {
			paths: makePosixPathContext(),
			bash: backendBash,
		};
		const defs = createAllToolDefinitions(tempDir, {
			executionBackend: backend,
			bash: { operations: perToolBash, commandPrefix: "echo PREFIX" },
		});
		await defs.bash.execute("tc", { command: "ls" }, undefined);
		// commandPrefix is preserved by the spread and applied.
		expect(recordedCommand).toBe("echo PREFIX\nls");
	});

	it("preserves shellPath when backend does not provide bash", async () => {
		// Backend supplies non-bash operations only; per-tool bash carries shellPath.
		// With no operations resolved for bash, createLocalBashOperations({ shellPath })
		// is used, which calls getShellConfig(shellPath) lazily inside exec.
		const backend: ExecutionBackend = {
			paths: makePosixPathContext(),
			read: { readFile: async () => Buffer.from(""), access: async () => undefined },
		};
		const defs = createAllToolDefinitions(tempDir, {
			executionBackend: backend,
			bash: { shellPath: `${tempDir}/nonexistent-bash` },
		});
		await expect(defs.bash.execute("tc", { command: "ls" }, undefined)).rejects.toThrow(
			/Custom shell path not found/,
		);
	});

	it("preserves autoResizeImages for the read tool under a backend", async () => {
		// A 1x1 transparent PNG.
		const png = Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
			"base64",
		);
		const backend: ExecutionBackend = {
			paths: makePosixPathContext(),
			read: {
				readFile: async () => png,
				access: async () => undefined,
				detectImageMimeType: async () => "image/png",
			},
		};
		const defs = createAllToolDefinitions("/home/user/project", {
			executionBackend: backend,
			read: { autoResizeImages: false },
		});
		const result = await defs.read.execute("tc", { path: "img.png" }, undefined);
		const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("");
		// With autoResizeImages disabled, the raw base64 is returned (no resize note).
		expect(text).not.toContain("could not be resized");
		expect(result.content.some((c) => c.type === "image")).toBe(true);
	});

	it("preserves spawnHook and applies it under a backend", async () => {
		// The merge helper must preserve spawnHook (the fourth per-tool field) via
		// the spread, and the bash tool must apply it before delegating to ops.exec.
		let recordedCommand: string | undefined;
		const backendBash = {
			exec: async () => ({ exitCode: 0 }),
		};
		const perToolBash = {
			exec: async (command: string, _cwd: string, { onData }: { onData: (d: Buffer) => void }) => {
				recordedCommand = command;
				onData(Buffer.from(""));
				return { exitCode: 0 };
			},
		};
		const backend: ExecutionBackend = {
			paths: makePosixPathContext(),
			bash: backendBash,
		};
		const defs = createAllToolDefinitions(tempDir, {
			executionBackend: backend,
			bash: {
				operations: perToolBash,
				spawnHook: (ctx) => ({ ...ctx, command: `HOOKED:${ctx.command}` }),
			},
		});
		await defs.bash.execute("tc", { command: "ls" }, undefined);
		// spawnHook is preserved by the spread and applied before ops.exec.
		expect(recordedCommand).toBe("HOOKED:ls");
	});
});

describe("execution backend: POSIX path context", () => {
	it("paths.ts only adds posix? (homeDir already exists) and resolves POSIX", () => {
		// POSIX resolution under a Linux logical cwd.
		expect(resolvePath("foo", "/home/user", { posix: true })).toBe("/home/user/foo");
		expect(resolvePath("~/bar", "/home/user", { posix: true, homeDir: "/home/user" })).toBe(
			"/home/user/bar",
		);
		// Tilde backslash form is a Windows-only quirk and must NOT expand to home under posix.
		expect(resolvePath("~\\bar", "/home/user", { posix: true, homeDir: "/home/user" })).not.toBe(
			"/home/user/bar",
		);
		// canonicalizePath skips host realpath in posix mode (Linux logical paths).
		expect(canonicalizePath("/home/user/project", { posix: true })).toBe("/home/user/project");
	});

	it("ls uses path.posix.join under a POSIX path context (stat fallback)", async () => {
		const statPaths: string[] = [];
		const lsDef = createLsToolDefinition("/home/user/project", {
			operations: {
				exists: async () => true,
				stat: async (p: string) => {
					statPaths.push(p);
					// The directory itself is a directory; entries are files.
					return { isDirectory: () => p === "/home/user/project" };
				},
				readdir: async () => ["foo", "bar"],
			},
			pathContext: makePosixPathContext(),
		});
		await lsDef.execute("tc", { path: "." }, undefined);
		// win32 join would mangle these to backslashes; posix join keeps forward slashes.
		expect(statPaths).toContain("/home/user/project/foo");
		expect(statPaths).toContain("/home/user/project/bar");
		expect(statPaths.every((p) => !p.includes("\\"))).toBe(true);
	});

	it("tool-execution-policy rejects Windows drive/UNC paths in WSL mode", () => {
		const paths = makePosixPathContext();
		const driveDecision = inspectToolExecution({
			mode: "approval",
			toolName: "write",
			args: { path: "C:\\Users\\x\\file.txt", content: "x" },
			cwd: "/home/user/project",
			pathContext: paths,
		});
		expect(driveDecision.allowed).toBe(false);
		expect(driveDecision.reason).toContain("WSL mode");
		const uncDecision = inspectToolExecution({
			mode: "approval",
			toolName: "edit",
			args: { path: "\\\\wsl.localhost\\Ubuntu\\home\\x", edits: [] },
			cwd: "/home/user/project",
			pathContext: paths,
		});
		expect(uncDecision.allowed).toBe(false);
		// A normal Linux relative path is allowed.
		const ok = inspectToolExecution({
			mode: "approval",
			toolName: "write",
			args: { path: "src/file.txt", content: "x" },
			cwd: "/home/user/project",
			pathContext: paths,
		});
		expect(ok.allowed).toBe(true);
	});
});

describe("execution backend: edit-diff preview reads via operations", () => {
	it("uses injected operations and path context instead of host fs", async () => {
		const access = vi.fn().mockResolvedValue(undefined);
		const readFile = vi.fn().mockResolvedValue(Buffer.from("hello\nworld\n"));
		const result = await computeEditsDiff(
			"foo.txt",
			[{ oldText: "hello", newText: "hi" }],
			"/home/user/project",
			{
				operations: { access, readFile },
				paths: makePosixPathContext(),
			},
		);
		expect(access).toHaveBeenCalledWith("/home/user/project/foo.txt");
		expect(readFile).toHaveBeenCalledWith("/home/user/project/foo.txt");
		expect("error" in result).toBe(false);
		expect("diff" in result && result.diff).toBeTruthy();
	});

	it("3-arg call without options still works (local-fs default)", async () => {
		// Out-of-scope callers pass (path, edits, cwd) and get local-fs behavior.
		const result = await computeEditsDiff(
			"definitely-missing-file.txt",
			[{ oldText: "a", newText: "b" }],
			"/tmp",
		);
		expect("error" in result).toBe(true);
	});
});

describe("execution backend: WSL system prompt", () => {
	it("contains Linux guidance and not Windows-only /dev/null text", () => {
		const prompt = buildSystemPrompt({
			cwd: "/home/user/project",
			runtimeEnvironment: {
				platform: "linux",
				osName: "WSL2 (Ubuntu-22.04)",
				shell: { kind: "wsl", path: "wsl.exe" },
			},
			selectedTools: ["read", "bash", "edit", "write"],
			contextFiles: [],
			skills: [],
		});
		expect(prompt).toContain("WSL");
		expect(prompt).toContain("Linux");
		// Windows-only /dev/null guidance must be absent under WSL.
		expect(prompt).not.toContain("On Windows bash/POSIX shells, discard output with /dev/null");
		expect(prompt).not.toContain("Windows bash guidance: use /dev/null");
		// The /mnt/<drive> NTFS reserved-name warning is retained.
		expect(prompt).toContain("/mnt/<drive>/");
	});

	it("keeps Windows /dev/null guidance when no WSL override is present", () => {
		const prompt = buildSystemPrompt({
			cwd: "C:\\project",
			runtimeEnvironment: {
				platform: "win32",
				shell: { kind: "posix", path: "C:\\Program Files\\Git\\bin\\bash.exe" },
			},
			selectedTools: ["read", "bash", "edit", "write"],
			contextFiles: [],
			skills: [],
		});
		expect(prompt).toContain("On Windows bash/POSIX shells, discard output with /dev/null");
	});
});

describe("execution backend: Windows fallback unchanged", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = makeTempDir();
		writeFileSync(`${tempDir}/a.txt`, "apple\napricot\nbanana\n");
		writeFileSync(`${tempDir}/b.txt`, "cherry\n");
		mkdirSync(`${tempDir}/sub`, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	/**
	 * Build a fake spawnRipgrep that emits the given rg JSON lines on stdout.
	 * This exercises the same readline/JSON/limit/context parsing the local
	 * Windows fallback uses, without depending on a host rg binary.
	 */
	function fakeRipgrep(
		jsonLines: string[],
	): (args: string[], cwd: string, env: NodeJS.ProcessEnv) => ChildProcessWithoutNullStreams {
		return (_args: string[], _cwd: string, _env: NodeJS.ProcessEnv) => {
			const code = "const d=process.env.PI_TEST_RG;for(const l of JSON.parse(d))process.stdout.write(l+'\\n');";
			const child = spawn("node", ["-e", code], {
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env, PI_TEST_RG: JSON.stringify(jsonLines) },
			}) as unknown as ChildProcessWithoutNullStreams;
			return child;
		};
	}

	function matchEvent(filePath: string, lineNumber: number, lineText: string): string {
		return JSON.stringify({
			type: "match",
			data: { path: { text: filePath }, line_number: lineNumber, lines: { text: `${lineText}\n` } },
		});
	}

	it("grep returns JSON-derived matches with limit and context (local fallback)", async () => {
		const aTxt = `${tempDir}/a.txt`.replace(/\\/g, "/");
		const grepDef = createGrepToolDefinition(tempDir, {
			operations: {
				isDirectory: async () => true,
				readFile: async () => "apple\napricot\nbanana\n",
				spawnRipgrep: fakeRipgrep([
					matchEvent(aTxt, 1, "apple"),
					matchEvent(aTxt, 2, "apricot"),
				]),
			},
		});
		const result = await grepDef.execute("tc", { pattern: "ap", path: ".", limit: 1 }, undefined);
		const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("");
		expect(text).toContain("a.txt:1: apple");
		expect(text).toContain("1 matches limit");
	});

	it("grep context lines are emitted when context > 0 (local fallback)", async () => {
		const aTxt = `${tempDir}/a.txt`.replace(/\\/g, "/");
		const grepDef = createGrepToolDefinition(tempDir, {
			operations: {
				isDirectory: async () => true,
				readFile: async () => "apple\napricot\nbanana\n",
				spawnRipgrep: fakeRipgrep([matchEvent(aTxt, 3, "banana")]),
			},
		});
		const result = await grepDef.execute(
			"tc",
			{ pattern: "banana", path: ".", context: 1 },
			undefined,
		);
		const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("");
		// Context separator line before the match.
		expect(text).toContain("a.txt-2- apricot");
		expect(text).toContain("a.txt:3: banana");
	});

	it("ls stat fallback marks directories with '/' (no readdirWithTypes)", async () => {
		const lsDef = createAllToolDefinitions(tempDir, {}).ls;
		const result = await lsDef.execute("tc", { path: "." }, undefined);
		const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("");
		expect(text).toContain("sub/");
		expect(text).toContain("a.txt");
	});
});

describe("execution backend: Windows no-backend snapshot regression", () => {
	// S10: when no backend is injected, runtimeCwd === hostCwd and the §4.1
	// redirect table is a byte-level no-op. executeBash, the system prompt, and
	// the approval policy all read _runtimeCwd, which equals this._cwd (hostCwd);
	// SessionManager is built from config.cwd and stays on the host path.
	let tempDir: string;

	beforeEach(() => {
		tempDir = makeTempDir();
	});

	afterEach(() => {
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	it("runtimeCwd === hostCwd across the §4.1 redirect table (no backend)", async () => {
		let recordedCwd: string | undefined;
		const session = makeSession({ tempDir });
		try {
			// SessionManager is built from host cwd (config.cwd) and stays there.
			expect(session.sessionManager.getCwd()).toBe(tempDir);
			// executeBash reads _runtimeCwd, which equals hostCwd when no backend.
			await session.executeBash("pwd", undefined, {
				operations: {
					exec: async (_command, cwd, { onData }) => {
						recordedCwd = cwd;
						onData(Buffer.from(""));
						return { exitCode: 0 };
					},
				},
			});
			expect(recordedCwd).toBe(tempDir);
			// _rebuildSystemPrompt reads _runtimeCwd; the prompt embeds it as the cwd
			// (forward-slash normalized). This anchors the approval-policy /
			// export-html redirect which also use _runtimeCwd.
			const promptCwd = tempDir.replace(/\\/g, "/");
			expect(session.systemPrompt).toContain(`Current working directory: ${promptCwd}`);
		} finally {
			await session.dispose();
		}
	});

	it("reload preserves runtimeCwd === hostCwd without a backend", async () => {
		let recordedCwd: string | undefined;
		const session = makeSession({ tempDir });
		try {
			await session.reload();
			await session.executeBash("pwd", undefined, {
				operations: {
					exec: async (_command, cwd, { onData }) => {
						recordedCwd = cwd;
						onData(Buffer.from(""));
						return { exitCode: 0 };
					},
				},
			});
			expect(recordedCwd).toBe(tempDir);
			expect(session.sessionManager.getCwd()).toBe(tempDir);
		} finally {
			await session.dispose();
		}
	});
});
