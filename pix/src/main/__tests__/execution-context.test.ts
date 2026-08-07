/**
 * Project execution context & persistence tests (S6).
 *
 * Covers:
 *   - old { path } -> Windows migration in SettingsStore
 *   - WSL ext4/drive round-trip via resolveProjectLocation
 *   - explicit distro missing fails; default distro never substituted
 *   - schemaVersion=2 JSON with physicalPath
 *   - isWsl marker on ProjectExecutionContext (Windows=false, WSL=true)
 *   - teamSnapshotPath / workspaceModePath / _getSessionDir hash inputs are
 *     physicalCwd (not logicalCwd)
 *
 * Run with: npx tsx pix/src/main/__tests__/execution-context.test.ts
 *
 * Real-WSL distro cases are gated by PIX_WSL_TEST_DISTRO and skip when unset;
 * fake/unit cases must pass without a distro.
 */

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, posix as pathPosix, win32 as pathWin32 } from "node:path";
import type { ExecutionBackend } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  createProjectExecutionContext,
  disposeProjectExecutionContext,
  resolveProjectLocation,
  type ProjectExecutionContextHooks,
} from "../execution-context.js";
import {
  WslDistroResolver,
  type WslAutomountConfig,
  type WslDistroInfo,
} from "../wsl/wsl-distro.js";
import { WslPathConverter } from "../wsl/wsl-paths.js";
import { createWslExecutionBackend } from "../wsl/wsl-execution-backend.js";
import { SettingsStore } from "../settings-store.js";
import {
  teamSnapshotPath,
  workspaceModePath,
} from "../team-persistence.js";
import { SessionBridge } from "../session-bridge.js";
import type { ProjectLocation } from "../../shared/project-location.js";

