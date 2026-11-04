/**
 * McpDriverClient tests.
 *
 * Drives the REAL client against a REAL child process: the MCP stdio fake driver in
 * `fixtures/fake-cua-driver.mjs` (spawned through `process.execPath`, since Windows cannot exec the
 * .mjs file directly). Covered: handshake + tools/list caching, `getToolInputSchema` required /
 * properties, the driver_incompatible code + detail on missing DRIVER_REQUIRED_TOOLS, the allowlist guard,
 * unsupported_on_platform, timeout vs caller abort vs cancelAll classification, crash detection with
 * backoff restart, the 3-crash fuse plus stop()/ensureStarted() recovery, stop() → idle, env
 * inheritance (DRIVER_CHILD_ENV + parent markers), the default `mcp --direct` argv, the pass-through
 * outputSchema validator (a driver result that violates its declared outputSchema, and a tool that
 * declares an outputSchema but omits structuredContent entirely — both SDK callTool guards),
 * isError passthrough, content block mapping (text + image) and spawn / handshake failures.
 *
 * Run with: npm exec tsx -- src/main/__tests__/computer-use-driver-client.test.ts
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ComputerUseError, type DriverClientState } from "../computer-use/contracts.js";
import { capDriverFailureDetail, McpDriverClient, type McpDriverClientOptions } from "../computer-use/mcp-driver-client.js";
import { DRIVER_MCP_ARGS, DRIVER_REQUIRED_TOOLS } from "../computer-use/driver-manifest.js";

// ============================================================================
// Test harness (todo-ipc.test.ts style)
// ============================================================================

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
	if (condition) {
		passed++;
		console.log(`  PASS: ${message}`);
	} else {
		failed++;
		console.error(`  FAIL: ${message}`);
	}
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
	if (actual === expected) {
		passed++;
		console.log(`  PASS: ${message}`);
	} else {
		failed++;
		console.error(`  FAIL: ${message} - expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
	}
}

function assertDeepEqual(actual: unknown, expected: unknown, message: string): void {
	const actualJson = JSON.stringify(actual);
	const expectedJson = JSON.stringify(expected);
	if (actualJson === expectedJson) {
		passed++;
		console.log(`  PASS: ${message}`);
	} else {
		failed++;
		console.error(`  FAIL: ${message} - expected ${expectedJson}, got ${actualJson}`);
	}
}

async function run(name: string, fn: () => Promise<void>): Promise<void> {
	console.log(`\n=== ${name} ===\n`);
	try {
		await fn();
	} catch (err) {
		failed++;
		console.error(`  FAIL: ${name} threw unexpectedly: ${String(err)}`);
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** ComputerUseError code of a captured rejection, or a marker string when it is a different error. */
function codeOf(value: unknown): string {
	if (value instanceof ComputerUseError) {
		return value.code;
	}
	return value === null || value === undefined ? "<resolved>" : `<${String(value)}>`;
}

async function captureError(fn: () => Promise<unknown>): Promise<unknown> {
	try {
		await fn();
		return null;
	} catch (error) {
		return error;
	}
}

/**
 * Resolve on the NEXT transition into `want` (never on an already-settled state) — the crash tests
 * must distinguish "already ready" from "restarted after the crash".
 */
function nextState(client: McpDriverClient, want: DriverClientState, timeoutMs: number): Promise<boolean> {
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			unsubscribe();
			resolve(false);
		}, timeoutMs);
		const unsubscribe = client.onStateChange((state) => {
			if (state === want) {
				clearTimeout(timer);
				unsubscribe();
				resolve(true);
			}
		});
	});
}

// ============================================================================
// Fixture plumbing
// ============================================================================

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const FAKE_DRIVER_SCRIPT = join(FIXTURES_DIR, "fake-cua-driver.mjs");

const tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pix-computer-use-client-"));
	tempDirs.push(dir);
	return dir;
}

interface DriverReportLine {
	phase: string;
	pid: number;
	argv?: string[];
	env?: Record<string, string | number>;
	tools?: string[];
	clientInfo?: { name: string; version: string };
}

