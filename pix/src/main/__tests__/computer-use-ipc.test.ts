/**
 * Computer-use IPC tests.
 *
 * Covers the computer-use-command IPC contract and the computer-use-event
 * forwarding end-to-end with the INJECTABLE IPC adapter (pure Node, no Electron
 * runtime): guard rejections (invalid command / service missing / service
 * throwing), the get_snapshot data envelope against the REAL ComputerUseService
 * (disabled and unsupported-platform availability rows), the remaining command
 * paths that are pure Node reachable (emergency_stop, open_permission_settings
 * on a non-darwin platform) and event forwarding (snapshot pushes, dropped
 * events while no webContents exists, unsubscribe).
 *
 * IPC harness rule (same as todo-ipc.test.ts): the test
 * registers the REAL production handlers from ipc-computer-use-adapters.ts on a
 * top-level-imported injectable IpcMainLike/WebContentsLike adapter; production
 * registerIpcHandlers passes the real ipcMain / win.webContents. ipc-handlers.ts
 * itself cannot be imported from pure Node (its electron import chain fails to
 * load outside the Electron runtime), so the computer-use registration and
 * dispatch live in a pure module the test imports directly - no mirror, no
 * lockstep.
 *
 * Run with: npm exec tsx -- src/main/__tests__/computer-use-ipc.test.ts
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PixCommandResult } from "../../shared/types.js";
import type {
	ComputerUseEvent,
	ComputerUseSnapshot,
} from "../../shared/computer-use-types.js";
import { ComputerUseService } from "../computer-use/computer-use-service.js";
import {
	registerComputerUseIpcHandlers,
	subscribeComputerUseEventForwarding,
} from "../ipc-computer-use-adapters.js";
import type { IpcMainLike, WebContentsLike } from "../ipc-plan-adapters.js";

// ============================================================================
// Test harness (matches todo-ipc.test.ts style)
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

async function run(name: string, fn: () => Promise<void>): Promise<void> {
	console.log(`\n=== ${name} ===\n`);
	try {
		await fn();
	} catch (err) {
		failed++;
		console.error(`  FAIL: ${name} threw unexpectedly: ${String(err)}`);
	}
}

/**
 * Assert the result is a failure envelope and return it narrowed so callers can
 * inspect code/error (PixCommandResult is a discriminated union).
 */
function assertFailure(
	result: PixCommandResult<unknown>,
	message: string,
): { success: false; error: string; code?: string } {
	if (result.success === false) {
		passed++;
		console.log(`  PASS: ${message}`);
		return result;
	}
	failed++;
	console.error(`  FAIL: ${message} - expected failure envelope, got ${JSON.stringify(result)}`);
	return { success: false, error: "" };
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================================
// Injectable IPC adapter (pure Node; REAL handlers imported from
// ipc-computer-use-adapters.ts - no mirror, no lockstep)
// ============================================================================

class FakeIpcMain implements IpcMainLike {
	private readonly _handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();

	handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void {
		this._handlers.set(channel, listener);
	}

	async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
		const listener = this._handlers.get(channel);
		if (!listener) {
			throw new Error(`No handler registered for channel "${channel}"`);
		}
		return listener({}, ...args);
	}
}

class FakeWebContents implements WebContentsLike {
	readonly sent: Array<{ channel: string; args: unknown[] }> = [];

	send(channel: string, ...args: unknown[]): void {
		this.sent.push({ channel, args });
	}

	eventsOn(channel: string): unknown[] {
		return this.sent.filter((message) => message.channel === channel).map((message) => message.args[0]);
	}
}

// Every throwaway agentDir created by makeService(); removed once at the end of
// the file so no per-case mkdtempSync directory is left behind in os.tmpdir().
const agentDirs: string[] = [];

/**
 * Real service with no Electron surface, a throwaway agentDir (no managed
 * driver present) and an injected platform, so nothing touches the disk driver
 * location or the real cua-driver. `init()` is deliberately not called where
 * the availability row under test does not depend on driver location.
 */
function makeService(settings: { enabled: boolean }, platform: "win32-x64" | null): ComputerUseService {
	const agentDir = mkdtempSync(path.join(tmpdir(), "pix-computer-use-ipc-"));
	agentDirs.push(agentDir);
	return new ComputerUseService({
		agentDir,
		initialSettings: settings,
		platform,
		nodePlatform: "linux",
	});
}

