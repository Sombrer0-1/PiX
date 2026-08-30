/**
 * SessionBridge ACP IPC / empty-session initial value tests (package E).
 *
 * Constructs the REAL SessionBridge against a temp agent dir and verifies
 * setAcp / getState.acp / compact gate / newSession defaultAcp / start
 * !isFlushed write / flushed header not overwritten.
 *
 * Run with: npx tsx src/main/__tests__/acp-session-bridge.test.ts
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { GuiSettings, ProjectLocation } from "../../shared/types.js";
import { SessionBridge } from "../session-bridge.js";

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

const AGENT_DIR = mkdtempSync(join(tmpdir(), "pix-acp-bridge-agent-"));
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

function makeLocation(cwd: string): ProjectLocation {
  return {
    path: cwd,
    physicalPath: cwd,
    name: basename(cwd),
    environment: { kind: "windows" },
  };
}

function makeGui(overrides: { defaultAcp?: boolean } = {}): GuiSettings {
  return {
    theme: "dark",
    recentProjects: [],
    ...overrides,
  } as GuiSettings;
}

interface BridgeAccess {
  _session: { sessionManager: SessionManager; isStreaming: boolean } | null;
}

function accessBridge(bridge: SessionBridge): BridgeAccess {
  return bridge as unknown as BridgeAccess;
}

function readHeaderAcp(sessionFile: string | undefined): boolean | undefined {
  if (!sessionFile || !existsSync(sessionFile)) return undefined;
  const first = readFileSync(sessionFile, "utf-8").split(/\r?\n/)[0];
  if (!first) return undefined;
  const header = JSON.parse(first) as { acp?: unknown };
  return header.acp === true ? true : header.acp === false ? false : undefined;
}

function listJsonl(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith(".jsonl")).map((name) => join(dir, name));
}

await run("empty session setAcp(true) -> getState().acp.enabled true", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pix-acp-set-"));
  const bridge = new SessionBridge();
  try {
    await bridge.start(makeLocation(cwd), makeGui());
    assertEqual(bridge.getState().acp?.enabled, false, "empty session starts ACP off");
    assertEqual(bridge.getState().acp?.locked, false, "empty session is unlocked");
    await bridge.setAcp(true);
    assertEqual(bridge.getState().acp?.enabled, true, "setAcp(true) enables ACP");
    assertEqual(bridge.getState().acp?.locked, false, "empty session remains unlocked after setAcp");
    assertEqual(accessBridge(bridge)._session!.sessionManager.getAcp(), true, "sessionManager.getAcp() is true");
  } finally {
    await bridge.dispose();
  }
});

await run("after appending a user message, setAcp throws ACP_LOCKED", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pix-acp-lock-"));
  const bridge = new SessionBridge();
  try {
    await bridge.start(makeLocation(cwd), makeGui());
    await bridge.setAcp(true);
    accessBridge(bridge)._session!.sessionManager.appendMessage({
      role: "user",
      content: "hello",
      timestamp: Date.now(),
    });
    assertEqual(bridge.getState().acp?.locked, true, "user message locks ACP");
    let threw = "";
    try {
      await bridge.setAcp(false);
    } catch (err) {
      threw = err instanceof Error ? err.message : String(err);
    }
    assertEqual(threw, "ACP_LOCKED", "setAcp after user message throws ACP_LOCKED");
    assertEqual(bridge.getState().acp?.enabled, true, "header acp stays true after locked setAcp");
  } finally {
    await bridge.dispose();
  }
});

await run("when getAcp(), compact throws ACP_COMPACTION_DISABLED", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pix-acp-compact-"));
  const bridge = new SessionBridge();
  try {
    await bridge.start(makeLocation(cwd), makeGui());
    await bridge.setAcp(true);
    let threw = "";
    try {
      await bridge.compact();
    } catch (err) {
      threw = err instanceof Error ? err.message : String(err);
    }
    assertEqual(threw, "ACP_COMPACTION_DISABLED", "compact throws ACP_COMPACTION_DISABLED when ACP is on");
  } finally {
    await bridge.dispose();
  }
});

await run("newSession with no parent and gui.defaultAcp===true -> header acp true", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pix-acp-new-"));
  const bridge = new SessionBridge();
  try {
    await bridge.start(makeLocation(cwd), makeGui({ defaultAcp: true }));
    await bridge.newSession();
    const sessionManager = accessBridge(bridge)._session!.sessionManager;
    assertEqual(sessionManager.getAcp(), true, "newSession writes header.acp true from defaultAcp");
    assertEqual(bridge.getState().acp?.enabled, true, "getState.acp.enabled is true after newSession");
    assertEqual(sessionManager.getHeader()?.acp, true, "in-memory header.acp is true");
  } finally {
    await bridge.dispose();
  }
});

await run("newSession(parentSession) reads the parent header acp", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pix-acp-parent-"));
  const parentOn = SessionManager.create(cwd, undefined, { acp: true });
  parentOn.appendMessage({ role: "user", content: "seed", timestamp: Date.now() });
  const parentOnFile = parentOn.getSessionFile();
  const parentOff = SessionManager.create(cwd);
  parentOff.appendMessage({ role: "user", content: "seed", timestamp: Date.now() });
  const parentOffFile = parentOff.getSessionFile();
  assert(
    typeof parentOnFile === "string" && existsSync(parentOnFile) && typeof parentOffFile === "string" && existsSync(parentOffFile),
    "both parents flushed to disk",
  );

  const bridge = new SessionBridge();
  try {
    await bridge.start(makeLocation(cwd), makeGui());
    await bridge.newSession(parentOnFile!);
    const onManager = accessBridge(bridge)._session!.sessionManager;
    assertEqual(onManager.getAcp(), true, "parent acp true overrides gui defaultAcp false");
    assertEqual(onManager.getHeader()?.parentSession, parentOnFile, "parent lineage recorded in header");

    await bridge.newSession(parentOffFile!);
    const offManager = accessBridge(bridge)._session!.sessionManager;
    assertEqual(offManager.getAcp(), false, "parent acp false seeds the empty child off");
    assertEqual(offManager.getHeader()?.parentSession, parentOffFile, "off parent lineage recorded in header");
  } finally {
    await bridge.dispose();
  }
});

await run("!isFlushed() start path writes defaultAcp", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pix-acp-start-empty-"));
  const bridge = new SessionBridge();
  try {
    await bridge.start(makeLocation(cwd), makeGui({ defaultAcp: true }));
    const sessionManager = accessBridge(bridge)._session!.sessionManager;
    assertEqual(sessionManager.isFlushed(), false, "fresh start with no recent file is unflushed");
    assertEqual(sessionManager.getAcp(), true, "unflushed start writes defaultAcp true");
    assertEqual(bridge.getState().acp?.enabled, true, "getState reflects defaultAcp on empty start");
  } finally {
    await bridge.dispose();
  }
});

await run("already-flushed file is not overwritten by defaultAcp", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pix-acp-start-flushed-"));
  const seed = SessionManager.create(cwd);
  seed.appendMessage({ role: "user", content: "seed", timestamp: Date.now() });
  const seedFile = seed.getSessionFile();
  assert(typeof seedFile === "string" && existsSync(seedFile), "seed session flushed to disk");
  assertEqual(readHeaderAcp(seedFile), undefined, "seed header omits acp");

  const jsonlBefore = listJsonl(seed.getSessionDir());
  const bridge = new SessionBridge();
  try {
    await bridge.start(makeLocation(cwd), makeGui({ defaultAcp: true }));
    const sessionManager = accessBridge(bridge)._session!.sessionManager;
    assertEqual(sessionManager.isFlushed(), true, "continueRecent opened the flushed file");
    assertEqual(sessionManager.getAcp(), false, "flushed header is not overwritten by defaultAcp");
    assertEqual(bridge.getState().acp?.enabled, false, "getState.acp.enabled stays false");
    assertEqual(readHeaderAcp(sessionManager.getSessionFile()), undefined, "on-disk header still omits acp");
    assertEqual(sessionManager.getSessionFile(), seedFile, "start resumed the seeded session file");
    const jsonlAfter = listJsonl(sessionManager.getSessionDir());
    assertEqual(jsonlAfter.length, jsonlBefore.length, "start did not create a replacement session file");
  } finally {
    await bridge.dispose();
  }
});

console.log(`\nPassed: ${passed}, Failed: ${failed}`);
if (failed > 0) {
  process.exit(1);
}
rmSync(AGENT_DIR, { recursive: true, force: true });