function readReport(reportPath: string): DriverReportLine[] {
	if (!existsSync(reportPath)) {
		return [];
	}
	return readFileSync(reportPath, "utf8")
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as DriverReportLine);
}

/**
 * Client under test: `process.execPath` as the executable and the fixture path plus the production
 * `DRIVER_MCP_ARGS` as argv, so the child's driver-side argv is exactly `mcp --direct`.
 */
function makeClient(
	extraEnv: Record<string, string> = {},
	overrides: Partial<McpDriverClientOptions> = {},
): { client: McpDriverClient; reportPath: string } {
	const dir = makeTempDir();
	const reportPath = join(dir, "driver-report.jsonl");
	const client = new McpDriverClient({
		executablePath: process.execPath,
		cwd: FIXTURES_DIR,
		args: [FAKE_DRIVER_SCRIPT, ...DRIVER_MCP_ARGS],
		extraEnv: { FAKE_DRIVER_REPORT: reportPath, ...extraEnv },
		startTimeoutMs: 8_000,
		defaultCallTimeoutMs: 4_000,
		...overrides,
	});
	return { client, reportPath };
}

// ============================================================================

await run("ensureStarted performs the handshake and caches tools/list", async () => {
	const { client, reportPath } = makeClient();
	const states: DriverClientState[] = [];
	client.onStateChange((state) => states.push(state));
	try {
		await client.ensureStarted();
		assertEqual(client.state, "ready", "state is ready after ensureStarted");
		const names = client.listToolNames();
		for (const required of DRIVER_REQUIRED_TOOLS) {
			assert(names.has(required), `tools/list exposes ${required}`);
		}
		assert(names.has("launch_app"), "tools/list also exposes tools outside DRIVER_REQUIRED_TOOLS");
		const schema = client.getToolInputSchema("get_window_state");
		assert(schema !== null, "getToolInputSchema returns a schema for a listed tool");
		assertDeepEqual(schema?.required, ["pid", "window_id"], "required comes from inputSchema.required");
		assert(
			schema?.properties.has("query") === true && schema?.properties.has("max_elements") === true,
			"properties carries the inputSchema property keys",
		);
		assertEqual(client.getToolInputSchema("no_such_tool"), null, "unknown tool schema is null");
		assertDeepEqual(states, ["starting", "ready"], "state sequence idle → starting → ready");
		assertEqual(readReport(reportPath).filter((line) => line.phase === "start").length, 1, "exactly one child process was spawned");
	} finally {
		await client.stop();
	}
	assertEqual(client.state, "idle", "stop() returns the client to idle");
});

await run("child env inherits the filtered parent env plus DRIVER_CHILD_ENV", async () => {
	// PIX_TEST_MARKER goes through process.env itself (not makeClient's extraEnv), so the
	// assertion proves real parent-process env inheritance rather than the test-injection path.
	const { client, reportPath } = makeClient();
	process.env.PIX_TEST_MARKER = "pix-marker-42";
	try {
		await client.ensureStarted();
		const start = readReport(reportPath).find((line) => line.phase === "start");
		assert(start !== undefined, "the fake driver wrote its startup report");
		const env = start?.env ?? {};
		assertEqual(env.PIX_TEST_MARKER, "pix-marker-42", "a parent env var reaches the child (env inheritance)");
		assertEqual(env.CUA_DRIVER_RS_TELEMETRY_ENABLED, "0", "driver telemetry is disabled in the child");
		assertEqual(env.DO_NOT_TRACK, "1", "DO_NOT_TRACK=1 in the child");
		assertEqual(env.CUA_DRIVER_RS_UPDATE_CHECK, "0", "driver update check is disabled in the child");
		// Sensitive parent keys are stripped before the merge, so the count
		// floor is the parent env minus credential-looking keys (plus the layered
		// DRIVER_CHILD_ENV / extraEnv entries, which never match the filter).
		const sensitive = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|COOKIE/i;
		const expectedParentEntries = Object.keys(process.env).filter((key) => !sensitive.test(key)).length;
		assert(
			typeof env.envCount === "number" && env.envCount >= expectedParentEntries,
			"the child env carries at least every non-sensitive parent variable",
		);
		assertDeepEqual((start?.argv ?? []).slice(1), ["mcp", "--direct"], "driver-side argv is mcp --direct");
		assertEqual(basename((start?.argv ?? [])[0] ?? ""), "fake-cua-driver.mjs", "the child entry is the fixture script");
	} finally {
		delete process.env.PIX_TEST_MARKER;
		await client.stop();
	}
});

