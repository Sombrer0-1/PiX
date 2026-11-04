/**
 * SessionBridge <-> ComputerUseService wiring tests.
 *
 * Constructs the REAL SessionBridge against a temp agent dir and injects a REAL
 * ComputerUseService (pure Node: no electron surface, no driver), then verifies
 * the controller lifecycle across _createSession:
 *  - a candidate create failure BETWEEN createController and the generation
 *    record (injected by making DefaultResourceLoader.reload throw) must dispose
 *    the already-registered controller - otherwise it leaks in the service
 *    registry forever, because _disposeCandidateRuntime only sees
 *    generation.computerUse;
 *  - a successful start registers exactly one controller and bridge dispose
 *    removes it again.
 *
 * Run with: npx tsx src/main/__tests__/computer-use-bridge.test.ts
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import type { ProjectLocation } from "../../shared/types.js";
import { ComputerUseService } from "../computer-use/computer-use-service.js";
import type { ComputerUseSessionController } from "../computer-use/session-controller.js";
import { SessionBridge } from "../session-bridge.js";

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

async function run(name: string, fn: () => Promise<void>): Promise<void> {
	console.log(`\n=== ${name} ===\n`);
	try {
		await fn();
	} catch (err) {
		failed++;
		console.error(`  FAIL: ${name} threw unexpectedly: ${String(err)}`);
	}
}

function drain(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

async function waitFor(condition: () => boolean, iterations = 20000, message = "condition"): Promise<void> {
	for (let i = 0; i < iterations; i++) {
		if (condition()) {
			return;
		}
		await drain();
	}
	throw new Error(`Timed out waiting for ${message}`);
}

const unhandledRejections: unknown[] = [];
process.on("unhandledRejection", (reason: unknown) => {
	unhandledRejections.push(reason);
});

function assertNoUnhandledRejections(): void {
	assertEqual(unhandledRejections.length, 0, "no unhandled rejections observed");
	unhandledRejections.length = 0;
}

// ============================================================================
// Shared temp environment (agentDir + project cwd)
// ============================================================================

const AGENT_DIR = mkdtempSync(join(tmpdir(), "pix-computer-use-bridge-"));
process.env.PI_CODING_AGENT_DIR = AGENT_DIR;
mkdirSync(join(AGENT_DIR, "agents"), { recursive: true });
const PROJECT_CWD = mkdtempSync(join(tmpdir(), "pix-computer-use-bridge-project-"));

writeFileSync(
	join(AGENT_DIR, "models.json"),
	JSON.stringify(
		{
			providers: {
				faux: {
					baseUrl: "http://localhost:1",
					api: "faux-api",
					apiKey: "faux-key",
					models: [
						{
							id: "faux-model",
							name: "Faux Model",
							reasoning: false,
							input: ["text"],
							cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 100000,
							maxTokens: 4096,
						},
					],
				},
			},
		},
		null,
		2,
	),
	"utf-8",
);

function makeLocation(cwd: string = PROJECT_CWD): ProjectLocation {
	return {
		path: cwd,
		physicalPath: cwd,
		name: basename(cwd),
		environment: { kind: "windows" },
	};
}

// ============================================================================
// Real ComputerUseService (pure Node: no electron, no driver, no installer)
// ============================================================================

interface ServiceAccess {
	_controllers: Set<ComputerUseSessionController>;
}

function accessService(service: ComputerUseService): ServiceAccess {
	return service as unknown as ServiceAccess;
}

function makeService(): ComputerUseService {
	return new ComputerUseService({
		agentDir: AGENT_DIR,
		initialSettings: { enabled: true },
		// platform null keeps the service driver/installer free; only the global
		// switch and the controller registry matter here.
		platform: null,
		nodePlatform: "linux",
	});
}

// ============================================================================

await run("create failure after createController disposes the already-registered controller", async () => {
	const service = makeService();
	const access = accessService(service);
	const created: ComputerUseSessionController[] = [];
	const originalCreate = service.createController.bind(service);
	let disposeCalls = 0;
	service.createController = (args: Parameters<typeof originalCreate>[0]) => {
		const controller = originalCreate(args);
		created.push(controller);
		const innerDispose = controller.dispose.bind(controller);
		controller.dispose = async (): Promise<void> => {
			disposeCalls++;
			await innerDispose();
		};
		return controller;
	};

	// Fail _createSession between createController and the generation record:
	// resourceLoader.reload() is the first await after the controller is built.
	const originalReload = DefaultResourceLoader.prototype.reload;
	DefaultResourceLoader.prototype.reload = (async (): Promise<void> => {
		throw new Error("reload failed on purpose");
	}) as typeof originalReload;

	const bridge = new SessionBridge({ computerUseService: service });
	let startError = "";
	try {
		await bridge.start(makeLocation());
	} catch (err) {
		startError = err instanceof Error ? err.message : String(err);
	} finally {
		DefaultResourceLoader.prototype.reload = originalReload;
	}
	assertEqual(startError, "reload failed on purpose", "start rejects when resource loading fails mid-_createSession");
	assertEqual(created.length, 1, "the bridge created the candidate generation's controller before the failure");
	assertEqual(access._controllers.size, 0, "the failed candidate's controller left the service registry (no leak)");
	assert(disposeCalls >= 1, "the leaked controller's dispose was called");

	// The bridge recovers: a fresh start with reload working registers exactly
	// one controller, and bridge dispose removes it again.
	await bridge.start(makeLocation());
	assertEqual(access._controllers.size, 1, "a successful start registers exactly one controller");
	await bridge.dispose();
	await waitFor(() => access._controllers.size === 0, 20000, "controller removal after bridge dispose");
	assertEqual(access._controllers.size, 0, "bridge dispose removes the controller from the registry");
	assertNoUnhandledRejections();
});

// ============================================================================
// (Temp dirs are left to the OS tmp cleaner, matching the other bridge tests.)

console.log(`\nPassed: ${passed}, Failed: ${failed}`);
if (failed > 0) {
	process.exit(1);
}