// ============================================================================
// Test harness (matches wsl.test.ts / team-manager.test.ts style)
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
    console.error(
      `  FAIL: ${message} - expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

async function assertRejects(promise: Promise<unknown>, message: string): Promise<void> {
  try {
    await promise;
    failed++;
    console.error(`  FAIL: ${message} - expected rejection`);
  } catch {
    passed++;
    console.log(`  PASS: ${message}`);
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
// Fakes
// ============================================================================

interface FakeResolverConfig {
  distros: WslDistroInfo[];
  home: string;
  automount: WslAutomountConfig;
}

/**
 * Fake WSL distro resolver. Extends WslDistroResolver so it is structurally
 * assignable to the `resolver?: WslDistroResolver` parameter; every async probe
 * is overridden to return canned values and record calls, so no wsl.exe is
 * spawned. requireDistro records the caller-supplied name verbatim and never
 * reads the default marker.
 */
class FakeResolver extends WslDistroResolver {
  readonly requireDistroCalls: string[] = [];
  readonly assertDirectoryCalls: Array<{ distro: string; logicalCwd: string }> = [];
  private readonly _distros: WslDistroInfo[];
  private readonly _home: string;
  private readonly _automount: WslAutomountConfig;
  failAssertDirectory = false;

  constructor(config: FakeResolverConfig) {
    super({ listTimeoutMs: 500, probeTimeoutMs: 500 });
    this._distros = config.distros;
    this._home = config.home;
    this._automount = config.automount;
  }

  override async list(): Promise<WslDistroInfo[]> {
    return this._distros;
  }

  override async requireDistro(name: string): Promise<WslDistroInfo> {
    this.requireDistroCalls.push(name);
    const match = this._distros.find((d) => d.name === name);
    if (!match) {
      throw new Error(
        `WSL distro "${name}" was not found. Install it or pick an available distro; ` +
          `the default distro is never substituted automatically.`,
      );
    }
    if (match.version !== 2) {
      throw new Error(
        `WSL distro "${name}" is version ${match.version}; PiX WSL support requires WSL2 (version 2).`,
      );
    }
    return match;
  }

  override async assertDirectory(distro: string, logicalCwd: string): Promise<void> {
    this.assertDirectoryCalls.push({ distro, logicalCwd });
    if (this.failAssertDirectory) {
      throw new Error(`Directory "${logicalCwd}" does not exist in WSL distro "${distro}".`);
    }
  }

  override async getHome(_distro: string): Promise<string> {
    return this._home;
  }

  override async getAutomountConfig(_distro: string): Promise<WslAutomountConfig> {
    return this._automount;
  }
}

function makeFakeResolver(): FakeResolver {
  return new FakeResolver({
    distros: [
      { name: "Ubuntu-22.04", state: "Running", version: 2, isDefault: true },
      { name: "Debian", state: "Stopped", version: 2, isDefault: false },
      { name: "OldDistro", state: "Running", version: 1, isDefault: false },
    ],
    home: "/home/u",
    automount: { enabled: true, root: "/mnt" },
  });
}

interface FakeBackendState {
  disposed: boolean;
  createCalls: number;
}

function makeFakeBackendFactory(state: FakeBackendState): typeof createWslExecutionBackend {
  const backend: ExecutionBackend = {
    paths: {
      pathStyle: "posix",
      homeDir: "/home/u",
      resolvePath: (input: string, cwd: string) => pathPosix.resolve(cwd, input),
    },
    runtimeEnvironment: {
      platform: "linux",
      osName: "WSL2 (Ubuntu-22.04)",
      shell: { kind: "wsl", path: "wsl.exe" },
    },
    getCwd: () => "/home/u/repo",
    dispose: async () => {
      state.disposed = true;
    },
  };
  const factory: typeof createWslExecutionBackend = async () => {
    state.createCalls++;
    return backend;
  };
  return factory;
}

function sha1(input: string): string {
  return createHash("sha1").update(input).digest("hex");
}

// A real Windows temp dir mapped to /mnt/<drive>/... so the physical-directory
// check in createProjectExecutionContext passes without a real distro.
function makeTempProject(): { physical: string; logical: string; name: string } {
  const physical = mkdtempSync(join(tmpdir(), "pix-exec-ctx-"));
  const converter = new WslPathConverter({
    distro: "Ubuntu-22.04",
    home: "/home/u",
    automountRoot: "/mnt",
    automountEnabled: true,
  });
  const logical = converter.windowsToLinux(physical);
  return { physical, logical, name: pathWin32.basename(physical) };
}

// ============================================================================
// Tests
// ============================================================================

await run("resolveProjectLocation: Windows input", async () => {
  const loc = await resolveProjectLocation({
    environment: { kind: "windows" },
    physicalPath: "C:\\proj\\app",
  });
  assertEqual(loc.path, "C:\\proj\\app", "Windows path === physicalPath");
  assertEqual(loc.physicalPath, "C:\\proj\\app", "Windows physicalPath preserved");
  assertEqual(loc.name, "app", "Windows name = win32.basename(physicalPath)");
  assertEqual(loc.environment.kind, "windows", "Windows environment kind");

  // logicalPath, when given, must equal physicalPath.
  await assertRejects(
    resolveProjectLocation({
      environment: { kind: "windows" },
      logicalPath: "C:\\proj\\app",
      physicalPath: "D:\\other",
    }),
    "Windows logicalPath != physicalPath rejects",
  );

  // logicalPath alone (old { path } shape) is accepted as physicalPath.
  const fromLogical = await resolveProjectLocation({
    environment: { kind: "windows" },
    logicalPath: "C:\\proj\\app",
  });
  assertEqual(fromLogical.physicalPath, "C:\\proj\\app", "Windows logicalPath-only fills physicalPath");

  // Relative physical path rejected.
  await assertRejects(
    resolveProjectLocation({ environment: { kind: "windows" }, physicalPath: "relative\\path" }),
    "Windows relative physicalPath rejects",
  );
});

await run("resolveProjectLocation: WSL ext4/drive round-trip", async () => {
  const resolver = makeFakeResolver();

  // ext4 path -> UNC
  const ext4 = await resolveProjectLocation(
    { environment: { kind: "wsl", distro: "Ubuntu-22.04" }, logicalPath: "/home/u/repo" },
    resolver,
  );
  assertEqual(ext4.path, "/home/u/repo", "WSL ext4 path is logical");
  assertEqual(
    ext4.physicalPath,
    "\\\\wsl.localhost\\Ubuntu-22.04\\home\\u\\repo",
    "WSL ext4 physicalPath is UNC",
  );
  assertEqual(ext4.name, "repo", "WSL name = posix.basename(logicalPath)");
  assertEqual(ext4.environment.kind, "wsl", "WSL environment kind");
  assertEqual(
    (ext4.environment as { distro: string }).distro,
    "Ubuntu-22.04",
    "WSL distro preserved verbatim",
  );

  // /mnt/c drive path -> Windows drive
  const drive = await resolveProjectLocation(
    { environment: { kind: "wsl", distro: "Ubuntu-22.04" }, logicalPath: "/mnt/c/Users/u/repo" },
    resolver,
  );
  assertEqual(drive.path, "/mnt/c/Users/u/repo", "WSL drive path is logical /mnt/c/...");
  assertEqual(drive.physicalPath, "C:\\Users\\u\\repo", "WSL drive physicalPath is C:\\...");

  // Both present and round-trip equal -> succeeds.
  const both = await resolveProjectLocation(
    {
      environment: { kind: "wsl", distro: "Ubuntu-22.04" },
      logicalPath: "/home/u/repo",
      physicalPath: "\\\\wsl.localhost\\Ubuntu-22.04\\home\\u\\repo",
    },
    resolver,
  );
  assertEqual(both.physicalPath, "\\\\wsl.localhost\\Ubuntu-22.04\\home\\u\\repo", "round-trip equal accepts physicalPath");

  // Both present but mismatched -> rejects.
  await assertRejects(
    resolveProjectLocation(
      {
        environment: { kind: "wsl", distro: "Ubuntu-22.04" },
        logicalPath: "/home/u/repo",
        physicalPath: "C:\\Users\\u\\repo",
      },
      resolver,
    ),
    "WSL mismatched physicalPath rejects",
  );

  // Relative logical path rejected.
  await assertRejects(
    resolveProjectLocation(
      { environment: { kind: "wsl", distro: "Ubuntu-22.04" }, logicalPath: "relative/path" },
      resolver,
    ),
    "WSL relative logicalPath rejects",
  );
});

await run("resolveProjectLocation: explicit distro missing fails, default never used", async () => {
  const resolver = makeFakeResolver();

  // Distro not in the list -> rejects.
  await assertRejects(
    resolveProjectLocation(
      { environment: { kind: "wsl", distro: "NonExistent" }, logicalPath: "/home/u/repo" },
      resolver,
    ),
    "missing distro rejects",
  );
  assert(
    resolver.requireDistroCalls.length === 1 && resolver.requireDistroCalls[0] === "NonExistent",
    "requireDistro called with caller's exact name (NonExistent), never a default",
  );

  // WSL1 distro -> rejects (version 2 only).
  await assertRejects(
    resolveProjectLocation(
      { environment: { kind: "wsl", distro: "OldDistro" }, logicalPath: "/home/u/repo" },
      resolver,
    ),
    "WSL1 distro rejects (version 2 required)",
  );

  // Empty distro -> rejects before the resolver is touched.
  const resolver2 = makeFakeResolver();
  await assertRejects(
    resolveProjectLocation(
      { environment: { kind: "wsl", distro: "" }, logicalPath: "/home/u/repo" } as unknown as Parameters<typeof resolveProjectLocation>[0],
      resolver2,
    ),
    "empty distro rejects",
  );
  assertEqual(resolver2.requireDistroCalls.length, 0, "empty distro never reaches resolver");

  // Missing logicalPath -> rejects.
  await assertRejects(
    resolveProjectLocation(
      { environment: { kind: "wsl", distro: "Ubuntu-22.04" } },
      makeFakeResolver(),
    ),
    "WSL missing logicalPath rejects",
  );

  // A successful resolve records the verbatim distro name, not the default marker.
  const resolver3 = makeFakeResolver();
  await resolveProjectLocation(
    { environment: { kind: "wsl", distro: "Debian" }, logicalPath: "/home/u/repo" },
    resolver3,
  );
  assert(
    resolver3.requireDistroCalls.length === 1 && resolver3.requireDistroCalls[0] === "Debian",
    "non-default distro Debian used verbatim; default (Ubuntu-22.04) never substituted",
  );
});

await run("createProjectExecutionContext: Windows isWsl=false, no backend", async () => {
  const tmp = makeTempProject();
  const location: ProjectLocation = {
    path: tmp.physical,
    physicalPath: tmp.physical,
    name: tmp.name,
    environment: { kind: "windows" },
  };
  const ctx = await createProjectExecutionContext(location);
  assertEqual(ctx.isWsl, false, "Windows context isWsl=false");
  assertEqual(ctx.logicalCwd, tmp.physical, "Windows logicalCwd === physicalCwd");
  assertEqual(ctx.physicalCwd, tmp.physical, "Windows physicalCwd set");
  assertEqual(ctx.executionBackend, undefined, "Windows context has no backend");
  assertEqual(ctx.runtimeEnvironmentOverride, undefined, "Windows context has no override");
  rmSync(tmp.physical, { recursive: true, force: true });
});

await run("createProjectExecutionContext: WSL isWsl=true, backend created", async () => {
  const tmp = makeTempProject();
  const location = await resolveProjectLocation(
    { environment: { kind: "wsl", distro: "Ubuntu-22.04" }, logicalPath: tmp.logical },
    makeFakeResolver(),
  );
  assertEqual(location.physicalPath, tmp.physical, "resolved physicalPath matches real temp dir");

  const state: FakeBackendState = { disposed: false, createCalls: 0 };
  const hooks: ProjectExecutionContextHooks = {
    resolver: makeFakeResolver(),
    createBackend: makeFakeBackendFactory(state),
  };
  const ctx = await createProjectExecutionContext(location, hooks);

  assertEqual(ctx.isWsl, true, "WSL context isWsl=true");
  assertEqual(ctx.logicalCwd, tmp.logical, "WSL logicalCwd is the POSIX path");
  assertEqual(ctx.physicalCwd, tmp.physical, "WSL physicalCwd is the Windows path");
  assert(ctx.logicalCwd !== ctx.physicalCwd, "WSL logicalCwd != physicalCwd (dual cwd)");
  assert(ctx.executionBackend !== undefined, "WSL context has a backend");
  assertEqual(state.createCalls, 1, "backend factory invoked exactly once");
  assertEqual(
    ctx.runtimeEnvironmentOverride?.platform,
    "linux",
    "WSL override exposes platform=linux",
  );
  assertEqual(
    ctx.runtimeEnvironmentOverride?.shell?.kind,
    "wsl",
    "WSL override exposes shell.kind=wsl",
  );

  // dispose delegates to the backend.
  await disposeProjectExecutionContext(ctx);
  assertEqual(state.disposed, true, "disposeProjectExecutionContext disposes the backend");

  // null-safe dispose.
  await disposeProjectExecutionContext(null);
  passed++;
  console.log("  PASS: disposeProjectExecutionContext(null) is a no-op");

  rmSync(tmp.physical, { recursive: true, force: true });
});

await run("createProjectExecutionContext: WSL validates distro + directories before backend", async () => {
  const tmp = makeTempProject();
  const location = await resolveProjectLocation(
    { environment: { kind: "wsl", distro: "Ubuntu-22.04" }, logicalPath: tmp.logical },
    makeFakeResolver(),
  );

  // Missing distro -> rejects before backend creation.
  const state1: FakeBackendState = { disposed: false, createCalls: 0 };
  await assertRejects(
    createProjectExecutionContext(
      { ...location, environment: { kind: "wsl", distro: "NonExistent" } },
      { resolver: makeFakeResolver(), createBackend: makeFakeBackendFactory(state1) },
    ),
    "WSL context with missing distro rejects",
  );
  assertEqual(state1.createCalls, 0, "backend not created when distro is missing");

  // test -d fails -> rejects before backend creation.
  const state2: FakeBackendState = { disposed: false, createCalls: 0 };
  const failingResolver = makeFakeResolver();
  failingResolver.failAssertDirectory = true;
  await assertRejects(
    createProjectExecutionContext(location, {
      resolver: failingResolver,
      createBackend: makeFakeBackendFactory(state2),
    }),
    "WSL context with failed test -d rejects",
  );
  assertEqual(state2.createCalls, 0, "backend not created when logical cwd test -d fails");

  // Physical directory missing -> rejects. Point physicalPath at a non-existent
  // path while keeping the logical cwd test -d passing (fake resolver).
  const state3: FakeBackendState = { disposed: false, createCalls: 0 };
  const badPhysicalLocation: ProjectLocation = {
    ...location,
    physicalPath: join(tmp.physical, "does-not-exist"),
  };
  await assertRejects(
    createProjectExecutionContext(badPhysicalLocation, {
      resolver: makeFakeResolver(),
      createBackend: makeFakeBackendFactory(state3),
    }),
    "WSL context with missing physical directory rejects",
  );
  assertEqual(state3.createCalls, 0, "backend not created when physical directory missing");

  rmSync(tmp.physical, { recursive: true, force: true });
});

await run("SettingsStore: old { path } -> Windows migration", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pix-settings-migrate-"));
  const realProject = mkdtempSync(join(tmpdir(), "pix-old-project-"));
  const settingsFile = join(cwd, "pix-settings.json");
  // Old schema: no schemaVersion, no wsl, ProjectInfo has only { path, name,
  // lastOpened, sessionCount }.
  writeFileSync(
    settingsFile,
    JSON.stringify({
      theme: "light",
      recentProjects: [
        { path: realProject, name: basename(realProject), lastOpened: 123, sessionCount: 0 },
      ],
    }),
    "utf-8",
  );

  const store = new SettingsStore({ cwd });
  const all = store.getAll();

  assertEqual(all.schemaVersion, 2, "migrated schemaVersion === 2");
  assert(all.wsl !== undefined, "wsl defaults populated");
  assertEqual(all.wsl?.enabled, false, "migrated wsl.enabled === false");
  assertEqual(all.wsl?.defaultCwd, "/home", "migrated wsl.defaultCwd === /home");

  assertEqual(all.recentProjects.length, 1, "one recent project after migration");
  const p = all.recentProjects[0]!;
  assertEqual(p.physicalPath, realProject, "migrated project physicalPath === path");
  assertEqual(p.path, realProject, "migrated Windows project path === physicalPath");
  assertEqual(p.environment.kind, "windows", "migrated project environment is windows");
  assertEqual(p.name, basename(realProject), "migrated project name preserved");

  rmSync(cwd, { recursive: true, force: true });
  rmSync(realProject, { recursive: true, force: true });
});

await run("SettingsStore: schemaVersion=2 JSON with physicalPath round-trips", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pix-settings-v2-"));
  const realProject = mkdtempSync(join(tmpdir(), "pix-v2-project-"));
  const settingsFile = join(cwd, "pix-settings.json");
  // Pre-write a v2 file with a ProjectInfo carrying physicalPath + environment.
  const wslProjectPhysical = "\\\\wsl.localhost\\Ubuntu-22.04\\home\\u\\repo";
  writeFileSync(
    settingsFile,
    JSON.stringify({
      schemaVersion: 2,
      theme: "dark",
      wsl: { enabled: true, distro: "Ubuntu-22.04", defaultCwd: "/home/u" },
      recentProjects: [
        {
          path: realProject,
          physicalPath: realProject,
          name: basename(realProject),
          environment: { kind: "windows" },
          lastOpened: 999,
          sessionCount: 3,
        },
        {
          path: "/home/u/repo",
          physicalPath: wslProjectPhysical,
          name: "repo",
          environment: { kind: "wsl", distro: "Ubuntu-22.04" },
          lastOpened: 888,
          sessionCount: 1,
        },
      ],
    }),
    "utf-8",
  );

  const store = new SettingsStore({ cwd });
  // getAll() prunes projects whose physical directory is missing. The Windows
  // temp dir exists; the WSL UNC does not, so it is pruned -- which itself
  // proves projectPathExists checks physicalPath (UNC), not the logical path.
  const all = store.getAll();

  assertEqual(all.schemaVersion, 2, "v2 file keeps schemaVersion === 2");
  assertEqual(all.theme, "dark", "v2 file theme preserved");
  assertEqual(all.wsl?.enabled, true, "v2 wsl.enabled preserved");
  assertEqual(all.wsl?.distro, "Ubuntu-22.04", "v2 wsl.distro preserved");

  const windowsProj = all.recentProjects.find((x) => x.environment.kind === "windows");
  assert(windowsProj !== undefined, "Windows project with existing physicalPath retained");
  assertEqual(windowsProj!.physicalPath, realProject, "Windows project physicalPath preserved");

  const wslProj = all.recentProjects.find((x) => x.environment.kind === "wsl");
  assert(wslProj === undefined, "WSL project with non-existent UNC physicalPath pruned (physicalPath check)");

  // The WSL project is NOT pruned when its physicalPath exists on the host.
  // Re-seed pointing the WSL entry at the real temp dir's physical path.
  writeFileSync(
    settingsFile,
    JSON.stringify({
      schemaVersion: 2,
      recentProjects: [
        {
          path: "/home/u/repo",
          physicalPath: realProject,
          name: "repo",
          environment: { kind: "wsl", distro: "Ubuntu-22.04" },
          lastOpened: 888,
          sessionCount: 1,
        },
      ],
    }),
    "utf-8",
  );
  const store2 = new SettingsStore({ cwd });
  const all2 = store2.getAll();
  const wslProj2 = all2.recentProjects.find((x) => x.environment.kind === "wsl");
  assert(wslProj2 !== undefined, "WSL project with existing physicalPath retained");
  assertEqual(wslProj2!.path, "/home/u/repo", "WSL project logical path preserved (not rewritten to physical)");
  assertEqual(wslProj2!.physicalPath, realProject, "WSL project physicalPath preserved");

  rmSync(cwd, { recursive: true, force: true });
  rmSync(realProject, { recursive: true, force: true });
});

await run("SettingsStore: addRecentProject records physicalPath for Windows", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pix-settings-add-"));
  const realProject = mkdtempSync(join(tmpdir(), "pix-add-project-"));
  const store = new SettingsStore({ cwd });

  store.addRecentProject(realProject, basename(realProject));
  const all = store.getAll();
  assertEqual(all.recentProjects.length, 1, "addRecentProject adds one entry");
  const p = all.recentProjects[0]!;
  assertEqual(p.physicalPath, realProject, "addRecentProject sets physicalPath === path");
  assertEqual(p.path, realProject, "addRecentProject Windows path === physicalPath");
  assertEqual(p.environment.kind, "windows", "addRecentProject records windows environment");

  // Dedup by physicalPath.
  store.addRecentProject(realProject, "renamed");
  const all2 = store.getAll();
  assertEqual(all2.recentProjects.length, 1, "addRecentProject dedups by physicalPath");
  assertEqual(all2.recentProjects[0]!.name, "renamed", "dedup updates name + lastOpened");

  rmSync(cwd, { recursive: true, force: true });
  rmSync(realProject, { recursive: true, force: true });
});

await run("Hash inputs: teamSnapshotPath / workspaceModePath / _getSessionDir use physicalCwd", async () => {
  const tmp = makeTempProject();
  const location = await resolveProjectLocation(
    { environment: { kind: "wsl", distro: "Ubuntu-22.04" }, logicalPath: tmp.logical },
    makeFakeResolver(),
  );
  const state: FakeBackendState = { disposed: false, createCalls: 0 };
  const ctx = await createProjectExecutionContext(location, {
    resolver: makeFakeResolver(),
    createBackend: makeFakeBackendFactory(state),
  });

  const physicalCwd = ctx.physicalCwd;
  const logicalCwd = ctx.logicalCwd;
  assert(physicalCwd !== logicalCwd, "physical and logical cwds differ for the hash test");

  const physicalHash = sha1(physicalCwd);
  const logicalHash = sha1(logicalCwd);
  assert(physicalHash !== logicalHash, "sha1(physicalCwd) != sha1(logicalCwd)");

  // teamSnapshotPath hashes its input; the contract is that callers pass
  // physicalCwd. Lock the formula and the distinctness from the logical key.
  assertEqual(
    teamSnapshotPath(physicalCwd),
    join(getAgentDir(), "team-state", physicalHash, "team.json"),
    "teamSnapshotPath(physicalCwd) uses sha1(physicalCwd)",
  );
  assert(
    teamSnapshotPath(physicalCwd) !== teamSnapshotPath(logicalCwd),
    "teamSnapshotPath(physicalCwd) != teamSnapshotPath(logicalCwd)",
  );

  assertEqual(
    workspaceModePath(physicalCwd),
    join(getAgentDir(), "team-state", physicalHash, "mode.json"),
    "workspaceModePath(physicalCwd) uses sha1(physicalCwd)",
  );
  assert(
    workspaceModePath(physicalCwd) !== workspaceModePath(logicalCwd),
    "workspaceModePath(physicalCwd) != workspaceModePath(logicalCwd)",
  );

  // _getSessionDir (session-bridge.ts) is private; invoke the REAL method via a
  // team-leader SessionBridge to assert it hashes its cwd input with the
  // identical sha1 formula. This fails if logicalCwd were fed to _getSessionDir
  // instead of physicalCwd (wsl_plan.md §6.2 / appendix item 10: three hash
  // sites use physicalCwd).
  const bridge = new SessionBridge({ role: "team-leader" });
  const bridgeAccess = bridge as unknown as {
    _getSessionDir: (cwd: string, defaultSessionDir: string | undefined) => string | undefined;
  };
  const physicalSessionDir = bridgeAccess._getSessionDir(physicalCwd, undefined);
  const logicalSessionDir = bridgeAccess._getSessionDir(logicalCwd, undefined);
  assert(physicalSessionDir !== undefined, "_getSessionDir(physicalCwd) returns a namespace for team-leader");
  assert(logicalSessionDir !== undefined, "_getSessionDir(logicalCwd) returns a namespace for team-leader");
  assert(
    physicalSessionDir !== logicalSessionDir,
    "_getSessionDir(physicalCwd) != _getSessionDir(logicalCwd)",
  );
  assertEqual(
    physicalSessionDir,
    join(getAgentDir(), "team-leader-sessions", physicalHash),
    "_getSessionDir(physicalCwd) === join(agentDir, team-leader-sessions, sha1(physicalCwd))",
  );
  assertEqual(
    logicalSessionDir,
    join(getAgentDir(), "team-leader-sessions", logicalHash),
    "_getSessionDir(logicalCwd) === join(agentDir, team-leader-sessions, sha1(logicalCwd))",
  );
  // The physical namespace must NOT end with the logical hash -- this is the
  // assertion that fails if logicalCwd were fed to _getSessionDir.
  assert(
    !physicalSessionDir!.endsWith(logicalHash),
    "_getSessionDir(physicalCwd) does NOT end with sha1(logicalCwd)",
  );
  // A single-role bridge returns the caller-provided default, not a hash
  // namespace, so solo sessions never accidentally use the team-leader namespace.
  const singleBridge = new SessionBridge({ role: "single" });
  const singleAccess = singleBridge as unknown as {
    _getSessionDir: (cwd: string, defaultSessionDir: string | undefined) => string | undefined;
  };
  assertEqual(
    singleAccess._getSessionDir(physicalCwd, "my-default"),
    "my-default",
    "_getSessionDir returns the default for single-role (no hash namespace)",
  );

  await disposeProjectExecutionContext(ctx);
  rmSync(tmp.physical, { recursive: true, force: true });
});

// ============================================================================
// Real WSL distro smoke test (gated; skip when unset)
// ============================================================================

await run("Real WSL distro: resolveProjectLocation + context", async () => {
  const distroEnv = process.env.PIX_WSL_TEST_DISTRO;
  if (!distroEnv) {
    console.log("  SKIP: set PIX_WSL_TEST_DISTRO to a WSL2 distro to enable real-WSL cases.");
    return;
  }
  console.log(`  PIX_WSL_TEST_DISTRO=${distroEnv}`);
  const realResolver = new WslDistroResolver({ listTimeoutMs: 15000, probeTimeoutMs: 30000 });
  const distros = await realResolver.list();
  assert(distros.length > 0, "real list() returns at least one distro");
  assert(distros.some((d) => d.name === distroEnv), `real list() includes ${distroEnv}`);
  const info = await realResolver.requireDistro(distroEnv);
  assertEqual(info.version, 2, `real ${distroEnv} is version 2`);
  const home = await realResolver.getHome(distroEnv);
  assert(home.startsWith("/"), "real getHome returns an absolute POSIX path");

  const loc = await resolveProjectLocation(
    { environment: { kind: "wsl", distro: distroEnv }, logicalPath: home },
    realResolver,
  );
  assert(loc.physicalPath.startsWith("\\\\wsl.localhost\\"), "real ext4 physicalPath is UNC");

  // createProjectExecutionContext performs real test -d + physical dir check +
  // backend warm-up. Only assert it does not throw and exposes isWsl=true.
  const ctx = await createProjectExecutionContext(loc);
  assertEqual(ctx.isWsl, true, "real WSL context isWsl=true");
  assert(ctx.executionBackend !== undefined, "real WSL context has a backend");
  await disposeProjectExecutionContext(ctx);
});

// ============================================================================

console.log(`\nPassed: ${passed}, Failed: ${failed}`);
if (failed > 0) {
  process.exit(1);
}