await run("sensitive parent env keys are stripped from the driver child env", async () => {
	// The driver binary is downloaded at runtime and is foreign code: credential-
	// looking parent variables (ANTHROPIC_API_KEY and friends) must never be
	// handed to it, while ordinary variables survive the filter.
	const { client, reportPath } = makeClient();
	process.env.PIX_TEST_API_KEY = "sk-test-do-not-leak";
	process.env.PIX_TEST_PLAIN = "plain-value-42";
	try {
		await client.ensureStarted();
		const start = readReport(reportPath).find((line) => line.phase === "start");
		assert(start !== undefined, "the fake driver wrote its startup report");
		const env = start?.env ?? {};
		assert(env.PIX_TEST_API_KEY === undefined, "a KEY-matching parent variable is absent from the child env");
		assertEqual(env.PIX_TEST_PLAIN, "plain-value-42", "a non-sensitive parent variable is inherited");
	} finally {
		delete process.env.PIX_TEST_API_KEY;
		delete process.env.PIX_TEST_PLAIN;
		await client.stop();
	}
});

await run("capDriverFailureDetail: model-visible stderr budget", async () => {
	assertEqual(capDriverFailureDetail(""), "", "empty text stays empty");
	assertEqual(capDriverFailureDetail("short failure"), "short failure", "text within the budget passes through verbatim");
	const atBudget = "y".repeat(2_048);
	assertEqual(capDriverFailureDetail(atBudget), atBudget, "exactly-at-budget text passes through unmarked");
	const long = `${"h".repeat(2_048)}TAIL`;
	const capped = capDriverFailureDetail(long);
	assertEqual(capped.length, 2_048, "the default budget is 2048 characters");
	assert(capped.startsWith("…"), "truncation is marked with a leading ellipsis");
	assert(capped.endsWith("TAIL"), "the TAIL (most recent output) is what survives");
	assertEqual(capDriverFailureDetail(long, 10).length, 10, "a custom budget is honored");
	assertEqual(capDriverFailureDetail(long, 0), "", "a zero budget yields the empty string");
});

await run("a start failure caps the model-visible detail but keeps the full tail in the state", async () => {
	// A child that floods stderr and never answers the handshake: the rejected
	// error (whose detail becomes the model-visible message) is capped, while
	// the failed-state detail keeps the complete tail for the service to show.
	const dir = makeTempDir();
	const script = join(dir, "noisy-driver.mjs");
	const banner = "E".repeat(5_000);
	writeFileSync(script, `process.stderr.write(${JSON.stringify(banner)});\nsetInterval(() => {}, 1000);\n`);
	const client = new McpDriverClient({
		executablePath: process.execPath,
		cwd: dir,
		args: [script, ...DRIVER_MCP_ARGS],
		startTimeoutMs: 1_500,
	});
	let stateDetail = "";
	client.onStateChange((state, detail) => {
		if (state === "failed") stateDetail = detail ?? "";
	});
	try {
		const error = await captureError(() => client.ensureStarted());
		assert(error instanceof ComputerUseError, "the noisy non-driver start rejects");
		const detail = error instanceof ComputerUseError ? error.detail : "";
		assertEqual(detail.length, 2_048, "the model-visible detail is capped at 2048 characters");
		assert(detail.startsWith("…") && detail.endsWith("E"), "the capped detail keeps the stderr tail");
		assertEqual(stateDetail.length, 5_000, "the failed-state detail keeps the FULL 5000-char tail");
	} finally {
		await client.stop();
	}
});

