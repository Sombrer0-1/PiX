import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const fixture = new URL("../../packages/pix-runtime/test/fixtures/faux-extension.mjs", import.meta.url);
const app = process.env.PIX_PACKAGED_EXE;
const cli = fileURLToPath(new URL("../../packages/pix-cli/dist/cli.js", import.meta.url));

test("packaged desktop Solo runs native agent and a workflow worker", {
  skip: !app && "Set PIX_PACKAGED_EXE to the packaged PiX executable",
  timeout: 45_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "pix-packaged-workflow-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await mkdir(cwd);
  await copyFile(fileURLToPath(fixture), join(agentDir, "extensions", "faux-extension.ts"));
  const child = spawn(resolve(app), ["--remote-debugging-port=0", `--user-data-dir=${join(root, "electron")}`], {
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PIX_TEST_KEY: "test-cli-key" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let diagnostic = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => { diagnostic += chunk; });
  child.stdout.resume();
  const exited = new Promise((done) => child.once("exit", done));
  let socket;
  try {
    let debuggerUrl;
    for (let attempt = 0; attempt < 160 && child.exitCode === null; attempt++) {
      debuggerUrl = /DevTools listening on (ws:\/\/[^\s]+)/.exec(diagnostic)?.[1];
      if (debuggerUrl) break;
      await delay(100);
    }
    assert.ok(debuggerUrl, diagnostic);
    let page;
    for (let attempt = 0; attempt < 100; attempt++) {
      const targets = await fetch(`http://${new URL(debuggerUrl).host}/json/list`).then((response) => response.json());
      page = targets.find((target) => target.type === "page" && target.url.startsWith("file:"));
      if (page) break;
      await delay(100);
    }
    assert.ok(page, diagnostic);
    socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((done, reject) => {
      socket.addEventListener("open", done, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    let nextId = 0;
    const evaluate = (expression) => new Promise((done, reject) => {
      const id = ++nextId;
      function onMessage(message) {
        const reply = JSON.parse(message.data);
        if (reply.id !== id) return;
        socket.removeEventListener("message", onMessage);
        if (reply.error || reply.result.exceptionDetails) {
          reject(new Error(JSON.stringify(reply.error ?? reply.result.exceptionDetails)));
        } else {
          done(reply.result.result.value);
        }
      }
      socket.addEventListener("message", onMessage);
      socket.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
    });
    for (let attempt = 0; attempt < 100 && !await evaluate("Boolean(window.pixApi)"); attempt++) {
      await delay(100);
    }
    const outcome = await evaluate(`(async () => {
      const api = window.pixApi;
      const cwd = ${JSON.stringify(cwd)};
      const results = [];
      const stop = api.onPiEvent(event => {
        if (event.type === "tool_execution_end") results.push(event);
      });
      const start = await api.startPi({ path: cwd, physicalPath: cwd, name: "test", environment: { kind: "windows" } });
      const model = await api.sendCommand({ type: "set_model", provider: "pix-test", modelId: "test" });
      const delegate = await api.sendCommand({ type: "prompt", message: "delegate foreground" });
      const workflow = await api.sendCommand({ type: "prompt", message: "workflow" });
      const history = await api.sendWorkflowCommand({ type: "get_snapshot" });
      const tasks = await api.sendAgentTaskCommand({ type: "get_all" });
      const state = await api.sendCommand({ type: "get_state" });
      stop();
      return { start, model, delegate, workflow, history, tasks, state, results };
    })()`);
    for (const key of ["start", "model", "delegate", "workflow", "history", "tasks", "state"]) {
      assert.equal(outcome[key].success, true, JSON.stringify(outcome));
    }
    assert.deepEqual(
      outcome.results.map(({ toolName, isError }) => [toolName, isError]),
      [["agent", false], ["workflow", false]],
      JSON.stringify(outcome.results),
    );
    assert.equal(outcome.history.data[0].stopReason, "completed");
    const childId = outcome.history.data[0].members[0].childId;
    assert.equal(outcome.tasks.data.tasks.length, 2);
    assert.ok(outcome.tasks.data.tasks.some((task) => task.taskId === childId));
    assert.ok(outcome.tasks.data.tasks.every((task) => task.status === "completed" && task.parentSessionId === outcome.state.data.sessionId));
    assert.match(outcome.results[1].result.content[0].text, /child completed/);
    await evaluate("window.pixApi.stopPi()");
    const records = await readFile(outcome.state.data.sessionFile, "utf8");
    assert.match(records, /"kind":"run-end","runId":"[^"]+","stopReason":"completed"/);
    if (process.platform === "win32") {
      const version = spawnSync("powershell.exe", [
        "-NoProfile", "-Command", "(Get-Item -LiteralPath $env:PIX_PACKAGED_EXE).VersionInfo.FileVersion",
      ], { env: { ...process.env, PIX_PACKAGED_EXE: resolve(app) }, encoding: "utf8", windowsHide: true });
      const cliVersion = spawnSync(process.execPath, [cli, "--version"], { encoding: "utf8" });
      assert.equal(version.status, 0, version.stderr);
      assert.equal(cliVersion.status, 0, cliVersion.stderr);
      assert.equal(version.stdout.trim(), cliVersion.stdout.trim());
    }
    await evaluate("void window.pixApi.windowClose()");
    await exited;
    assert.equal(child.exitCode, 0, diagnostic);
  } finally {
    socket?.close();
    if (child.exitCode === null) child.kill();
    await exited;
    await rm(root, { recursive: true, force: true });
  }
});
