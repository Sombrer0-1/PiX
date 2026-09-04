/**
 * SessionBridge engine fingerprint cache tests (S8).
 *
 * SDD 4.7 verification outcome: ModelRegistry instances carry mutable
 * per-session state (extensions mutate models/registeredProviders via
 * pi.registerProvider under the default "mutable" provider policy, and the
 * registry-owned AuthStorage keeps an in-memory credential snapshot), so the
 * S8 DOWNGRADE path applies: the registry is rebuilt fresh every generation
 * and no registry instance is cached. What remains cached on this side is the
 * settings.json parse result (stat fingerprint, instance still per
 * generation) plus the start()->_createSession settings manager reuse.
 *
 * These tests pin, through session-bridge-observable points only:
 *  - exactly one ModelRegistry.create per generation (fresh-registry invariant
 *    of the downgrade; a distinct registry + AuthStorage per generation);
 *  - an auth.json rewrite is observed by the NEXT generation (the downgrade
 *    equivalent of the SDD's "auth.json touch rebuilds the registry");
 *  - unchanged settings.json stats are served from the parse cache (no
 *    settings.json re-read across generations);
 *  - a settings.json write invalidates the parse cache and forces a re-read.
 *
 * Run with: npx tsx src/main/__tests__/engine-fingerprint-cache.test.ts
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { ModelRegistry, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { GuiSettings, ProjectLocation } from "../../shared/types.js";
import { SessionBridge, settingsParseCacheMetrics } from "../session-bridge.js";

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

const AGENT_DIR = mkdtempSync(join(tmpdir(), "pix-s8-engine-agent-"));
process.env.PI_CODING_AGENT_DIR = AGENT_DIR;
mkdirSync(join(AGENT_DIR, "agents"), { recursive: true });

const MODELS_JSON = {
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
};

writeFileSync(join(AGENT_DIR, "models.json"), JSON.stringify(MODELS_JSON, null, 2), "utf-8");

// --- Observable instrumentation (session-bridge level only) ---------------

let registryCreateCalls = 0;
const originalRegistryCreate = ModelRegistry.create;
ModelRegistry.create = ((...args: Parameters<typeof ModelRegistry.create>) => {
  registryCreateCalls++;
  return originalRegistryCreate.apply(ModelRegistry, args);
}) as typeof ModelRegistry.create;

let settingsCreateCalls = 0;
const originalSettingsCreate = SettingsManager.create;
SettingsManager.create = ((...args: Parameters<typeof SettingsManager.create>) => {
  settingsCreateCalls++;
  return originalSettingsCreate.apply(SettingsManager, args);
}) as typeof SettingsManager.create;

// --- Helpers ---------------------------------------------------------------

interface BridgeSessionAccess {
  modelRegistry: { authStorage: { get(provider: string): unknown } };
  settingsManager: unknown;
}

interface BridgeAccess {
  _session: BridgeSessionAccess | null;
}

function currentSession(bridge: SessionBridge): BridgeSessionAccess {
  const access = bridge as unknown as BridgeAccess;
  if (!access._session) throw new Error("No active session");
  return access._session;
}

function credentialKey(session: BridgeSessionAccess): string | undefined {
  const credential = session.modelRegistry.authStorage.get("faux") as { key?: unknown } | undefined;
  return typeof credential?.key === "string" ? credential.key : undefined;
}

function makeLocation(cwd: string): ProjectLocation {
  return {
    path: cwd,
    physicalPath: cwd,
    name: basename(cwd),
    environment: { kind: "windows" },
  };
}

function makeGui(): GuiSettings {
  return { theme: "dark", recentProjects: [] } as GuiSettings;
}

function makeProjectDir(): string {
  const cwd = mkdtempSync(join(tmpdir(), "pix-s8-engine-"));
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  return cwd;
}

function writeGlobalSettings(content: Record<string, unknown>): void {
  writeFileSync(join(AGENT_DIR, "settings.json"), JSON.stringify(content, null, 2), "utf-8");
}

function writeProjectSettings(cwd: string, content: Record<string, unknown>): void {
  writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify(content, null, 2), "utf-8");
}

// --- Tests -----------------------------------------------------------------

await run("unchanged inputs: fresh registry per generation, settings parse cache hits", async () => {
  const cwd = makeProjectDir();
  writeGlobalSettings({ theme: "dark" });
  writeProjectSettings(cwd, { quietStartup: true });
  const diskReadsBaseline = settingsParseCacheMetrics.diskReads;

  const bridge = new SessionBridge();
  try {
    await bridge.start(makeLocation(cwd), makeGui());
    const session1 = currentSession(bridge);
    assertEqual(registryCreateCalls, 1, "generation 1 builds exactly one registry");
    assertEqual(
      settingsParseCacheMetrics.diskReads - diskReadsBaseline,
      2,
      "generation 1 parses global + project settings once",
    );
    assertEqual(settingsCreateCalls, 0, "settings manager built via cached-storage path, never SettingsManager.create");

    await bridge.newSession();
    const session2 = currentSession(bridge);
    assertEqual(registryCreateCalls, 2, "generation 2 rebuilds the registry (S8 downgrade: no instance cache)");
    assert(
      session2.modelRegistry !== session1.modelRegistry,
      "each generation gets a distinct ModelRegistry instance",
    );
    assertEqual(
      settingsParseCacheMetrics.diskReads - diskReadsBaseline,
      2,
      "parse cache hit: settings.json not re-read for generation 2",
    );

    await bridge.newSession();
    const session3 = currentSession(bridge);
    assertEqual(registryCreateCalls, 3, "generation 3 rebuilds the registry");
    assert(
      session3.settingsManager !== session2.settingsManager,
      "settings manager instances stay per-generation",
    );
    assertEqual(
      settingsParseCacheMetrics.diskReads - diskReadsBaseline,
      2,
      "parse cache still hit on generation 3",
    );
  } finally {
    await bridge.dispose();
    rmSync(cwd, { recursive: true, force: true });
  }
});

await run("settings.json write invalidates the parse cache and forces a re-read", async () => {
  const cwd = makeProjectDir();
  writeGlobalSettings({ theme: "dark" });
  writeProjectSettings(cwd, {});
  const diskReadsBaseline = settingsParseCacheMetrics.diskReads;

  const bridge = new SessionBridge();
  try {
    await bridge.start(makeLocation(cwd), makeGui());
    const readsAfterStart = settingsParseCacheMetrics.diskReads - diskReadsBaseline;
    assertEqual(readsAfterStart, 2, "initial generation parses both settings files");

    // Different content length guarantees a stat (size) change.
    writeGlobalSettings({ theme: "dark", quietStartup: true, collapseChangelog: true });
    await bridge.newSession();

    assert(
      settingsParseCacheMetrics.diskReads - diskReadsBaseline > readsAfterStart,
      "cache miss after settings.json write: settings re-read for the new generation",
    );
  } finally {
    await bridge.dispose();
    rmSync(cwd, { recursive: true, force: true });
  }
});

await run("auth.json rewrite is observed by the next generation's fresh registry", async () => {
  const cwd = makeProjectDir();
  writeGlobalSettings({ theme: "dark" });
  writeFileSync(
    join(AGENT_DIR, "auth.json"),
    JSON.stringify({ faux: { type: "api_key", key: "key-one" } }, null, 2),
    "utf-8",
  );

  const bridge = new SessionBridge();
  try {
    await bridge.start(makeLocation(cwd), makeGui());
    const session1 = currentSession(bridge);
    assertEqual(credentialKey(session1), "key-one", "generation 1 reads the initial auth.json");

    // Different key length guarantees a stat (size) change.
    writeFileSync(
      join(AGENT_DIR, "auth.json"),
      JSON.stringify({ faux: { type: "api_key", key: "key-two-much-longer" } }, null, 2),
      "utf-8",
    );
    await bridge.newSession();
    const session2 = currentSession(bridge);
    assert(
      session2.modelRegistry !== session1.modelRegistry,
      "registry is rebuilt rather than reused across generations",
    );
    assertEqual(
      credentialKey(session2),
      "key-two-much-longer",
      "fresh rebuild observes the rewritten auth.json",
    );
  } finally {
    await bridge.dispose();
    rmSync(cwd, { recursive: true, force: true });
  }
});

// --- Teardown --------------------------------------------------------------

ModelRegistry.create = originalRegistryCreate;
SettingsManager.create = originalSettingsCreate;
rmSync(AGENT_DIR, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