await run("clientVersion: injected value is used, default falls back", async () => {
	const injected = makeClient({}, { clientVersion: "9.9.9-testpix" });
	try {
		await injected.client.ensureStarted();
		assertEqual(injected.client.state, "ready", "an injected version still completes the handshake");
		const init = readReport(injected.reportPath).find((line) => line.phase === "initialized");
		assertEqual(init?.clientInfo?.version, "9.9.9-testpix", "an injected clientVersion is sent as clientInfo.version in the handshake");
	} finally {
		await injected.client.stop();
	}
	const fallback = makeClient();
	try {
		await fallback.client.ensureStarted();
		const init = readReport(fallback.reportPath).find((line) => line.phase === "initialized");
		assertEqual(init?.clientInfo?.version, "1.5.0", "without injection the built-in default is sent as clientInfo.version");
	} finally {
		await fallback.client.stop();
	}
});

await run("args default to DRIVER_MCP_ARGS (node resolves the extensionless mcp entry)", async () => {
	const dir = makeTempDir();
	const reportPath = join(dir, "driver-report.jsonl");
	// No `args`: the client must spawn `<executablePath> mcp --direct`, and cwd makes node resolve the
	// extensionless `mcp` fixture for the "mcp" argument.
	const client = new McpDriverClient({
		executablePath: process.execPath,
		cwd: FIXTURES_DIR,
		extraEnv: { FAKE_DRIVER_REPORT: reportPath },
		startTimeoutMs: 8_000,
	});
	try {
		await client.ensureStarted();
		assertEqual(client.state, "ready", "the default-argv child completes the handshake");
		const start = readReport(reportPath).find((line) => line.phase === "start");
		const argv = start?.argv ?? [];
		assertEqual(basename(argv[0] ?? ""), "mcp", "the default argv starts with the driver entry `mcp`");
		assertDeepEqual(argv.slice(1), ["--direct"], "the remaining default argv is --direct");
		assertDeepEqual(DRIVER_MCP_ARGS, ["mcp", "--direct"], "DRIVER_MCP_ARGS is the default that was used");
	} finally {
		await client.stop();
	}
});

await run("missing DRIVER_REQUIRED_TOOLS fail the start with the driver_incompatible detail", async () => {
	const { client } = makeClient({ FAKE_DRIVER_OMIT_TOOLS: "hotkey,scroll" });
	const failures: Array<{ state: DriverClientState; detail: string | undefined }> = [];
	client.onStateChange((state, detail) => {
		if (state === "failed") {
			failures.push({ state, detail });
		}
	});
	try {
		const error = await captureError(() => client.ensureStarted());
		assert(error instanceof ComputerUseError, "ensureStarted rejects a ComputerUseError");
		assertEqual(codeOf(error), "driver_incompatible", "missing REQUIRED tools reject driver_incompatible (the §4.1 error code, §4.5 start failure)");
		const detail = error instanceof ComputerUseError ? error.detail : "";
		assert(
			detail.startsWith("driver_incompatible: missing "),
			`the detail carries the §4.5 driver_incompatible prefix (got "${detail}")`,
		);
		assert(detail.includes("hotkey") && detail.includes("scroll"), "the detail names the missing tools");
		assertEqual(client.state, "failed", "state is failed (no automatic retry)");
		assertEqual(failures.length, 1, "one failed transition was reported");
		assert(
			(failures[0]?.detail ?? "").startsWith("driver_incompatible: missing "),
			"the failed state detail starts with driver_incompatible (what §4.7 row 5 maps from)",
		);
		const second = await captureError(() => client.ensureStarted());
		assertEqual(codeOf(second), "driver_incompatible", "a failed client keeps rejecting with the recorded failure code");
	} finally {
		await client.stop();
	}
	assertEqual(client.state, "idle", "stop() recovers a failed client to idle");
});

await run("callTool refuses non-allowlisted driver tools with a plain Error", async () => {
	const { client } = makeClient();
	try {
		await client.ensureStarted();
		for (const forbidden of ["set_config", "kill_app", "clipboard_read", "browser_navigate"]) {
			const error = await captureError(() => client.callTool(forbidden, {}));
			assert(error instanceof Error, `${forbidden} is rejected`);
			assert(!(error instanceof ComputerUseError), `${forbidden} throws a programming Error, not a ComputerUseError`);
			assert(
				(error instanceof Error ? error.message : "").includes("DRIVER_TOOL_ALLOWLIST"),
				`${forbidden} rejection names the allowlist`,
			);
		}
	} finally {
		await client.stop();
	}
});

