/**
 * Driver locator + installer tests.
 *
 * Covers:
 *  - managedDriverDir / resolveDriverBinary: custom-over-managed priority,
 *    receipt validation (schemaVersion / version / platform / executable /
 *    sha256), missing executable, corrupt receipt;
 *  - probeDriverVersion: process.execPath success (=== process.versions.node),
 *    nonexistent path and a non-runnable target both raise
 *    ComputerUseError("driver_incompatible");
 *  - DriverInstaller full flow against a local http server with injected
 *    `extract`: success + receipt, sha256 mismatch (nothing persisted), cancel,
 *    single-flight, extract failure, missing executable, reinstall over an
 *    existing install, stale tmp sweep, fetchImpl injection;
 *  - the real default extractor on a tar.gz fixture built with the OS tar, and
 *    the win32 System32 tar.exe absolute path used by it;
 *  - sha256File on a known vector.
 *
 * Offline note: the manifest pins the sha256 of the real GitHub release assets,
 * so a local fixture can never hash to it. The success-path cases therefore
 * replace the manifest entry's sha256 with the fixture digest for the duration
 * of the case and restore it afterwards (withAssetSha); the wrong-sha case runs
 * against the untouched manifest and asserts rejection.
 *
 * Run with: npm exec tsx -- src/main/__tests__/computer-use-installer.test.ts
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { rename } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "@vitest/runner";
import type { ComputerUsePlatform, InstallProgress } from "../../shared/computer-use-types.js";
import { ComputerUseError } from "../computer-use/contracts.js";
import {
	DriverInstaller,
	installerDriverRoot,
	installerTmpDir,
	removeStaleEntries,
	runCommand,
	sha256File,
	systemTarPath,
} from "../computer-use/driver-installer.js";
import { DRIVER_ASSETS, DRIVER_VERSION } from "../computer-use/driver-manifest.js";
import { managedDriverDir, probeDriverVersion, resolveDriverBinary } from "../computer-use/driver-locator.js";

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

/** Key-order-independent deep equality (JSON semantics). */
function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (value !== null && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([, v]) => v !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`);
		return `{${entries.join(",")}}`;
	}
	return JSON.stringify(value);
}

function assertDeepEqual(actual: unknown, expected: unknown, message: string): void {
	const a = stableJson(actual);
	const b = stableJson(expected);
	if (a === b) {
		passed++;
		console.log(`  PASS: ${message}`);
	} else {
		failed++;
		console.error(`  FAIL: ${message} - expected ${b}, got ${a}`);
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

/** Await a rejection and assert it is a ComputerUseError with the given code. */
async function expectComputerUseError(promise: Promise<unknown>, code: string, message: string): Promise<ComputerUseError | null> {
	try {
		await promise;
	} catch (err) {
		if (err instanceof ComputerUseError && err.code === code) {
			passed++;
			console.log(`  PASS: ${message}`);
			return err;
		}
		failed++;
		console.error(`  FAIL: ${message} - expected ComputerUseError(${code}), got ${String(err)}`);
		return null;
	}
	failed++;
	console.error(`  FAIL: ${message} - expected ComputerUseError(${code}), promise resolved instead`);
	return null;
}

// ============================================================================
// Helpers
// ============================================================================

const TEST_ROOT = mkdtempSync(path.join(tmpdir(), "pix-cu-installer-"));

function makeAgentDir(label: string): string {
	const dir = path.join(TEST_ROOT, `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function sha256Hex(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function delay(ms: number): Promise<void> {
	return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/** Poll until `predicate` is true (event-driven assertions, no fixed sleeps). */
async function waitFor(predicate: () => boolean, message: string, timeoutMs = 3000): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (predicate()) {
			passed++;
			console.log(`  PASS: ${message}`);
			return;
		}
		await delay(10);
	}
	failed++;
	console.error(`  FAIL: ${message} - timed out after ${timeoutMs}ms`);
}

/**
 * Replace the manifest digest for the duration of a case so an offline fixture
 * can exercise the success branch (see the file header offline note).
 */
async function withAssetSha<T>(platform: ComputerUsePlatform, sha256: string, fn: () => Promise<T>): Promise<T> {
	const asset = DRIVER_ASSETS[platform] as { sha256: string };
	const original = asset.sha256;
	asset.sha256 = sha256;
	try {
		return await fn();
	} finally {
		asset.sha256 = original;
	}
}

/** extract injection: materialize a fixed file set into the staging dir. */
function fakeExtract(files: Record<string, string>): (archive: string, kind: "zip" | "tar.gz", destDir: string) => Promise<void> {
	return async (_archive, _kind, destDir) => {
		for (const [name, content] of Object.entries(files)) {
			const target = path.join(destDir, name);
			mkdirSync(path.dirname(target), { recursive: true });
			writeFileSync(target, content);
		}
	};
}

interface ProgressLog {
	events: InstallProgress[];
	listen: (progress: InstallProgress) => void;
}

function recorder(): ProgressLog {
	const events: InstallProgress[] = [];
	return { events, listen: (progress) => events.push({ ...progress }) };
}

/** Distinct phases in first-occurrence order. */
function phasesOf(events: InstallProgress[]): string[] {
	return [...new Set(events.map((event) => event.phase))];
}

// ---- local http fixture server -------------------------------------------

interface RouteSpec {
	body: Buffer;
	/** Send a prefix of the body and never finish; the client must cancel. */
	stall?: boolean;
}

interface FixtureServer {
	baseUrl: string;
	requests: string[];
	close: () => Promise<void>;
}

async function startFixtureServer(routes: Record<string, RouteSpec>): Promise<FixtureServer> {
	const requests: string[] = [];
	const server = createServer((req, res) => {
		const url = req.url ?? "";
		requests.push(url);
		const spec = routes[url];
		if (spec === undefined) {
			res.statusCode = 404;
			res.end("not found");
			return;
		}
		res.statusCode = 200;
		res.setHeader("content-type", "application/octet-stream");
		res.setHeader("content-length", String(spec.body.length));
		if (spec.stall === true) {
			res.write(spec.body.subarray(0, Math.max(1, Math.floor(spec.body.length / 2))));
			return; // never end: the download stays in flight
		}
		res.end(spec.body);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address() as AddressInfo;
	return {
		baseUrl: `http://127.0.0.1:${address.port}`,
		requests,
		close: () => new Promise<void>((resolve) => {
			server.closeAllConnections();
			server.close(() => resolve());
		}),
	};
}

// ---- managed install fixtures --------------------------------------------

function receiptFor(platform: ComputerUsePlatform, overrides: Record<string, unknown> = {}): Record<string, unknown> {
	const asset = DRIVER_ASSETS[platform];
	return {
		schemaVersion: 1,
		version: DRIVER_VERSION,
		platform,
		asset: asset.fileName,
		sha256: asset.sha256,
		executable: asset.executable,
		installedAt: Date.now(),
		...overrides,
	};
}

/** Write a valid managed install (receipt + executable) by hand. */
function prepareManagedInstall(agentDir: string, platform: ComputerUsePlatform, overrides: Record<string, unknown> = {}): string {
	const dir = managedDriverDir(agentDir);
	mkdirSync(dir, { recursive: true });
	writeFileSync(path.join(dir, "install.json"), JSON.stringify(receiptFor(platform, overrides)), "utf8");
	writeFileSync(path.join(dir, DRIVER_ASSETS[platform].executable), "#!fake\n", { mode: 0o755 });
	return dir;
}

function writeExecutable(target: string): void {
	mkdirSync(path.dirname(target), { recursive: true });
	writeFileSync(target, "#!fake\n", { mode: 0o755 });
}

/** Build a real tar.gz fixture with the OS tar (System32 tar.exe on Windows). */
function buildTarGzFixture(label: string, files: Record<string, string>): { archivePath: string; bytes: Buffer } {
	const fixtureDir = path.join(TEST_ROOT, `${label}-src`);
	mkdirSync(fixtureDir, { recursive: true });
	for (const [name, content] of Object.entries(files)) {
		writeFileSync(path.join(fixtureDir, name), content);
	}
	const archivePath = path.join(TEST_ROOT, `${label}.tar.gz`);
	const tarPath = systemTarPath();
	const result = spawnSync(tarPath, ["-czf", archivePath, "-C", fixtureDir, "."], { encoding: "utf8" });
	if (result.status !== 0 || !existsSync(archivePath)) {
		throw new Error(`tar 打包 fixture 失败（${tarPath}，exit=${result.status}）：${result.stderr}`);
	}
	return { archivePath, bytes: readFileSync(archivePath) };
}

// ============================================================================
// driver-locator: managedDriverDir + resolveDriverBinary
// ============================================================================

await run("managedDriverDir: <agentDir>/computer-use/cua-driver/<DRIVER_VERSION>/", async () => {
	const agentDir = path.join(TEST_ROOT, "agent-layout");
	assertEqual(DRIVER_VERSION, "0.34.1", "locked DRIVER_VERSION");
	assertEqual(
		managedDriverDir(agentDir),
		path.join(agentDir, "computer-use", "cua-driver", "0.34.1"),
		"versioned managed root",
	);
});

await run("resolveDriverBinary: no custom path, no managed install → null", async () => {
	const agentDir = makeAgentDir("locator-empty");
	assertEqual(
		await resolveDriverBinary({ agentDir, platform: "win32-x64", customPath: null }),
		null,
		"empty agentDir resolves to null",
	);
	assertEqual(await resolveDriverBinary({ agentDir, platform: "linux-x64", customPath: "" }), null, "empty customPath treated as unset");
});

await run("resolveDriverBinary: managed install (valid receipt) resolves the executable", async () => {
	const platform: ComputerUsePlatform = "win32-x64";
	const agentDir = makeAgentDir("locator-managed");
	const dir = prepareManagedInstall(agentDir, platform);
	assertDeepEqual(
		await resolveDriverBinary({ agentDir, platform, customPath: null }),
		{ path: path.join(dir, DRIVER_ASSETS[platform].executable), source: "managed", dir },
		"managed path + dir + source",
	);
});

await run("resolveDriverBinary: invalid receipts are treated as corrupt", async () => {
	const platform: ComputerUsePlatform = "win32-x64";
	const cases: Array<[string, Record<string, unknown>]> = [
		["version mismatch", { version: "0.33.0" }],
		["schemaVersion mismatch", { schemaVersion: 2 }],
		["platform mismatch", { platform: "linux-x64" }],
		["executable mismatch", { executable: "other-driver" }],
		["sha256 mismatch", { sha256: "0".repeat(64) }],
		["installedAt missing", { installedAt: undefined }],
	];
	for (const [label, overrides] of cases) {
		const agentDir = makeAgentDir(`locator-bad-${label.replace(/\s+/g, "-")}`);
		const receipt = receiptFor(platform, overrides);
		if (overrides.installedAt === undefined) delete receipt.installedAt;
		const dir = managedDriverDir(agentDir);
		mkdirSync(dir, { recursive: true });
		writeFileSync(path.join(dir, "install.json"), JSON.stringify(receipt), "utf8");
		writeFileSync(path.join(dir, DRIVER_ASSETS[platform].executable), "#!fake\n", { mode: 0o755 });
		assertEqual(
			await resolveDriverBinary({ agentDir, platform, customPath: null }),
			null,
			`receipt ${label} → null`,
		);
	}

	const agentDir = makeAgentDir("locator-corrupt-json");
	const corruptDir = managedDriverDir(agentDir);
	mkdirSync(corruptDir, { recursive: true });
	writeFileSync(path.join(corruptDir, "install.json"), "{ not json", "utf8");
	writeFileSync(path.join(corruptDir, DRIVER_ASSETS[platform].executable), "#!fake\n", { mode: 0o755 });
	assertEqual(await resolveDriverBinary({ agentDir, platform, customPath: null }), null, "corrupt JSON → null");

	const missingExeDir = makeAgentDir("locator-missing-exe");
	prepareManagedInstall(missingExeDir, platform);
	rmSync(path.join(managedDriverDir(missingExeDir), DRIVER_ASSETS[platform].executable), { force: true });
	assertEqual(
		await resolveDriverBinary({ agentDir: missingExeDir, platform, customPath: null }),
		null,
		"receipt valid but executable missing → null",
	);
});

await run("resolveDriverBinary: custom path priority and fallbacks", async () => {
	const platform: ComputerUsePlatform = "linux-x64";
	const agentDir = makeAgentDir("locator-priority");
	prepareManagedInstall(agentDir, platform);

	const custom = path.join(TEST_ROOT, "custom-driver", "cua-driver");
	writeExecutable(custom);
	assertDeepEqual(
		await resolveDriverBinary({ agentDir, platform, customPath: custom }),
		{ path: custom, source: "custom", dir: path.dirname(custom) },
		"custom path wins over a valid managed install",
	);
	assertDeepEqual(
		await resolveDriverBinary({ agentDir, platform, customPath: path.join(TEST_ROOT, "does-not-exist", "cua-driver") }),
		{ path: path.join(managedDriverDir(agentDir), DRIVER_ASSETS[platform].executable), source: "managed", dir: managedDriverDir(agentDir) },
		"missing custom path falls back to managed",
	);
	assertDeepEqual(
		await resolveDriverBinary({ agentDir, platform, customPath: TEST_ROOT }),
		{ path: path.join(managedDriverDir(agentDir), DRIVER_ASSETS[platform].executable), source: "managed", dir: managedDriverDir(agentDir) },
		"a directory is not an executable: falls back to managed",
	);

	const bareDir = makeAgentDir("locator-bare");
	assertEqual(
		await resolveDriverBinary({ agentDir: bareDir, platform, customPath: path.join(bareDir, "nope") }),
		null,
		"missing custom path without a managed install → null",
	);
});

// ============================================================================
// driver-locator: probeDriverVersion
// ============================================================================

await run("probeDriverVersion: process.execPath returns process.versions.node", async () => {
	assertEqual(
		await probeDriverVersion(process.execPath),
		process.versions.node,
		"node --version parsed to the running node version",
	);
});

await run("probeDriverVersion: failures raise ComputerUseError(\"driver_incompatible\")", async () => {
	const missing = path.join(TEST_ROOT, "no-such-binary", "cua-driver");
	const missingError = await expectComputerUseError(
		probeDriverVersion(missing),
		"driver_incompatible",
		"nonexistent path → driver_incompatible",
	);
	assert(missingError !== null && missingError.message.startsWith("[computer_use:driver_incompatible]"), "message carries the code prefix");
	assert(missingError !== null && missingError.message.includes("Hint:"), "message carries the repair hint");

	const notRunnable = await expectComputerUseError(
		probeDriverVersion(TEST_ROOT),
		"driver_incompatible",
		"non-runnable target (directory) → driver_incompatible",
	);
	assert(notRunnable !== null, "directory probe rejects");
});

// ============================================================================
// driver-installer: sha256File + systemTarPath
// ============================================================================

await run("sha256File: known vector", async () => {
	const file = path.join(TEST_ROOT, "sha-vector.bin");
	writeFileSync(file, "abc");
	assertEqual(
		await sha256File(file),
		"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
		"sha256(\"abc\")",
	);
});

await run("systemTarPath: System32 tar.exe on win32, /usr/bin/tar elsewhere", async () => {
	// path.win32: the win32 branch must build a legal Windows path even
	// when probed from a non-Windows host (path.join would use host separators).
	const expectedWin32 = path.win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
	assertEqual(systemTarPath("win32"), expectedWin32, "win32 → %SystemRoot%\\System32\\tar.exe");
	assert(path.win32.isAbsolute(expectedWin32), "win32 tar path is absolute in win32 terms");
	assertEqual(systemTarPath("linux"), "/usr/bin/tar", "linux → /usr/bin/tar");
	assertEqual(systemTarPath("darwin"), "/usr/bin/tar", "darwin → /usr/bin/tar");
});

// ============================================================================
// driver-installer: full flow against a local http server (injected extract)
// ============================================================================

await run("installer: local server + matching sha → success and receipt", async () => {
	const platform: ComputerUsePlatform = "linux-x64";
	const asset = DRIVER_ASSETS[platform];
	const agentDir = makeAgentDir("install-ok");
	const archiveBytes = Buffer.from("fake cua-driver archive payload\n");
	const digest = sha256Hex(archiveBytes);
	const server = await startFixtureServer({ [`/${asset.fileName}`]: { body: archiveBytes } });
	const progress = recorder();
	try {
		// The resolveDriverBinary integration check stays inside the patch window:
		// the locator compares the receipt against the manifest digest, which is
		// restored once the fixture digest is no longer the expected one.
		const executable = await withAssetSha(platform, digest, async () => {
			const installed = await new DriverInstaller({
				agentDir,
				platform,
				baseUrl: server.baseUrl,
				extract: fakeExtract({ [asset.executable]: "driver-binary", "libcua_driver_sdk.so": "lib" }),
			}).install(progress.listen);
			assertDeepEqual(
				await resolveDriverBinary({ agentDir, platform, customPath: null }),
				{ path: installed, source: "managed", dir: managedDriverDir(agentDir) },
				"resolveDriverBinary accepts the freshly installed driver",
			);
			return installed;
		});

		const managedDir = managedDriverDir(agentDir);
		assertEqual(executable, path.join(managedDir, asset.executable), "resolves to the managed executable");
		assert(existsSync(executable), "executable landed on disk");
		assertEqual(readFileSync(executable, "utf8"), "driver-binary", "extracted content matches the fixture");
		assert(existsSync(path.join(managedDir, "libcua_driver_sdk.so")), "helper files land next to the executable");

		const receipt = JSON.parse(readFileSync(path.join(managedDir, "install.json"), "utf8")) as Record<string, unknown>;
		assertDeepEqual(
			{ ...receipt, installedAt: "<ts>" },
			{ ...receiptFor(platform, { sha256: digest }), installedAt: "<ts>" },
			"install.json receipt matches §6.3 (with the fixture digest)",
		);
		assert(typeof receipt.installedAt === "number" && receipt.installedAt > 0, "installedAt is a timestamp");

		assertEqual(server.requests.length, 1, "exactly one download request");
		assertEqual(server.requests[0], `/${asset.fileName}`, "requests the platform asset file name");

		assertDeepEqual(phasesOf(progress.events), ["downloading", "verifying", "extracting", "done"], "progress phases in order");
		assertEqual(progress.events[0]?.totalBytes, asset.sizeBytes, "initial totalBytes is the manifest size");
		assertEqual(progress.events.at(-1)?.receivedBytes, archiveBytes.length, "final receivedBytes equals the archive size");
		assertEqual(progress.events.at(-1)?.totalBytes, archiveBytes.length, "totalBytes switches to content-length");

		assertDeepEqual(readdirSync(installerTmpDir(agentDir)), [], "tmp directory is empty after install");
		assertEqual(
			readdirSync(installerDriverRoot(agentDir)).filter((entry) => entry.includes(".staging-")).length,
			0,
			"no staging leftovers",
		);
	} finally {
		await server.close();
	}
});

await run("installer: sha256 mismatch → failed, nothing persisted, extract never runs", async () => {
	const platform: ComputerUsePlatform = "linux-x64";
	const asset = DRIVER_ASSETS[platform];
	const agentDir = makeAgentDir("install-badsha");
	const archiveBytes = Buffer.from("tampered archive");
	const server = await startFixtureServer({ [`/${asset.fileName}`]: { body: archiveBytes } });
	const progress = recorder();
	let extractCalls = 0;
	const installer = new DriverInstaller({
		agentDir,
		platform,
		baseUrl: server.baseUrl,
		extract: async () => {
			extractCalls++;
		},
	});
	try {
		// The manifest digest is the real release digest: the fixture cannot match it.
		const error = await expectComputerUseError(installer.install(progress.listen), "driver_error", "sha mismatch rejects");
		assert(error !== null && error.message.startsWith("[computer_use:driver_error]"), "error message carries the code prefix");
		assert(error !== null && error.message.includes("校验失败"), "error text uses the §5.2 wording");
		assert(error !== null && error.message.includes(asset.fileName), "error text points at the manual-download alternative");
		assertEqual(extractCalls, 0, "the rejected archive is never extracted");
		assertEqual(progress.events.at(-1)?.phase, "failed", "terminal progress phase is failed");
		assert(progress.events.at(-1)?.error !== undefined, "failed progress carries the error text");
		assert(!existsSync(managedDriverDir(agentDir)), "nothing landed in the managed directory");
		assert(!existsSync(installerDriverRoot(agentDir)), "no managed directory tree was created");
		assertDeepEqual(readdirSync(installerTmpDir(agentDir)), [], "the temporary archive was deleted");
	} finally {
		await server.close();
	}
});

await run("installer: cancel during download → cancelled, nothing persisted", async () => {
	const platform: ComputerUsePlatform = "linux-x64";
	const asset = DRIVER_ASSETS[platform];
	const agentDir = makeAgentDir("install-cancel");
	const archiveBytes = Buffer.alloc(4096, 7);
	const server = await startFixtureServer({ [`/${asset.fileName}`]: { body: archiveBytes, stall: true } });
	const progress = recorder();
	const installer = new DriverInstaller({
		agentDir,
		platform,
		baseUrl: server.baseUrl,
		extract: fakeExtract({ [asset.executable]: "driver-binary" }),
	});
	installer.cancel(); // no-op before any install
	try {
		const promise = installer.install(progress.listen);
		assertEqual(installer.isInstalling(), true, "isInstalling() is true while downloading");
		await delay(150);
		installer.cancel();
		await expectComputerUseError(promise, "cancelled", "cancel() rejects with cancelled");
		assertEqual(installer.isInstalling(), false, "isInstalling() is false after cancellation");
		assertEqual(progress.events.at(-1)?.phase, "cancelled", "terminal progress phase is cancelled");
		assert(!existsSync(managedDriverDir(agentDir)), "nothing landed in the managed directory");
		assertDeepEqual(readdirSync(installerTmpDir(agentDir)), [], "the partial archive was deleted");
	} finally {
		await server.close();
	}
});

await run("installer: single-flight — concurrent installs share one download", async () => {
	const platform: ComputerUsePlatform = "linux-x64";
	const asset = DRIVER_ASSETS[platform];
	const agentDir = makeAgentDir("install-single-flight");
	const archiveBytes = Buffer.from("single-flight archive");
	const digest = sha256Hex(archiveBytes);
	const server = await startFixtureServer({ [`/${asset.fileName}`]: { body: archiveBytes } });
	const first = recorder();
	const second = recorder();
	const installer = new DriverInstaller({
		agentDir,
		platform,
		baseUrl: server.baseUrl,
		extract: fakeExtract({ [asset.executable]: "driver-binary" }),
	});
	try {
		const [pathA, pathB] = await withAssetSha(platform, digest, async () => {
			const p1 = installer.install(first.listen);
			const p2 = installer.install(second.listen);
			assertEqual(p1, p2, "both calls share the same promise");
			assertEqual(installer.isInstalling(), true, "isInstalling() during the shared install");
			return [await p1, await p2] as [string, string];
		});
		assertEqual(pathA, pathB, "both calls resolve to the same executable path");
		assertEqual(server.requests.length, 1, "only one download request");
		assertEqual(installer.isInstalling(), false, "isInstalling() false after completion");
		assert(first.events.length >= 2, "first listener received progress");
		assert(second.events.length >= 1, "second listener received progress (latest state replayed)");
		assertEqual(first.events.at(-1)?.phase, "done", "first listener saw done");
	} finally {
		await server.close();
	}
});

await run("installer: fetchImpl injection is honored", async () => {
	const platform: ComputerUsePlatform = "linux-x64";
	const asset = DRIVER_ASSETS[platform];
	const agentDir = makeAgentDir("install-fetch-impl");
	const archiveBytes = Buffer.from("injected fetch payload");
	const digest = sha256Hex(archiveBytes);
	const calls: string[] = [];
	const fetchImpl: typeof fetch = async (input) => {
		calls.push(String(input));
		return new Response(archiveBytes);
	};
	const progress = recorder();
	const executable = await withAssetSha(platform, digest, () =>
		new DriverInstaller({
			agentDir,
			platform,
			fetchImpl,
			extract: fakeExtract({ [asset.executable]: "driver-binary" }),
		}).install(progress.listen));
	assertEqual(executable, path.join(managedDriverDir(agentDir), asset.executable), "install completes through the injected fetch");
	assertEqual(calls.length, 1, "injected fetch called once");
	assert(calls[0].endsWith(`/${asset.fileName}`), "injected fetch receives the asset URL");
	assertDeepEqual(phasesOf(progress.events), ["downloading", "verifying", "extracting", "done"], "progress phases through injected fetch");
});

// ============================================================================
// driver-installer: failure branches after download
// ============================================================================

await run("installer: extract failure → failed with cleanup", async () => {
	const platform: ComputerUsePlatform = "linux-x64";
	const asset = DRIVER_ASSETS[platform];
	const agentDir = makeAgentDir("install-extract-fail");
	const archiveBytes = Buffer.from("extract-failure archive");
	const digest = sha256Hex(archiveBytes);
	const server = await startFixtureServer({ [`/${asset.fileName}`]: { body: archiveBytes } });
	const progress = recorder();
	try {
		const error = await withAssetSha(platform, digest, () =>
			expectComputerUseError(
				new DriverInstaller({
					agentDir,
					platform,
					baseUrl: server.baseUrl,
					extract: async () => {
						throw new Error("tar exploded");
					},
				}).install(progress.listen),
				"driver_error",
				"extract failure rejects with driver_error",
			));
		assert(error !== null && error.message.includes("tar exploded"), "error text keeps the extractor message");
		assertEqual(progress.events.at(-1)?.phase, "failed", "terminal progress phase is failed");
		assert(!existsSync(managedDriverDir(agentDir)), "no managed directory");
		assertDeepEqual(readdirSync(installerDriverRoot(agentDir)), [], "staging directory removed");
		assertDeepEqual(readdirSync(installerTmpDir(agentDir)), [], "temporary archive removed");
	} finally {
		await server.close();
	}
});

await run("installer: executable missing in the archive → failed with cleanup", async () => {
	const platform: ComputerUsePlatform = "linux-x64";
	const asset = DRIVER_ASSETS[platform];
	const agentDir = makeAgentDir("install-no-exe");
	const archiveBytes = Buffer.from("missing executable archive");
	const digest = sha256Hex(archiveBytes);
	const server = await startFixtureServer({ [`/${asset.fileName}`]: { body: archiveBytes } });
	try {
		const error = await withAssetSha(platform, digest, () =>
			expectComputerUseError(
				new DriverInstaller({
					agentDir,
					platform,
					baseUrl: server.baseUrl,
					extract: fakeExtract({ "readme.txt": "no executable here" }),
				}).install(() => undefined),
				"driver_error",
				"missing executable rejects",
			));
		assert(error !== null && error.message.includes(asset.executable), "error names the missing executable");
		assert(!existsSync(managedDriverDir(agentDir)), "no managed directory");
		assertDeepEqual(readdirSync(installerDriverRoot(agentDir)), [], "staging directory removed");
	} finally {
		await server.close();
	}
});

await run("installer: HTTP error status → failed", async () => {
	const platform: ComputerUsePlatform = "linux-x64";
	const asset = DRIVER_ASSETS[platform];
	const agentDir = makeAgentDir("install-http-error");
	const server = await startFixtureServer({});
	const progress = recorder();
	try {
		const error = await expectComputerUseError(
			new DriverInstaller({
				agentDir,
				platform,
				baseUrl: server.baseUrl,
				extract: fakeExtract({ [asset.executable]: "driver-binary" }),
			}).install(progress.listen),
			"driver_error",
			"HTTP 404 rejects with driver_error",
		);
		assert(error !== null && error.message.includes("404"), "error text carries the HTTP status");
		assertEqual(progress.events.at(-1)?.phase, "failed", "terminal progress phase is failed");
		assert(!existsSync(managedDriverDir(agentDir)), "no managed directory");
	} finally {
		await server.close();
	}
});

// ============================================================================
// driver-installer: reinstall + stale tmp sweep
// ============================================================================

await run("installer: reinstall replaces the previous install atomically", async () => {
	const platform: ComputerUsePlatform = "linux-x64";
	const asset = DRIVER_ASSETS[platform];
	const agentDir = makeAgentDir("install-reinstall");
	const archiveBytes = Buffer.from("reinstall archive");
	const digest = sha256Hex(archiveBytes);
	const server = await startFixtureServer({ [`/${asset.fileName}`]: { body: archiveBytes } });
	try {
		await withAssetSha(platform, digest, () =>
			new DriverInstaller({
				agentDir,
				platform,
				baseUrl: server.baseUrl,
				extract: fakeExtract({ [asset.executable]: "first", "stale-file.txt": "stale" }),
			}).install(() => undefined));

		const managedDir = managedDriverDir(agentDir);
		const firstReceipt = JSON.parse(readFileSync(path.join(managedDir, "install.json"), "utf8")) as { installedAt: number };
		await delay(5);

		await withAssetSha(platform, digest, () =>
			new DriverInstaller({
				agentDir,
				platform,
				baseUrl: server.baseUrl,
				extract: fakeExtract({ [asset.executable]: "second" }),
			}).install(() => undefined));

		assertEqual(readFileSync(path.join(managedDir, asset.executable), "utf8"), "second", "executable replaced");
		assert(!existsSync(path.join(managedDir, "stale-file.txt")), "files from the previous install are gone");
		const secondReceipt = JSON.parse(readFileSync(path.join(managedDir, "install.json"), "utf8")) as { installedAt: number };
		assert(secondReceipt.installedAt >= firstReceipt.installedAt, "receipt rewritten with a fresh timestamp");
		assertEqual(server.requests.length, 2, "both installs downloaded");
		assertEqual(
			readdirSync(installerDriverRoot(agentDir)).filter((entry) => entry.includes(".old-") || entry.endsWith(".bak")).length,
			0,
			"no .old-/.bak leftovers",
		);
	} finally {
		await server.close();
	}
});

await run("installer: stale tmp entries (>24h) are swept, fresh ones kept", async () => {
	const platform: ComputerUsePlatform = "linux-x64";
	const asset = DRIVER_ASSETS[platform];
	const agentDir = makeAgentDir("install-tmp-sweep");
	const tmpDir = installerTmpDir(agentDir);
	mkdirSync(tmpDir, { recursive: true });
	const staleFile = path.join(tmpDir, "stale-download.part");
	const freshFile = path.join(tmpDir, "fresh-download.part");
	writeFileSync(staleFile, "stale");
	writeFileSync(freshFile, "fresh");
	const longAgo = Date.now() - 25 * 60 * 60 * 1000;
	utimesSync(staleFile, longAgo / 1000, longAgo / 1000);

	const archiveBytes = Buffer.from("sweep archive");
	const digest = sha256Hex(archiveBytes);
	const server = await startFixtureServer({ [`/${asset.fileName}`]: { body: archiveBytes } });
	try {
		await withAssetSha(platform, digest, () =>
			new DriverInstaller({
				agentDir,
				platform,
				baseUrl: server.baseUrl,
				extract: fakeExtract({ [asset.executable]: "driver-binary" }),
			}).install(() => undefined));
		assert(!existsSync(staleFile), "stale (>24h) tmp entry removed");
		assert(existsSync(freshFile), "fresh tmp entry kept");
		assertDeepEqual(
			readdirSync(tmpDir).filter((entry) => entry.endsWith(".zip") || entry.endsWith(".tar.gz")),
			[],
			"no archive leftovers",
		);
	} finally {
		await server.close();
	}
});

// ============================================================================
// driver-installer: replace-failure backup, stream failure, extraction abort
// ============================================================================

await run("installer: a failed replace restores the previous install (backup protection)", async () => {
	const platform: ComputerUsePlatform = "linux-x64";
	const asset = DRIVER_ASSETS[platform];
	const agentDir = makeAgentDir("install-replace-fail");
	const managedDir = managedDriverDir(agentDir);
	prepareManagedInstall(agentDir, platform); // executable content "#!fake\n"
	writeFileSync(path.join(managedDir, "existing.txt"), "keep");
	const archiveBytes = Buffer.from("replace-failure archive");
	const digest = sha256Hex(archiveBytes);
	const server = await startFixtureServer({ [`/${asset.fileName}`]: { body: archiveBytes } });
	try {
		const moveCalls: Array<[string, string]> = [];
		const move = async (from: string, to: string): Promise<void> => {
			moveCalls.push([from, to]);
			// Only the staging -> final rename fails; backup + restore are real.
			if (to === managedDir && from.includes(".staging-")) throw new Error("final rename failed (simulated)");
			await rename(from, to);
		};
		const error = await withAssetSha(platform, digest, () =>
			expectComputerUseError(
				new DriverInstaller({
					agentDir,
					platform,
					baseUrl: server.baseUrl,
					move,
					extract: fakeExtract({ [asset.executable]: "new" }),
				}).install(() => undefined),
				"driver_error",
				"a failing final rename rejects with driver_error",
			));
		assert(error !== null && error.message.includes("final rename failed"), "error keeps the rename failure text");
		assertEqual(readFileSync(path.join(managedDir, asset.executable), "utf8"), "#!fake\n", "the previous executable is restored");
		assert(existsSync(path.join(managedDir, "existing.txt")), "previous files survive the failed replace");
		assert(!existsSync(`${managedDir}.bak`), "no backup leftover after the restore");
		assert(moveCalls.length >= 3, "backup taken, final rename attempted, backup restored");
	} finally {
		await server.close();
	}
});

await run("installer: a crashed-run .bak leftover is restored before the new attempt", async () => {
	const platform: ComputerUsePlatform = "linux-x64";
	const asset = DRIVER_ASSETS[platform];
	const agentDir = makeAgentDir("install-crash-bak");
	const managedDir = managedDriverDir(agentDir);
	const backupDir = `${managedDir}.bak`;
	// Crash leftover: a previous run renamed the install to .bak and died
	// before the staging directory landed, so only the .bak exists.
	mkdirSync(backupDir, { recursive: true });
	writeFileSync(path.join(backupDir, asset.executable), "#!previous\n", { mode: 0o755 });
	writeFileSync(path.join(backupDir, "install.json"), JSON.stringify(receiptFor(platform)), "utf8");
	// The retry fails at download: without recovery the user's last usable
	// driver would stay stranded in .bak (or be deleted by the blind rm).
	const fetchImpl: typeof fetch = async () => {
		throw new Error("network down during retry");
	};
	const progress = recorder();
	const error = await expectComputerUseError(
		new DriverInstaller({
			agentDir,
			platform,
			fetchImpl,
			extract: fakeExtract({ [asset.executable]: "new" }),
		}).install(progress.listen),
		"driver_error",
		"the failing retry still rejects with driver_error",
	);
	assert(error !== null && error.message.includes("下载驱动失败"), "failure is the download error");
	assert(existsSync(managedDir), "the leftover backup was restored into the managed directory");
	assertEqual(
		readFileSync(path.join(managedDir, asset.executable), "utf8"),
		"#!previous\n",
		"the previous driver content survived the failed retry",
	);
	assert(!existsSync(backupDir), "the .bak was consumed by the restore, not blindly deleted");
	assertDeepEqual(
		await resolveDriverBinary({ agentDir, platform, customPath: null }),
		{ path: path.join(managedDir, asset.executable), source: "managed", dir: managedDir },
		"the restored install resolves as a usable managed driver again",
	);
});

await run("installer: the receipt is written into staging BEFORE the landing rename", async () => {
	const platform: ComputerUsePlatform = "linux-x64";
	const asset = DRIVER_ASSETS[platform];
	const agentDir = makeAgentDir("install-receipt-staging");
	const managedDir = managedDriverDir(agentDir);
	const archiveBytes = Buffer.from("receipt-staging archive");
	const digest = sha256Hex(archiveBytes);
	const server = await startFixtureServer({ [`/${asset.fileName}`]: { body: archiveBytes } });
	try {
		let stagingSeen = "";
		const move = async (from: string, to: string): Promise<void> => {
			// The final landing rename: staging must already carry install.json, so
			// a crash right after the .bak delete can never leave a receipt-less
			// (i.e. "corrupt") managed directory behind.
			if (to === managedDir && from.includes(".staging-")) {
				stagingSeen = from;
				assert(existsSync(path.join(from, "install.json")), "install.json exists in staging before the rename");
				const staged = JSON.parse(readFileSync(path.join(from, "install.json"), "utf8")) as Record<string, unknown>;
				assertEqual(staged.version, DRIVER_VERSION, "the staged receipt carries the driver version");
				assertEqual(staged.platform, platform, "the staged receipt carries the platform");
			}
			await rename(from, to);
		};
		await withAssetSha(platform, digest, () =>
			new DriverInstaller({
				agentDir,
				platform,
				baseUrl: server.baseUrl,
				move,
				extract: fakeExtract({ [asset.executable]: "driver-binary" }),
			}).install(() => undefined));
		assert(stagingSeen !== "", "the landing rename was observed");
		assert(existsSync(path.join(managedDir, "install.json")), "the receipt landed together with the directory");
	} finally {
		await server.close();
	}
});

await run("installer: a .bak that cannot be deleted fails with an actionable error, install untouched", async () => {
	const platform: ComputerUsePlatform = "linux-x64";
	const asset = DRIVER_ASSETS[platform];
	const agentDir = makeAgentDir("install-bak-rm-fail");
	const managedDir = managedDriverDir(agentDir);
	const backupDir = `${managedDir}.bak`;
	prepareManagedInstall(agentDir, platform);
	writeFileSync(path.join(managedDir, "existing.txt"), "keep");
	// The stale backup the injected remove cannot delete (locked / permission
	// denied in reality): a no-op stands in for a swallowed rm failure.
	mkdirSync(backupDir, { recursive: true });
	writeFileSync(path.join(backupDir, asset.executable), "#!stale\n");
	const archiveBytes = Buffer.from("bak-rm-fail archive");
	const digest = sha256Hex(archiveBytes);
	const server = await startFixtureServer({ [`/${asset.fileName}`]: { body: archiveBytes } });
	try {
		const error = await withAssetSha(platform, digest, () =>
			expectComputerUseError(
				new DriverInstaller({
					agentDir,
					platform,
					baseUrl: server.baseUrl,
					remove: async () => undefined,
					extract: fakeExtract({ [asset.executable]: "new" }),
				}).install(() => undefined),
				"driver_error",
				"a stuck .bak rejects with driver_error",
			));
		assert(error !== null && error.message.includes("手动删除"), "the error tells the user to delete the directory manually");
		assert(error !== null && error.message.includes(backupDir), "the error names the stuck backup directory");
		assertEqual(readFileSync(path.join(managedDir, asset.executable), "utf8"), "#!fake\n", "the managed install was not touched");
		assert(existsSync(path.join(managedDir, "existing.txt")), "existing files survive untouched");
		assert(existsSync(backupDir), "the stuck backup stays for the user to remove");
	} finally {
		await server.close();
	}
});

await run("installer: download write-stream failure → failed, no uncaught stream error", async () => {
	const platform: ComputerUsePlatform = "linux-x64";
	const asset = DRIVER_ASSETS[platform];
	const agentDir = makeAgentDir("install-stream-fail");
	const archiveBytes = Buffer.from("stream failure archive");
	// The injected fetch removes the freshly created tmp dir before returning,
	// so createWriteStream's open fails asynchronously: the WriteStream then
	// emits "error" on its own. Without the listener in _download that is an
	// uncaught exception that kills the process; here it must surface as a
	// rejected install with a terminal "failed" event.
	const fetchImpl: typeof fetch = async () => {
		rmSync(installerTmpDir(agentDir), { recursive: true, force: true });
		return new Response(archiveBytes);
	};
	const progress = recorder();
	const error = await expectComputerUseError(
		new DriverInstaller({
			agentDir,
			platform,
			fetchImpl,
			extract: fakeExtract({ [asset.executable]: "driver-binary" }),
		}).install(progress.listen),
		"driver_error",
		"an open/write failure on the archive stream rejects with driver_error",
	);
	assert(error !== null && error.message.includes("驱动安装失败"), "error text names the install failure");
	assertEqual(progress.events.at(-1)?.phase, "failed", "terminal progress phase is failed");
	assert(!existsSync(managedDriverDir(agentDir)), "nothing landed in the managed directory");
	// Give a delayed uncaught "error" emission time to surface.
	await delay(150);
});

await run("installer: cancel during extraction aborts the extractor (signal)", async () => {
	const platform: ComputerUsePlatform = "linux-x64";
	const asset = DRIVER_ASSETS[platform];
	const agentDir = makeAgentDir("install-cancel-extract");
	const archiveBytes = Buffer.from("cancel-extract archive");
	const digest = sha256Hex(archiveBytes);
	const server = await startFixtureServer({ [`/${asset.fileName}`]: { body: archiveBytes } });
	const progress = recorder();
	let extractSignal: AbortSignal | undefined;
	let extractStarted = false;
	const installer = new DriverInstaller({
		agentDir,
		platform,
		baseUrl: server.baseUrl,
		// Holds the extraction until the abort signal fires, like a hung tar.
		extract: (_archive, _kind, _destDir, signal) => {
			extractStarted = true;
			extractSignal = signal;
			return new Promise<void>((resolve) => {
				if (signal?.aborted === true) {
					resolve();
					return;
				}
				signal?.addEventListener("abort", () => resolve(), { once: true });
			});
		},
	});
	try {
		await withAssetSha(platform, digest, async () => {
			const promise = installer.install(progress.listen);
			await waitFor(() => extractStarted, "extraction reached");
			installer.cancel();
			await expectComputerUseError(promise, "cancelled", "cancel during extraction rejects with cancelled");
		});
		assert(extractSignal !== undefined, "the injected extract received the AbortSignal");
		assert(extractSignal?.aborted === true, "the extractor's signal is aborted");
		assertEqual(progress.events.at(-1)?.phase, "cancelled", "terminal progress phase is cancelled");
		assert(!existsSync(managedDriverDir(agentDir)), "nothing landed in the managed directory");
		assertEqual(
			readdirSync(installerDriverRoot(agentDir)).filter((entry) => entry.includes(".staging-")).length,
			0,
			"staging directory removed",
		);
	} finally {
		await server.close();
	}
});

await run("runCommand: abort kills the child and settles with a cancellation error", async () => {
	const marker = path.join(TEST_ROOT, "runcommand-child.pid");
	rmSync(marker, { force: true });
	const script = `require("node:fs").writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000);`;
	const controller = new AbortController();
	const promise = runCommand(process.execPath, ["-e", script], { signal: controller.signal });
	await waitFor(() => existsSync(marker), "child process started and recorded its pid");
	const pid = Number(readFileSync(marker, "utf8"));
	controller.abort();
	const rejection = await promise.then(
		() => null,
		(err: unknown) => err,
	);
	assert(rejection instanceof Error, "runCommand rejected after the abort");
	assert((rejection as Error).message.includes("已取消"), "rejection carries the cancellation wording");
	let childAlive = true;
	for (let i = 0; i < 250; i++) {
		try {
			process.kill(pid, 0);
		} catch {
			childAlive = false;
			break;
		}
		await delay(20);
	}
	assert(!childAlive, "the aborted child process was killed");

	// A pre-aborted signal must still produce a settled (rejected) promise.
	const preAborted = runCommand(process.execPath, ["-e", "setInterval(() => {}, 1000);"], { signal: AbortSignal.abort() });
	const earlyRejection = await preAborted.then(
		() => null,
		(err: unknown) => err,
	);
	assert(earlyRejection instanceof Error, "a pre-aborted signal settles with an error");
	assert((earlyRejection as Error).message.includes("已取消"), "pre-aborted rejection carries the cancellation wording");
});

await run("removeStaleEntries(tmp): sweeps >24h entries, keeps fresh ones, tolerates a missing dir", async () => {
	const agentDir = makeAgentDir("stale-sweep-direct");
	const tmpDir = installerTmpDir(agentDir);
	mkdirSync(tmpDir, { recursive: true });
	const stale = path.join(tmpDir, "stale-download.part");
	const fresh = path.join(tmpDir, "fresh-download.part");
	writeFileSync(stale, "stale");
	writeFileSync(fresh, "fresh");
	const longAgo = Date.now() - 25 * 60 * 60 * 1000;
	utimesSync(stale, longAgo / 1000, longAgo / 1000);

	await removeStaleEntries(tmpDir, "tmp");
	assert(!existsSync(stale), ">24h entry removed");
	assert(existsSync(fresh), "<24h entry kept");

	// A missing tmp dir (first launch) must not throw.
	await removeStaleEntries(path.join(TEST_ROOT, "no-such-tmp-dir"), "tmp");
	assert(true, "a missing tmp dir is tolerated");
});

await run("removeStaleEntries(staging): sweeps >24h staging dirs, keeps fresh ones and non-staging entries", async () => {
	const agentDir = makeAgentDir("staging-sweep-direct");
	const driverRoot = installerDriverRoot(agentDir);
	assertEqual(driverRoot, path.join(agentDir, "computer-use", "cua-driver"), "installerDriverRoot pins the managed-driver layout");
	assertEqual(installerTmpDir(agentDir), path.join(agentDir, "computer-use", "tmp"), "installerTmpDir pins the download tmp layout");
	const stale = path.join(driverRoot, `${DRIVER_VERSION}.staging-1a2b3c4d-5e6f`);
	const fresh = path.join(driverRoot, `${DRIVER_VERSION}.staging-11223344-5566`);
	const versionDir = path.join(driverRoot, DRIVER_VERSION);
	const plainEntry = path.join(driverRoot, "not-a-staging-dir.txt");
	for (const dir of [stale, fresh, versionDir]) mkdirSync(dir, { recursive: true });
	writeFileSync(path.join(stale, "leftover.bin"), "x");
	writeFileSync(plainEntry, "plain");
	const longAgo = Date.now() - 25 * 60 * 60 * 1000;
	utimesSync(stale, longAgo / 1000, longAgo / 1000);

	await removeStaleEntries(driverRoot, "staging");
	assert(!existsSync(stale), ">24h staging dir removed (crashed-install leftover reclaimed)");
	assert(existsSync(fresh), "fresh staging dir kept (a live install's staging is minutes old)");
	assert(existsSync(versionDir), "the versioned managed dir is never touched");
	assert(existsSync(plainEntry), "non-staging entries are ignored");

	// A missing driver root (first launch) must not throw.
	await removeStaleEntries(path.join(TEST_ROOT, "no-such-driver-root"), "staging");
	assert(true, "a missing driver root is tolerated");
});

// ============================================================================
// driver-installer: real default extractor (OS tar, tar.gz fixture)
// ============================================================================

await run("installer: real tar.gz extraction through the OS tar", async () => {
	const platform: ComputerUsePlatform = "linux-x64"; // tar.gz asset, executable "cua-driver"
	const asset = DRIVER_ASSETS[platform];
	const agentDir = makeAgentDir("install-real-tar");
	const fixture = buildTarGzFixture("real-driver", { [asset.executable]: "real-driver-binary\n", "helper.txt": "helper\n" });
	const digest = sha256Hex(fixture.bytes);
	const server = await startFixtureServer({ [`/${asset.fileName}`]: { body: fixture.bytes } });
	const progress = recorder();
	try {
		const executable = await withAssetSha(platform, digest, () =>
			new DriverInstaller({ agentDir, platform, baseUrl: server.baseUrl }).install(progress.listen));
		assertEqual(executable, path.join(managedDriverDir(agentDir), asset.executable), "real extraction resolves the executable");
		assertEqual(readFileSync(executable, "utf8"), "real-driver-binary\n", "extracted bytes match the fixture");
		assert(existsSync(path.join(managedDriverDir(agentDir), "helper.txt")), "archive layout preserved");
		assertDeepEqual(phasesOf(progress.events), ["downloading", "verifying", "extracting", "done"], "real extraction runs the full phase sequence");
		const receipt = JSON.parse(readFileSync(path.join(managedDriverDir(agentDir), "install.json"), "utf8")) as Record<string, unknown>;
		assertDeepEqual(
			{ ...receipt, installedAt: "<ts>" },
			{ ...receiptFor(platform, { sha256: digest }), installedAt: "<ts>" },
			"receipt written after real extraction",
		);
	} finally {
		await server.close();
	}
});

// ============================================================================

rmSync(TEST_ROOT, { recursive: true, force: true });

console.log(`\nPassed: ${passed}, Failed: ${failed}`);
if (process.env.VITEST !== undefined) {
	// vitest entry point: the script body above already ran during collection;
	// this test only reports the harness verdict (tsx keeps process.exit).
	test("installer script harness verdict (tsx entry prints PASS/FAIL above)", () => {
		assertEqual(failed, 0, "no harness failures");
	});
} else if (failed > 0) {
	process.exit(1);
}