// ============================================================================
// Tests
// ============================================================================

await run("registration: invalid commands rejected with invalid_computer_use_command", async () => {
	const service = makeService({ enabled: false }, null);
	const ipc = new FakeIpcMain();
	registerComputerUseIpcHandlers(ipc, () => service);

	const bogus = (await ipc.invoke("computer-use-command", { type: "bogus" })) as PixCommandResult;
	const bogusFailure = assertFailure(bogus, "unknown type rejected");
	assertEqual(bogusFailure.code, "invalid_computer_use_command", "invalid_computer_use_command code");
	assert(bogusFailure.error.includes("Invalid computer use command"), "error message present");

	const notObject = (await ipc.invoke("computer-use-command", "get_snapshot")) as PixCommandResult;
	const notObjectFailure = assertFailure(notObject, "non-object command rejected");
	assertEqual(notObjectFailure.code, "invalid_computer_use_command", "non-object code");

	// Field-level guard: set_session_enabled requires a boolean `enabled`.
	const badField = (await ipc.invoke("computer-use-command", { type: "set_session_enabled", enabled: "yes" })) as PixCommandResult;
	const badFieldFailure = assertFailure(badField, "invalid field rejected");
	assertEqual(badFieldFailure.code, "invalid_computer_use_command", "invalid field code");

	// open_permission_settings requires the accessibility/screen_recording union.
	const badPermission = (await ipc.invoke("computer-use-command", { type: "open_permission_settings", permission: "camera" })) as PixCommandResult;
	const badPermissionFailure = assertFailure(badPermission, "invalid permission rejected");
	assertEqual(badPermissionFailure.code, "invalid_computer_use_command", "invalid permission code");

	// A payload containing BigInt (structured clone carries it across IPC) makes
	// JSON.stringify throw; the handler must still answer with the failure
	// envelope instead of rejecting (C2). `enabled: 1n` also fails the boolean
	// guard, so the payload is definitely routed into the invalid-command branch.
	const bigint = (await ipc.invoke("computer-use-command", { type: "set_session_enabled", enabled: 1n })) as PixCommandResult;
	const bigintFailure = assertFailure(bigint, "BigInt-bearing command rejected with an envelope, not a throw");
	assertEqual(bigintFailure.code, "invalid_computer_use_command", "BigInt payload code");
	assertEqual(
		bigintFailure.error,
		"Invalid computer use command (unrecognizable payload of type object)",
		"BigInt payload falls back to the type-only error text",
	);
});

await run("computer_use_unavailable when the service getter returns null", async () => {
	const ipc = new FakeIpcMain();
	registerComputerUseIpcHandlers(ipc, () => null);
	const result = (await ipc.invoke("computer-use-command", { type: "get_snapshot" })) as PixCommandResult;
	const failure = assertFailure(result, "envelope failure");
	assertEqual(failure.code, "computer_use_unavailable", "computer_use_unavailable code");
	assert(failure.error.length > 0, "error message present");
});

await run("a throwing service maps to computer_use_command_failed", async () => {
	const ipc = new FakeIpcMain();
	const throwing = {
		execute: async (): Promise<never> => {
			throw new Error("boom");
		},
	} as unknown as ComputerUseService;
	registerComputerUseIpcHandlers(ipc, () => throwing);
	const result = (await ipc.invoke("computer-use-command", { type: "get_snapshot" })) as PixCommandResult;
	const failure = assertFailure(result, "throw mapped to a failure envelope");
	assertEqual(failure.code, "computer_use_command_failed", "computer_use_command_failed code");
	assertEqual(failure.error, "boom", "error text preserved");
});

