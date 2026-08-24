/**
 * Git IPC adapter tests (PiX 1.5.0, S2D).
 *
 * Covers the §4.3.4 GitIpcDeps contract end-to-end with an INJECTABLE IPC
 * adapter (pure Node, no Electron runtime): invalid locations (missing fields
 * / wrong types) are guarded on both channels - git-get-status answers
 * {kind:"unavailable", files:[], complete:false, errorCode:"invalid_location"}
 * and git-open-folder answers {success:false}, never reaching the injected
 * deps; valid locations (windows and wsl shapes) pass through to deps.getStatus
 * / deps.openFolder and their results are returned as-is.
 *
 * IPC harness rule (design plan §3 / §8): the test registers the REAL
 * production handlers from ipc-git-adapters.ts on a top-level-imported
 * injectable IpcMainLike adapter, exactly like plan-ipc.test.ts - no mirror,
 * no lockstep.
 *
 * Run with: npm exec tsx -- src/main/__tests__/git-ipc.test.ts
 */

import type { GitWorkdirSnapshot } from "../../shared/git-types.js";
import type { IpcMainLike } from "../ipc-plan-adapters.js";
import { registerGitIpcHandlers, type GitIpcDeps } from "../ipc-git-adapters.js";

// ============================================================================
// Test harness (matches plan-ipc.test.ts style)
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

// ============================================================================
// Injectable IPC adapter (pure Node; REAL handlers imported from
// ipc-git-adapters.ts - no mirror, no lockstep)
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

// ============================================================================
// Fixtures
// ============================================================================

function makeLocation(): Record<string, unknown> {
  return {
    path: "C:/workspace/repo",
    physicalPath: "C:\\workspace\\repo",
    name: "repo",
    environment: { kind: "windows" },
  };
}

function makeWslLocation(): Record<string, unknown> {
  return {
    path: "/home/user/repo",
    physicalPath: "\\\\wsl.localhost\\Ubuntu\\home\\user\\repo",
    name: "repo",
    environment: { kind: "wsl", distro: "Ubuntu" },
  };
}

function makeSnapshot(): GitWorkdirSnapshot {
  return {
    kind: "repository",
    repositoryName: "repo",
    branch: "master",
    files: [],
    complete: true,
    observedAt: 123456789,
  };
}

/** Valid structures with one field broken / missing each (guard must reject). */
function makeInvalidLocations(): unknown[] {
  const valid = makeLocation();
  return [
    null,
    undefined,
    42,
    "not-an-object",
    {},
    { path: "C:/workspace/repo" },
    { path: "C:/workspace/repo", physicalPath: "C:\\workspace\\repo" },
    { path: "C:/workspace/repo", physicalPath: "C:\\workspace\\repo", name: "repo" },
    { ...valid, path: 42 },
    { ...valid, physicalPath: 42 },
    { ...valid, name: 42 },
    { ...valid, environment: null },
    { ...valid, environment: { kind: "bogus" } },
    { ...valid, environment: { kind: "wsl" } },
  ];
}

// ============================================================================
// Tests
// ============================================================================

await run("git-get-status: invalid location -> unavailable/invalid_location, deps untouched", async () => {
  let getStatusCalls = 0;
  const ipc = new FakeIpcMain();
  registerGitIpcHandlers(ipc, {
    getStatus: async () => {
      getStatusCalls++;
      return makeSnapshot();
    },
    openFolder: async () => ({ success: true }),
  });

  for (const bad of makeInvalidLocations()) {
    const result = (await ipc.invoke("git-get-status", bad)) as GitWorkdirSnapshot;
    assertEqual(result.kind, "unavailable", `invalid location guarded -> unavailable (${JSON.stringify(bad)})`);
    assertEqual(result.files.length, 0, "invalid location -> empty files");
    assertEqual(result.complete, false, "invalid location -> complete false");
    assertEqual(result.errorCode, "invalid_location", "invalid location -> invalid_location code");
    assert(typeof result.observedAt === "number" && Number.isFinite(result.observedAt), "invalid location -> finite observedAt");
  }
  assertEqual(getStatusCalls, 0, "deps.getStatus never called for invalid locations");
});