await run("allowlisted tools missing from tools/list reject as unsupported_on_platform", async () => {
	const { client } = makeClient({ FAKE_DRIVER_OMIT_TOOLS: "launch_app,drag,zoom" });
	try {
		await client.ensureStarted();
		assertEqual(client.state, "ready", "REQUIRED tools are present even when optional tools are missing");
		const error = await captureError(() => client.callTool("launch_app", { app: "Files" }));
		assert(error instanceof ComputerUseError, "an unlisted tool rejects a ComputerUseError");
		assertEqual(codeOf(error), "unsupported_on_platform", "code is unsupported_on_platform");
	} finally {
		await client.stop();
	}
});

await run("slow driver calls map to timeout and keep the connection alive", async () => {
	const { client } = makeClient({ FAKE_DRIVER_DELAYS: "get_desktop_state=1500" });
	try {
		await client.ensureStarted();
		const error = await captureError(() => client.callTool("get_desktop_state", {}, { timeoutMs: 250 }));
		assert(error instanceof ComputerUseError, "a slow call rejects a ComputerUseError");
		assertEqual(codeOf(error), "timeout", "code is timeout (not cancelled)");
		const after = await client.callTool("list_apps", {});
		assertEqual(after.isError, false, "a later call on the same connection succeeds");
		assertEqual(client.state, "ready", "the client stays ready");
	} finally {
		await client.stop();
	}
});

await run("caller abort maps to cancelled, never timeout", async () => {
	const { client } = makeClient({ FAKE_DRIVER_DELAYS: "get_desktop_state=1500" });
	try {
		await client.ensureStarted();
		const controller = new AbortController();
		const pending = client.callTool("get_desktop_state", {}, { signal: controller.signal, timeoutMs: 3_000 });
		setTimeout(() => controller.abort(), 120);
		const error = await captureError(() => pending);
		assert(error instanceof ComputerUseError, "an aborted call rejects a ComputerUseError");
		assertEqual(codeOf(error), "cancelled", "code is cancelled although the SDK reports aborts as McpError -32001");
		const preAborted = new AbortController();
		preAborted.abort();
		const preError = await captureError(() => client.callTool("list_apps", {}, { signal: preAborted.signal }));
		assertEqual(codeOf(preError), "cancelled", "an already aborted signal rejects as cancelled");
		assertEqual(client.state, "ready", "cancellation leaves the client ready");
	} finally {
		await client.stop();
	}
});

await run("cancelAll aborts every in-flight call", async () => {
	const { client } = makeClient({ FAKE_DRIVER_DELAYS: "get_desktop_state=1500,list_windows=1500" });
	try {
		await client.ensureStarted();
		const first = client.callTool("get_desktop_state", {}, { timeoutMs: 5_000 }).catch((error: unknown) => error);
		const second = client.callTool("list_windows", {}, { timeoutMs: 5_000 }).catch((error: unknown) => error);
		await sleep(120);
		client.cancelAll();
		const [firstResult, secondResult] = await Promise.all([first, second]);
		assertEqual(codeOf(firstResult), "cancelled", "the first in-flight call is cancelled");
		assertEqual(codeOf(secondResult), "cancelled", "the second in-flight call is cancelled");
		assertEqual(client.state, "ready", "cancelAll keeps the connection");
	} finally {
		await client.stop();
	}
});

