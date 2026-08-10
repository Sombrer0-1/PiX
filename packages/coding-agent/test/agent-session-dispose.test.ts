/**
 * Tests for AgentSession.dispose() nested-safe options:
 * killTrackedDetachedChildren and extensionShutdownTimeoutMs.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSession, type ExtensionProviderPolicy } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import type { ExtensionFactory, LoadExtensionsResult } from "../src/core/extensions/index.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { sleep } from "../src/utils/sleep.ts";
import * as shellModule from "../src/utils/shell.ts";
import { createFauxStreamFn, fauxModel } from "./test-harness.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "./utilities.ts";

describe("AgentSession dispose options", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-dispose-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	async function createSession(
		factories: ExtensionFactory[],
		policy?: ExtensionProviderPolicy,
	): Promise<{ session: AgentSession; extensionsResult: LoadExtensionsResult }> {
		const extensionsResult = await createTestExtensionsResult(factories, tempDir);
		const resourceLoader = createTestResourceLoader({ extensionsResult });
		const { streamFn } = createFauxStreamFn(["ok"]);
		const agent = new Agent({
			getApiKey: () => "faux-key",
			initialState: {
				model: fauxModel,
				systemPrompt: "You are a test assistant.",
				tools: [],
			},
			streamFn,
		});
		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		authStorage.setRuntimeApiKey(fauxModel.provider, "faux-key");
		const modelRegistry = ModelRegistry.create(authStorage, tempDir);
		const session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry,
			resourceLoader,
			extensionProviderPolicy: policy,
		});
		return { session, extensionsResult };
	}

	it("defaults await session_shutdown handlers and keep process-level child cleanup", async () => {
		let handlerCompleted = false;
		const { session } = await createSession([
			(pi) => {
				pi.on("session_shutdown", async () => {
					await sleep(20);
					handlerCompleted = true;
				});
			},
		]);
		const killSpy = vi.spyOn(shellModule, "killTrackedDetachedChildren");

		await session.dispose();

		expect(handlerCompleted).toBe(true);
		expect(killSpy).toHaveBeenCalled();
		// Local cleanup ran: the extension runner was invalidated, so contexts
		// created before dispose are stale.
		expect(() => session.extensionRunner.createContext().cwd).toThrow(/stale/);
		killSpy.mockRestore();
	});

	it("killTrackedDetachedChildren: false skips process-level cleanup but keeps local cleanup", async () => {
		const { session } = await createSession([]);
		const killSpy = vi.spyOn(shellModule, "killTrackedDetachedChildren");

		await session.dispose({ killTrackedDetachedChildren: false });

		expect(killSpy).not.toHaveBeenCalled();
		expect(() => session.extensionRunner.createContext().cwd).toThrow(/stale/);
		killSpy.mockRestore();
	});

	it("extensionShutdownTimeoutMs bounds the session_shutdown aggregate while local cleanup still runs", async () => {
		const { session } = await createSession([
			(pi) => {
				pi.on("session_shutdown", () => new Promise<void>(() => {}));
			},
		]);
		const errors: Array<{ event: string; error: string }> = [];
		session.extensionRunner.onError((error) => errors.push({ event: error.event, error: error.error }));

		const start = Date.now();
		await session.dispose({ extensionShutdownTimeoutMs: 50 });
		const elapsed = Date.now() - start;

		expect(elapsed).toBeLessThan(2000);
		expect(() => session.extensionRunner.createContext().cwd).toThrow(/stale/);
		expect(errors.some((error) => error.event === "session_shutdown" && error.error.includes("50ms"))).toBe(true);
	});

	it("extensionShutdownTimeoutMs: 0 means don't wait for shutdown handlers", async () => {
		const { session } = await createSession([
			(pi) => {
				pi.on("session_shutdown", () => new Promise<void>(() => {}));
			},
		]);

		const start = Date.now();
		await session.dispose({ extensionShutdownTimeoutMs: 0 });
		const elapsed = Date.now() - start;

		expect(elapsed).toBeLessThan(2000);
		expect(() => session.extensionRunner.createContext().cwd).toThrow(/stale/);
	});

	it("a late shutdown settlement after timeout is observed without an unhandled rejection", async () => {
		const { session } = await createSession([
			(pi) => {
				pi.on("session_shutdown", async () => {
					await sleep(150);
					throw new Error("late shutdown failure");
				});
			},
		]);
		const errors: Array<{ event: string; error: string }> = [];
		session.extensionRunner.onError((error) => errors.push({ event: error.event, error: error.error }));

		const unhandledRejections: unknown[] = [];
		const onUnhandledRejection = (reason: unknown) => {
			unhandledRejections.push(reason);
		};
		process.on("unhandledRejection", onUnhandledRejection);

		try {
			await session.dispose({ extensionShutdownTimeoutMs: 20 });
			await sleep(250);
		} finally {
			process.removeListener("unhandledRejection", onUnhandledRejection);
		}

		expect(unhandledRejections).toEqual([]);
		expect(errors.some((error) => error.error.includes("late shutdown failure"))).toBe(true);
	});

	it("dispose is idempotent", async () => {
		const { session } = await createSession([
			(pi) => {
				pi.on("session_shutdown", () => new Promise<void>(() => {}));
			},
		]);

		await session.dispose({ extensionShutdownTimeoutMs: 20 });

		// A second dispose returns immediately even with the default (no-timeout)
		// behavior, because the session is already disposed.
		const start = Date.now();
		await session.dispose();
		expect(Date.now() - start).toBeLessThan(2000);
	});

	it("default behavior emits session_shutdown when emitSessionShutdown is not disabled", async () => {
		let shutdownFired = false;
		const { session } = await createSession([
			(pi) => {
				pi.on("session_shutdown", () => {
					shutdownFired = true;
				});
			},
		]);

		await session.dispose();

		expect(shutdownFired).toBe(true);
	});
});