await run("git-open-folder: invalid location -> {success:false}, deps untouched", async () => {
  let openFolderCalls = 0;
  const ipc = new FakeIpcMain();
  registerGitIpcHandlers(ipc, {
    getStatus: async () => makeSnapshot(),
    openFolder: async () => {
      openFolderCalls++;
      return { success: true };
    },
  });

  for (const bad of makeInvalidLocations()) {
    const result = (await ipc.invoke("git-open-folder", bad)) as { success: boolean; error?: string };
    assertEqual(result.success, false, `invalid location guarded -> {success:false} (${JSON.stringify(bad)})`);
  }
  assertEqual(openFolderCalls, 0, "deps.openFolder never called for invalid locations");
});

await run("git-get-status: valid location passes through, result returned as-is", async () => {
  const location = makeLocation();
  const snapshot = makeSnapshot();
  let received: unknown;
  const ipc = new FakeIpcMain();
  registerGitIpcHandlers(ipc, {
    getStatus: async (loc: unknown) => {
      received = loc;
      return snapshot;
    },
    openFolder: async () => ({ success: true }),
  });

  const result = (await ipc.invoke("git-get-status", location)) as GitWorkdirSnapshot;
  assertEqual(result, snapshot, "deps.getStatus result returned as-is");
  assertEqual(received, location, "location forwarded to deps.getStatus");

  // Non-repository snapshots pass through unchanged too.
  const notRepo: GitWorkdirSnapshot = { kind: "not-repository", files: [], complete: true, observedAt: 1 };
  const notRepoIpc = new FakeIpcMain();
  registerGitIpcHandlers(notRepoIpc, {
    getStatus: async () => notRepo,
    openFolder: async () => ({ success: true }),
  });
  const notRepoResult = (await notRepoIpc.invoke("git-get-status", location)) as GitWorkdirSnapshot;
  assertEqual(notRepoResult, notRepo, "not-repository snapshot returned as-is");
});

await run("git-get-status: valid WSL location passes the guard", async () => {
  const wslLocation = makeWslLocation();
  const snapshot = makeSnapshot();
  let received: unknown;
  const ipc = new FakeIpcMain();
  registerGitIpcHandlers(ipc, {
    getStatus: async (loc: unknown) => {
      received = loc;
      return snapshot;
    },
    openFolder: async () => ({ success: true }),
  });

  const result = (await ipc.invoke("git-get-status", wslLocation)) as GitWorkdirSnapshot;
  assertEqual(result, snapshot, "wsl location getStatus result returned as-is");
  assertEqual(received, wslLocation, "wsl location forwarded to deps.getStatus");
});

await run("git-open-folder: valid location passes through, result returned as-is", async () => {
  const location = makeLocation();
  let received: unknown;
  const ipc = new FakeIpcMain();
  registerGitIpcHandlers(ipc, {
    getStatus: async () => makeSnapshot(),
    openFolder: async (loc: unknown) => {
      received = loc;
      return { success: true };
    },
  });

  const ok = (await ipc.invoke("git-open-folder", location)) as { success: boolean; error?: string };
  assertEqual(ok.success, true, "openFolder success returned as-is");
  assertEqual(received, location, "location forwarded to deps.openFolder");

  // Failure results (error strings from shell.openPath) pass through unchanged.
  const failingIpc = new FakeIpcMain();
  registerGitIpcHandlers(failingIpc, {
    getStatus: async () => makeSnapshot(),
    openFolder: async () => ({ success: false, error: "Failed to open path" }),
  });
  const failed = (await failingIpc.invoke("git-open-folder", location)) as { success: boolean; error?: string };
  assertEqual(failed.success, false, "openFolder failure returned as-is");
  assertEqual(failed.error, "Failed to open path", "openFolder error string returned as-is");
});

// ============================================================================

console.log(`\nPassed: ${passed}, Failed: ${failed}`);
if (failed > 0) {
  process.exit(1);
}