await run("unexpected child exit rejects in-flight calls and restarts after backoff", async () => {
	const dir = makeTempDir();
	const crashFile = join(dir, "crash-trigger");
	const { client, reportPath } = makeClient({
		FAKE_DRIVER_CRASH_FILE: crashFile,
		FAKE_DRIVER_DELAYS: "get_desktop_state=3000",
	});
	const states: DriverClientState[] = [];
	client.onStateChange((state) => states.push(state));
	try {
		await client.ensureStarted();
		states.length = 0;
		const pending = client.callTool("get_desktop_state", {}, { timeoutMs: 5_000 }).catch((error: unknown) => error);
		await sleep(200); // the call is on the wire and the driver is still sleeping
		const crashed = nextState(client, "crashed", 3_000);
		writeFileSync(crashFile, "crash");
		assert(await crashed, "the unexpected child exit is detected as crashed before the call times out");
		const error = await pending;
		assertEqual(codeOf(error), "driver_crashed", "the in-flight call rejects as driver_crashed (never replayed)");
		assert(await nextState(client, "ready", 6_000), "the client restarts the driver automatically");
		assertDeepEqual(states, ["crashed", "starting", "ready"], "state sequence crashed → starting → ready");
		assertEqual(readReport(reportPath).filter((line) => line.phase === "start").length, 2, "the restart spawned a second child");
		const after = await client.callTool("list_apps", {});
		assertEqual(after.isError, false, "calls succeed again after the restart");
	} finally {
		await client.stop();
	}
});

await run("three crashes inside the fuse window fail the client until stop()", async () => {
	const dir = makeTempDir();
	const crashFile = join(dir, "crash-trigger");
	const { client } = makeClient({ FAKE_DRIVER_CRASH_FILE: crashFile });
	try {
		await client.ensureStarted();
		for (let crash = 1; crash <= 3; crash++) {
			const crashed = nextState(client, "crashed", 3_000);
			const failed = nextState(client, "failed", 8_000);
			writeFileSync(crashFile, "crash");
			assert(await crashed, `crash ${crash} is detected`);
			if (crash < 3) {
				assert(
					await nextState(client, "ready", 6_000),
					`crash ${crash} restarts the driver (backoff ${crash === 1 ? "1s" : "2s"})`,
				);
			} else {
				assert(await failed, "the third crash trips the fuse");
			}
		}
		const error = await captureError(() => client.ensureStarted());
		assertEqual(codeOf(error), "unavailable", "a fused client rejects ensureStarted");
		// The fuse hint must not contradict the detail ("automatic restarts
		// are disabled") by promising an automatic restart.
		const fuseMessage = error instanceof Error ? error.message : "";
		assert(!fuseMessage.includes("restarts automatically"), "the fuse hint no longer promises an automatic restart (F4)");
		assert(fuseMessage.includes("Automatic restarts are disabled"), "the fuse hint names the disabled restarts and the manual retry");
		assertEqual(client.state, "failed", "the client stays failed");
		await client.stop();
		assertEqual(client.state, "idle", "stop() clears the fuse");
		await client.ensureStarted();
		assertEqual(client.state, "ready", "stop() + ensureStarted() is the documented recovery");
	} finally {
		await client.stop();
	}
});

await run("structuredContent violating the declared outputSchema is passed through", async () => {
	const { client } = makeClient();
	try {
		await client.ensureStarted();
		const result = await client.callTool("get_window_state", { pid: 42, window_id: 7 });
		assertEqual(result.isError, false, "the call succeeds although structuredContent breaks the outputSchema");
		assertEqual(result.structuredContent?.capture_id, "fake-cap-1", "structuredContent is passed through verbatim");
		assertEqual(
			result.structuredContent?.driver_unexpected_field,
			"schema drift",
			"the outputSchema-violating field survives (pass-through validator, §4.5)",
		);
		const textBlock = result.content.find((block) => block.type === "text");
		assert(
			textBlock !== undefined && textBlock.type === "text" && textBlock.text.includes("fake get_window_state ok"),
			"text content blocks are mapped onto DriverToolResult.content",
		);
		const desktop = await client.callTool("get_desktop_state", {});
		const imageBlock = desktop.content.find((block) => block.type === "image");
		assert(
			imageBlock !== undefined && imageBlock.type === "image"
				&& imageBlock.mimeType === "image/png" && imageBlock.data.length > 0,
			"image content blocks are mapped onto DriverToolResult.content",
		);
	} finally {
		await client.stop();
	}
});

