import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { type AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { SessionBridge } from "../session-bridge.js";

const root = mkdtempSync(join(tmpdir(), "pix-session-flush-"));
const agentDir = join(root, "agent");
const projectDir = join(root, "project");
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
mkdirSync(agentDir);
mkdirSync(projectDir);
process.env.PI_CODING_AGENT_DIR = agentDir;
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ enableInstallTelemetry: false }));

after(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(root, { recursive: true, force: true });
});

for (const closePath of ["foreground", "background"] as const) {
  test(`${closePath} session close persists pending user messages`, async () => {
    const bridge = new SessionBridge();
    try {
      const cwd = join(projectDir, closePath);
      mkdirSync(cwd);
      await bridge.start(cwd);
      const access = bridge as unknown as {
        _session: AgentSession;
        _detachActiveSession: () => boolean;
      };
      const manager = access._session.sessionManager;
      const persist = manager._persist;
      const text = `${closePath} message awaiting persistence`;
      // Model a message that is present in memory but has not reached JSONL yet.
      manager._persist = () => {};
      try {
        manager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
      } finally {
        manager._persist = persist;
      }
      const sessionFile = manager.getSessionFile();
      assert.ok(sessionFile);
      assert.equal(existsSync(sessionFile), false);

      if (closePath === "foreground") {
        await bridge.newSession();
      } else {
        assert.equal(access._detachActiveSession(), true);
        await bridge.dispose();
      }

      assert.equal(existsSync(sessionFile), true, "close must flush the pending session to disk");
      const reopened = SessionManager.open(sessionFile);
      assert.ok(reopened.getEntries().some((entry) =>
        entry.type === "message" && entry.message.role === "user" && entry.message.content === text,
      ));
    } finally {
      await bridge.dispose();
    }
  });
}