await run("get_snapshot: data envelope from the real service (disabled)", async () => {
	const service = makeService({ enabled: false }, null);
	const ipc = new FakeIpcMain();
	registerComputerUseIpcHandlers(ipc, () => service);

	const result = (await ipc.invoke("computer-use-command", { type: "get_snapshot" })) as PixCommandResult<ComputerUseSnapshot>;
	assertEqual(result.success, true, "get_snapshot succeeds");
	if (result.success !== true) return;
	const snapshot = result.data!;
	assertEqual(snapshot.availability, "disabled", "global switch off -> disabled");
	assertEqual(snapshot.platform, null, "injected platform surfaced");
	assertEqual(snapshot.session, null, "no foreground controller provider -> null session");
	assertEqual(snapshot.install, null, "no install in flight");
	assertEqual(snapshot.emergencyShortcut, null, "no shortcut without the Electron deps");
	assertEqual(snapshot.driver.expectedVersion, "0.34.1", "driver info carries the expected managed version");
	assert(snapshot.updatedAt > 0, "snapshot timestamp present");
});

await run("get_snapshot: unsupported platform row with enabled global switch", async () => {
	const service = makeService({ enabled: true }, null);
	const ipc = new FakeIpcMain();
	registerComputerUseIpcHandlers(ipc, () => service);

	const result = (await ipc.invoke("computer-use-command", { type: "get_snapshot" })) as PixCommandResult<ComputerUseSnapshot>;
	assertEqual(result.success, true, "get_snapshot succeeds");
	if (result.success !== true) return;
	assertEqual(result.data!.availability, "unsupported_platform", "null platform -> unsupported_platform");
	assertEqual(result.data!.availabilityDetail, "当前平台不受支持", "detail copy");
});

await run("emergency_stop and open_permission_settings dispatch through the real service", async () => {
	const service = makeService({ enabled: true }, null);
	const ipc = new FakeIpcMain();
	registerComputerUseIpcHandlers(ipc, () => service);

	// emergency_stop: no client and no controller registered -> forceRelease +
	// snapshot broadcast; the command still answers with a data envelope.
	const stopped = (await ipc.invoke("computer-use-command", { type: "emergency_stop" })) as PixCommandResult<ComputerUseSnapshot>;
	assertEqual(stopped.success, true, "emergency_stop succeeds");
	if (stopped.success === true) {
		assertEqual(stopped.data!.availability, "unsupported_platform", "emergency_stop returns the current snapshot");
	}

	// open_permission_settings is macOS-only; nodePlatform is linux in the harness.
	const denied = (await ipc.invoke("computer-use-command", {
		type: "open_permission_settings",
		permission: "accessibility",
	})) as PixCommandResult<ComputerUseSnapshot>;
	const deniedFailure = assertFailure(denied, "non-darwin open_permission_settings rejected");
	assertEqual(deniedFailure.code, "unsupported_platform", "unsupported_platform code");
});

await run("event forwarding: snapshot events reach computer-use-event, missing webContents drops them", async () => {
	const service = makeService({ enabled: false }, null);
	const webContents = new FakeWebContents();
	let current: FakeWebContents | null = webContents;
	const unsubscribe = subscribeComputerUseEventForwarding(service, () => current);

	// Every state trigger coalesces into one snapshot event per 50 ms window.
	service.updateSettings({ enabled: true });
	await sleep(160);
	const first = webContents.eventsOn("computer-use-event") as ComputerUseEvent[];
	assertEqual(first.length, 1, "one coalesced snapshot event forwarded");
	assertEqual(first[0]?.type, "snapshot", "event type snapshot");
	if (first[0] !== undefined && first[0].type === "snapshot") {
		assertEqual(first[0].snapshot.availability, "unsupported_platform", "forwarded snapshot carries the new availability");
	}

	// Missing window: the event is dropped, never thrown.
	current = null;
	service.updateSettings({ enabled: false });
	await sleep(160);
	assertEqual(
		webContents.eventsOn("computer-use-event").length,
		1,
		"events are dropped while no webContents exists",
	);

	// Unsubscribe detaches the service listener.
	current = webContents;
	unsubscribe();
	service.updateSettings({ enabled: true });
	await sleep(160);
	assertEqual(
		webContents.eventsOn("computer-use-event").length,
		1,
		"unsubscribe stops forwarding",
	);
});

// ============================================================================

console.log(`\nPassed: ${passed}, Failed: ${failed}`);
for (const dir of agentDirs) {
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {
		// Temp cleanup is best effort (same convention as the e2e harness).
	}
}
if (failed > 0) {
	process.exit(1);
}