await run("a tool that declares an outputSchema but omits structuredContent still succeeds", async () => {
	// SDK guard 2: stock callTool throws "has an output schema but did not return structured content"
	// for a successful result without structuredContent (client/index.js:490-521). The null
	// pass-through validator short-circuits it too; otherwise an already executed action would be
	// misreported as failed and invite a duplicate action.
	const { client } = makeClient({ FAKE_DRIVER_OMIT_STRUCTURED_CONTENT: "1" });
	try {
		await client.ensureStarted();
		const result = await client.callTool("get_window_state", { pid: 42, window_id: 7 });
		assertEqual(result.isError, false, "the call succeeds although structuredContent is omitted");
		assertEqual(result.structuredContent, undefined, "structuredContent stays undefined (parsed defensively downstream)");
		const textBlock = result.content.find((block) => block.type === "text");
		assert(
			textBlock !== undefined && textBlock.type === "text" && textBlock.text.includes("fake get_window_state ok"),
			"the executed action's text result survives (no duplicate-action invitation)",
		);
	} finally {
		await client.stop();
	}
});

await run("driver isError results are returned, not thrown", async () => {
	const { client } = makeClient({ FAKE_DRIVER_ERROR_TOOLS: "click" });
	try {
		await client.ensureStarted();
		const result = await client.callTool("click", { x: 1, y: 2 });
		assertEqual(result.isError, true, "isError is passed through");
		const textBlock = result.content.find((block) => block.type === "text");
		assert(
			textBlock !== undefined && textBlock.type === "text" && textBlock.text.includes("failed on purpose"),
			"the driver's error text is preserved for the backend to classify",
		);
	} finally {
		await client.stop();
	}
});

await run("spawn failure fails the start without retries", async () => {
	const dir = makeTempDir();
	const client = new McpDriverClient({
		executablePath: join(dir, "no-such-driver-binary.exe"),
		cwd: dir,
		startTimeoutMs: 8_000,
	});
	try {
		const error = await captureError(() => client.ensureStarted());
		assertEqual(codeOf(error), "unavailable", "a spawn failure rejects unavailable");
		assertEqual(client.state, "failed", "state is failed");
		assert(
			error instanceof ComputerUseError && error.detail.length > 0,
			"the failure detail carries diagnostics (stderr tail or the spawn error)",
		);
		const second = await captureError(() => client.ensureStarted());
		assertEqual(codeOf(second), "unavailable", "failed clients do not retry automatically");
	} finally {
		await client.stop();
	}
	assertEqual(client.state, "idle", "stop() returns to idle");
});

await run("handshake timeout fails the start within the start budget", async () => {
	const { client, reportPath } = makeClient({ FAKE_DRIVER_HANDSHAKE_DELAY_MS: "4000" }, { startTimeoutMs: 400 });
	try {
		const started = Date.now();
		const error = await captureError(() => client.ensureStarted());
		const elapsed = Date.now() - started;
		assertEqual(codeOf(error), "unavailable", "a stalled handshake rejects unavailable");
		assertEqual(client.state, "failed", "state is failed");
		assert(elapsed < 3_500, `the start timeout (connect + listTools budget) is honored (took ${elapsed}ms)`);
		assert(
			readReport(reportPath).some((line) => line.phase === "start"),
			"the child was spawned before the handshake stalled",
		);
	} finally {
		await client.stop();
	}
});

await run("ensureStarted is idempotent and stopped clients reject calls", async () => {
	const { client, reportPath } = makeClient();
	try {
		await Promise.all([client.ensureStarted(), client.ensureStarted(), client.ensureStarted()]);
		assertEqual(client.state, "ready", "concurrent ensureStarted calls resolve to ready");
		assertEqual(readReport(reportPath).filter((line) => line.phase === "start").length, 1, "only one child was spawned");
		await client.stop();
		assertEqual(client.state, "idle", "stop() → idle");
		assertEqual(client.listToolNames().size, 0, "the tool cache is cleared on stop");
		const error = await captureError(() => client.callTool("list_apps", {}));
		assertEqual(codeOf(error), "unavailable", "calls on a stopped client reject unavailable");
		await client.ensureStarted();
		assertEqual(client.state, "ready", "ensureStarted() after stop() starts the driver again");
	} finally {
		await client.stop();
	}
});

// ============================================================================

console.log(`\nPassed: ${passed}, Failed: ${failed}`);
for (const dir of tempDirs) {
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {
		// Temp cleanup is best effort.
	}
}
if (failed > 0) {
	process.exit(1);
}
