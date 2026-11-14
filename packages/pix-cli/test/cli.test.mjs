import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { readSessionInfo, SessionManager, sidecarPathForSessionFile } from "@earendil-works/pi-coding-agent";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { CliSessionFiles } from "../dist/session-files.js";

const cli = process.env.PIX_TEST_CLI ?? fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const extension = fileURLToPath(new URL("../../pix-runtime/test/fixtures/faux-extension.mjs", import.meta.url));

async function fixture(t) {
	const root = await mkdtemp(join(tmpdir(), "pix-cli-test-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	const tmp = join(root, "tmp");
	await Promise.all([mkdir(cwd), mkdir(agentDir), mkdir(tmp)]);
	const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, TEMP: tmp, TMP: tmp, TMPDIR: tmp };
	const fixtureExtension = join(cwd, "faux-extension.mjs");
	await copyFile(extension, fixtureExtension);
	const args = [cli, "--offline", "-e", fixtureExtension, "--model", "pix-test/test", "--api-key", "test-cli-key"];
	return { root, cwd, agentDir, tmp, env, args };
}

function rpc(t, fixture, extra = []) {
	const child = spawn(process.execPath, [...fixture.args, "--mode", "rpc", ...extra], { cwd: fixture.cwd, env: fixture.env });
	const messages = [];
	const emitter = createInterface({ input: child.stdout });
	let stderr = "";
	let id = 0;
	child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
	emitter.on("line", (line) => messages.push(JSON.parse(line)));
	const exited = once(child, "close");
	t.after(async () => { if (child.exitCode === null) child.kill(); await exited; });
	async function waitFor(predicate, after = 0) {
		for (let count = 0; count < 500; count++) {
			const message = messages.slice(after).find(predicate);
			if (message) return message;
			if (child.exitCode !== null) break;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		assert.fail(`No matching RPC message. stderr=${stderr}\nMessages=${JSON.stringify(messages.slice(after))}`);
	}
	return {
		messages,
		waitFor,
		write(value) { child.stdin.write(`${JSON.stringify(value)}\n`); },
		async call(type, payload = {}) {
			const commandId = `${++id}`;
			this.write({ type, id: commandId, ...payload });
			return waitFor((message) => message.type === "response" && message.id === commandId);
		},
		async close() {
			child.stdin.end();
			assert.deepEqual(await exited, [0, null], stderr);
		},
	};
}

test("compiled pix version and help run without starting a runtime", async (t) => {
	const f = await fixture(t);
	const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
	const version = spawnSync(process.execPath, [cli, "--version"], { cwd: f.cwd, env: f.env, encoding: "utf8" });
	assert.equal(version.status, 0, version.stderr);
	assert.equal(version.stdout.trim(), manifest.version);
	const help = spawnSync(process.execPath, [cli, "--help"], { cwd: f.cwd, env: f.env, encoding: "utf8" });
	assert.equal(help.status, 0, help.stderr);
	assert.match(help.stdout, /pix-cli-sessions/);
	assert.match(help.stdout, /--no-acp/);
	assert.deepEqual((await readdir(f.tmp)).filter((name) => name.startsWith("pix-cli-")), []);
});

test("compiled pix JSONL runs agent and real workflow worker with CLI model and key", async (t) => {
	const f = await fixture(t);
	const result = spawnSync(process.execPath, [...f.args, "--mode", "json", "delegate", "workflow"], {
		cwd: f.cwd, env: f.env, encoding: "utf8", timeout: 15000,
	});
	assert.equal(result.status, 0, result.stderr || result.error?.message);
	const events = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
	const tasks = events.filter((event) => event.type === "task_state" && event.task.status === "completed");
	assert.equal(tasks.length, 2, JSON.stringify(events.filter((event) => event.type === "tool_execution_end")));
	assert.ok(tasks.every((event) => event.task.parentSessionId === event.sessionId && event.task.finalOutput === "child completed"));
	const workflow = events.find((event) => event.type === "workflow_event" && event.event.run.status === "completed");
	assert.equal(workflow?.event.run.members[0]?.childId, tasks[1].task.taskId);
	const [file] = await readdir(join(f.agentDir, "pix-cli-sessions"));
	const log = await readFile(join(f.agentDir, "pix-cli-sessions", file), "utf8");
	assert.match(log, /"kind":"run-end","runId":"[^"]+","stopReason":"completed"/);
	assert.doesNotMatch(log, /test-cli-key/);
	assert.deepEqual((await readdir(f.tmp)).filter((name) => name.startsWith("pix-cli-")), []);
});

test("RPC input, ACP, session locking and workflow cache use the compiled host", async (t) => {
	const f = await fixture(t);
	const first = rpc(t, f, ["--session-id", "first", "--acp"]);
	assert.deepEqual((await first.call("get_acp")).data, { enabled: true, locked: false });
	assert.deepEqual((await first.call("set_acp", { enabled: false })).data, { enabled: false, locked: false });
	const state = (await first.call("get_state")).data;
	const second = rpc(t, f, ["--session-id", "second"]);
	const secondState = (await second.call("get_state")).data;
	const blocked = await second.call("switch_session", { sessionPath: state.sessionFile });
	assert.equal(blocked.success, false);
	assert.match(blocked.error, /in use/);
	assert.equal((await second.call("get_state")).data.sessionFile, secondState.sessionFile);
	const beforeAsk = first.messages.length;
	await first.call("prompt", { message: "ask" });
	const question = await first.waitFor((event) => event.type === "extension_ui_request" && event.method === "request_user_input", beforeAsk);
	first.write({ type: "extension_ui_response", id: question.id, answers: { answer: "Confirmed" } });
	await first.waitFor((event) => event.type === "agent_end", beforeAsk);
	const locked = await first.call("set_acp", { enabled: true });
	assert.equal(locked.success, false);
	assert.match(locked.error, /ACP_LOCKED/);
	let after = first.messages.length;
	await first.call("prompt", { message: "workflow" });
	await first.waitFor((event) => event.type === "agent_end", after);
	const firstRun = (await first.call("list_workflows")).data.at(-1);
	assert.equal(firstRun.status, "completed");
	const childId = firstRun.members[0].childId;
	assert.equal((await first.call("get_task", { taskId: childId })).data.status, "completed");
	after = first.messages.length;
	await first.call("prompt", { message: "workflow" });
	await first.waitFor((event) => event.type === "agent_end", after);
	const repeated = (await first.call("list_workflows")).data.at(-1);
	assert.notEqual(repeated.runId, firstRun.runId);
	const cacheResult = first.messages.slice(after).find((event) => event.type === "tool_execution_end" && event.toolName === "workflow");
	assert.equal(cacheResult?.result.details.value.childId, childId);
	assert.equal(repeated.members.length, 0);
	await first.close();
	assert.equal((await second.call("switch_session", { sessionPath: state.sessionFile })).success, true);
	assert.equal((await second.call("get_task", { taskId: childId })).success, false);
	assert.equal((await second.call("list_workflows")).data.length, 2);
	after = second.messages.length;
	await second.call("prompt", { message: "workflow" });
	await second.waitFor((event) => event.type === "agent_end", after);
	const fresh = (await second.call("list_workflows")).data.at(-1);
	assert.equal(fresh.status, "completed");
	assert.notEqual(fresh.members[0].childId, childId);
	await second.close();
	assert.deepEqual((await readdir(f.tmp)).filter((name) => name.startsWith("pix-cli-")), []);
});

test("CLI file operations migrate under lock and preserve imported ACP state and entry IDs", async (t) => {
	const f = await fixture(t);
	const source = SessionManager.create(f.cwd, f.root, { acp: true });
	const messageId = source.appendMessage({ role: "user", content: "Historical prompt", timestamp: Date.now() });
	const sourcePath = source.getSessionFile();
	const original = await readFile(sourcePath, "utf8");
	const sidecar = `${JSON.stringify({ version: 1, state: { nextBlockId: 2, blocks: [{
		blockId: "b1", runId: "r1", tier: 1, summary: "Historical summary",
		directMessageIds: [messageId], effectiveMessageIds: [messageId], directBlockIds: [],
		compressedTokens: 4, createdAt: 1, survivedCount: 0, generation: "young", active: true,
	}] } })}\n`;
	await writeFile(sidecarPathForSessionFile(sourcePath), sidecar);
	const host = new CliSessionFiles(false);
	const sessionDir = host.resolveSessionDir({ agentDir: f.agentDir, sessionDir: "project" });
	assert.throws(() => host.resolveSessionDir({ agentDir: f.agentDir, sessionDir: "../elsewhere" }), /inside/);
	const context = { cwd: f.cwd, sessionDir };
	const legacyPath = join(sessionDir, "legacy.jsonl");
	await mkdir(sessionDir, { recursive: true });
	const legacy = [
		{ type: "session", id: "legacy", cwd: f.cwd, timestamp: new Date().toISOString() },
		{ type: "message", timestamp: new Date().toISOString(), message: { role: "user", content: "Old format", timestamp: Date.now() } },
	].map((entry) => `${JSON.stringify(entry)}\n`).join("");
	const legacyLock = await host.create({ ...context, id: "legacy" });
	await writeFile(legacyPath, legacy);
	await assert.rejects(host.open({ path: legacyPath, ...context }), /in use/);
	assert.equal(await readFile(legacyPath, "utf8"), legacy);
	await host.release(legacyLock);
	const migrated = await host.open({ path: legacyPath, ...context });
	assert.equal(migrated.getHeader().version, 3);
	assert.equal(migrated.getEntries()[0].message.content, "Old format");
	await host.release(migrated);
	const imported = await host.open({ path: sourcePath, ...context });
	const repeated = await host.import({ sourcePath, ...context });
	assert.notEqual(imported.getSessionId(), repeated.getSessionId());
	assert.equal(imported.getAcp(), true);
	assert.equal(imported.getEntry(messageId).message.content, "Historical prompt");
	assert.equal(await readFile(sidecarPathForSessionFile(imported.getSessionFile()), "utf8"), sidecar);
	assert.equal(await readFile(sourcePath, "utf8"), original);
	assert.equal(await readFile(sidecarPathForSessionFile(sourcePath), "utf8"), sidecar);
	const branch = await host.branch({ source: imported, leafId: messageId, ...context });
	assert.equal(branch.getHeader().parentSession, imported.getSessionFile());
	assert.ok(branch.getEntry(messageId));
	assert.equal(await readFile(sidecarPathForSessionFile(branch.getSessionFile()), "utf8"), sidecar);
	const blank = await host.branch({ source: imported, leafId: null, ...context });
	assert.equal(blank.getAcp(), true);
	await assert.rejects(readFile(sidecarPathForSessionFile(blank.getSessionFile())), { code: "ENOENT" });
	const inUse = repeated.getSessionFile();
	await assert.rejects(host.rename({ path: inUse, name: "Name" }), /in use/);
	await host.release(repeated);
	await host.rename({ path: inUse, name: "Renamed" });
	const renamed = await host.open({ path: inUse, ...context });
	assert.equal(renamed.getSessionName(), "Renamed");
	await host.delete({ path: inUse, active: renamed });
	await assert.rejects(readFile(inUse), { code: "ENOENT" });
	await assert.rejects(readFile(sidecarPathForSessionFile(inUse)), { code: "ENOENT" });
	await Promise.all([host.release(imported), host.release(branch), host.release(blank)]);
	const result = spawnSync(process.execPath, [...f.args, "--mode", "json", "--no-acp", "--session", sourcePath, "ACP check"], {
		cwd: f.cwd, env: f.env, encoding: "utf8", timeout: 15000,
	});
	assert.equal(result.status, 0, result.stderr || result.error?.message);
	const events = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
	const decompress = events.find((event) => event.type === "tool_execution_end" && event.toolName === "decompress");
	assert.equal(decompress?.isError, false, JSON.stringify(decompress));
	assert.match(decompress.result.content[0].text, /Historical (prompt|summary)/);
	assert.equal(await readFile(sidecarPathForSessionFile(sourcePath), "utf8"), sidecar);
});

test("RPC list mutations share the session lock and startup failures release it", async (t) => {
	const f = await fixture(t);
	const failed = spawnSync(process.execPath, [...f.args, "--session-id", "retry", "@missing.txt", "-p", "fail"], {
		cwd: f.cwd, env: f.env, encoding: "utf8", timeout: 15000,
	});
	assert.equal(failed.status, 1, failed.stderr || failed.error?.message);
	assert.deepEqual((await readdir(f.tmp)).filter((name) => name.startsWith("pix-cli-")), []);
	const app = rpc(t, f, ["--session-id", "retry", "--name", "First name"]);
	const current = (await app.call("get_state")).data.sessionFile;
	const invalidPath = join(f.agentDir, "pix-cli-sessions", "invalid.jsonl");
	const invalidContent = '{"type":"event","data":"not a session"}\n';
	await writeFile(invalidPath, invalidContent);
	const invalid = await app.call("switch_session", { sessionPath: invalidPath });
	assert.equal(invalid.success, false);
	assert.match(invalid.error, /not a valid pi session/);
	assert.equal(await readFile(invalidPath, "utf8"), invalidContent);
	assert.equal((await app.call("get_state")).data.sessionFile, current);
	assert.ok(!(await readdir(join(f.agentDir, "pix-cli-sessions"))).includes("invalid.jsonl.lock"));
	const imported = await app.call("import_session", { path: current });
	assert.equal(imported.success, false);
	await app.call("prompt", { message: "hello" });
	await app.waitFor((event) => event.type === "agent_end");
	assert.equal((await app.call("rename_session", { path: current, name: "New name" })).success, true);
	assert.equal((await readSessionInfo(current)).name, "New name");
	assert.equal((await app.call("delete_session", { path: current })).success, true);
	assert.notEqual((await app.call("get_state")).data.sessionFile, current);
	await assert.rejects(readFile(current), { code: "ENOENT" });
	await app.close();
});

test("RPC exposes session history and clears queued messages without aborting the active turn", async (t) => {
	const f = await fixture(t);
	const app = rpc(t, f);
	const initial = (await app.call("get_entries")).data;
	assert.deepEqual(initial.entries.map((entry) => entry.type), ["model_change", "thinking_level_change"]);
	assert.equal(initial.entries.at(-1).id, initial.leafId);

	assert.equal((await app.call("prompt", { message: "ask" })).success, true);
	const question = await app.waitFor((event) => event.type === "extension_ui_request" && event.method === "request_user_input");
	assert.equal((await app.call("steer", { message: "Queued steering" })).success, true);
	assert.equal((await app.call("follow_up", { message: "Queued follow-up" })).success, true);
	assert.deepEqual((await app.call("clear_queue")).data, {
		steering: ["Queued steering"],
		followUp: ["Queued follow-up"],
	});
	assert.deepEqual((await app.call("clear_queue")).data, { steering: [], followUp: [] });
	app.write({ type: "extension_ui_response", id: question.id, answers: { answer: "Confirmed" } });
	await app.waitFor((event) => event.type === "agent_end");

	const { entries, leafId } = (await app.call("get_entries")).data;
	assert.equal(entries.at(-1).id, leafId);
	const userEntries = entries.filter((entry) => entry.type === "message" && entry.message.role === "user");
	assert.deepEqual(userEntries.map((entry) => entry.message.content), [[{ type: "text", text: "ask" }]]);
	assert.deepEqual((await app.call("get_entries", { since: entries[0].id })).data, { entries: entries.slice(1), leafId });
	assert.deepEqual((await app.call("get_entries", { since: leafId })).data, { entries: [], leafId });
	assert.equal((await app.call("get_entries", { since: "missing" })).error, "Entry not found: missing");
	const tree = (await app.call("get_tree")).data;
	assert.equal(tree.leafId, leafId);
	assert.equal(tree.tree[0].entry.id, entries[0].id);
	assert.equal(tree.tree[0].children[0].entry.id, entries[1].id);
	await app.close();
});

test("RPC Plan approval is distinct from execution and restores an imported orphan as retryable", async (t) => {
	const f = await fixture(t);
	const app = rpc(t, f);
	const planCommand = async (command) => {
		const response = await app.call("plan_command", { command });
		assert.equal(response.success, true, response.error);
		return response.data;
	};
	await planCommand({ type: "enter_planning", requestText: "draft plan" });
	const drafted = await planCommand({ type: "get_snapshot" });
	assert.equal(drafted.phase, "awaiting_approval", JSON.stringify(drafted));
	const { planId, version } = drafted.plan;
	await planCommand({ type: "approve", planId, version });
	assert.equal((await planCommand({ type: "get_snapshot" })).phase, "approved");
	assert.deepEqual((await app.call("list_tasks")).data, []);
	await planCommand({ type: "start_execution", planId, version });
	await app.waitFor((event) => event.type === "task_state" && event.task.status === "completed");
	assert.equal((await app.call("list_tasks")).data[0].presentation, "foreground");
	await app.close();

	const source = SessionManager.create(f.cwd, f.root);
	source.appendMessage({ role: "user", content: "Draft a plan", timestamp: Date.now() });
	const snapshot = structuredClone(drafted);
	snapshot.phase = snapshot.plan.status = "executing";
	const step = snapshot.plan.steps[0];
	step.status = "waiting_input";
	step.waitingReason = "agent_task";
	step.waitingTaskGroupId = "missing-group";
	source.appendCustomEntry("pix-plan-v1", { schemaVersion: 1, sequence: 1, event: "seed", snapshot });
	const sourcePath = source.getSessionFile();
	const bytes = await readFile(sourcePath, "utf8");
	const restored = rpc(t, f, ["--session", sourcePath]);
	const current = (await restored.call("plan_command", { command: { type: "get_snapshot" } })).data;
	assert.equal(current.phase, "paused");
	assert.equal(current.plan.steps[0].status, "failed");
	assert.equal(current.plan.steps[0].waitingTaskGroupId, undefined);
	const retry = await restored.call("plan_command", { command: { type: "retry_step", planId, version, stepId: step.stepId } });
	assert.equal(retry.success, true, retry.error);
	await restored.waitFor((event) => event.type === "task_state" && event.task.status === "completed");
	assert.equal((await restored.call("list_tasks")).data[0].presentation, "foreground");
	assert.equal(await readFile(sourcePath, "utf8"), bytes);
	await restored.close();
});

test("subagent tool approval is routed to the RPC user and cancellation releases the task", async (t) => {
	const f = await fixture(t);
	const app = rpc(t, f);
	await app.call("prompt", { message: "approve child" });
	const question = await app.waitFor((event) => event.type === "extension_ui_request" && event.purpose === "tool_approval");
	const pending = await app.waitFor((event) => event.type === "task_input" && event.request.requestId === question.id);
	const { taskId } = pending.request;
	assert.equal((await app.call("get_task", { taskId })).data.status, "waiting_input");
	assert.equal((await app.call("cancel_task", { taskId })).success, true);
	await app.waitFor((event) => event.type === "task_state" && event.task.taskId === taskId && event.task.status === "cancelled");
	await assert.rejects(readFile(join(f.root, "approval-marker.txt")), { code: "ENOENT" });
	await app.close();
});

test("background task input returns to its original session after a switch", async (t) => {
	const f = await fixture(t);
	const app = rpc(t, f, ["--session-id", "background"]);
	const original = (await app.call("get_state")).data;
	await app.call("prompt", { message: "approve background child" });
	const question = await app.waitFor((event) => event.type === "extension_ui_request" && event.purpose === "tool_approval");
	const pending = await app.waitFor((event) => event.type === "task_input" && event.request.requestId === question.id);
	const { taskId } = pending.request;
	await app.waitFor((event) => event.type === "agent_end");
	assert.equal((await app.call("new_session")).success, true);
	assert.equal((await app.call("get_task", { taskId })).data.status, "waiting_input");
	const after = app.messages.length;
	assert.equal((await app.call("switch_session", { sessionPath: original.sessionFile })).success, true);
	const reopened = await app.waitFor((event) => event.type === "extension_ui_request" && event.id === question.id, after);
	app.write({ type: "extension_ui_response", id: reopened.id, answers: { approval: "拒绝" } });
	await app.waitFor((event) => event.type === "task_input_dismissed" && event.requestId === reopened.id, after);
	await app.waitFor((event) => event.type === "task_state" && event.task.taskId === taskId && event.task.status === "completed", after);
	await assert.rejects(readFile(join(f.root, "approval-marker.txt")), { code: "ENOENT" });
	await app.close();
});

test("pix -p closes an MCP stdio child before exiting", async (t) => {
	const f = await fixture(t);
	const server = fileURLToPath(new URL("./stdio-server.mjs", import.meta.url));
	const marker = join(f.root, "stdio-closed.txt");
	await writeFile(join(f.cwd, ".mcp.json"), JSON.stringify({
		mcpServers: { fixture: { command: process.execPath, args: [server, marker] } },
	}));
	const result = spawnSync(process.execPath, [...f.args, "-p", "mcp"], {
		cwd: f.cwd, env: f.env, encoding: "utf8", timeout: 15000,
	});
	assert.equal(result.status, 0, result.stderr || result.error?.message);
	assert.equal(result.stdout.trim(), "Result from mcp__fixture__ping", result.stderr);
	assert.equal(await readFile(marker, "utf8"), "closed");
});

test("pix JSONL closes a local HTTP/SSE MCP connection after the last result", async (t) => {
	const f = await fixture(t);
	const server = new McpServer({ name: "fixture", version: "1.0.0" });
	server.registerTool("ping", {}, () => ({ content: [{ type: "text", text: "pong" }] }));
	let transport;
	let clientClosed;
	const closed = new Promise((resolve) => { clientClosed = resolve; });
	const http = createServer(async (request, response) => {
		if (request.method === "GET") {
			response.once("close", clientClosed);
			transport = new SSEServerTransport("/messages", response);
			await server.connect(transport);
		} else if (transport) {
			await transport.handlePostMessage(request, response);
		} else {
			response.writeHead(404).end();
		}
	});
	http.listen(0, "127.0.0.1");
	await once(http, "listening");
	t.after(async () => { await server.close(); http.closeAllConnections(); http.close(); });
	await writeFile(join(f.cwd, ".mcp.json"), JSON.stringify({
		mcpServers: { fixture: { url: `http://127.0.0.1:${http.address().port}/sse`, transport: "sse" } },
	}));
	const child = spawn(process.execPath, [...f.args, "--mode", "json", "mcp"], { cwd: f.cwd, env: f.env });
	const timeout = setTimeout(() => child.kill(), 15000);
	t.after(() => clearTimeout(timeout));
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
	child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
	child.stdin.end();
	assert.deepEqual(await once(child, "close"), [0, null], stderr);
	const events = stdout.trim().split("\n").map((line) => JSON.parse(line));
	const result = events.find((event) => event.type === "tool_execution_end" && event.toolName === "mcp__fixture__ping");
	assert.equal(result?.result.content[0].text, "pong", stderr);
	await closed;
});

test("WSL startup adopts explicit mounted project settings and /new carries them across switches", {
	skip: process.platform !== "win32" || !process.env.PIX_WSL_TEST_DISTRO,
}, async (t) => {
	const f = await fixture(t);
	const distro = process.env.PIX_WSL_TEST_DISTRO;
	const pathResult = spawnSync("wsl.exe", ["-d", distro, "--exec", "wslpath", "-a", f.cwd], { encoding: "utf8", timeout: 5000 });
	assert.equal(pathResult.status, 0, pathResult.stderr || pathResult.error?.message);
	const logicalPath = pathResult.stdout.trim();
	const source = SessionManager.create(f.cwd, f.root);
	source.appendMessage({ role: "user", content: "Desktop history", timestamp: Date.now() });
	const wsl = rpc(t, f, ["--wsl-distro", distro, "--wsl-path", logicalPath, "--session", source.getSessionFile()]);
	const state = (await wsl.call("get_state")).data;
	const probe = { command: "printf 'linux-cwd=%s' \"$PWD\"", excludeFromContext: true };
	assert.equal((await wsl.call("bash", probe)).data.output.trim(), `linux-cwd=${logicalPath}`);
	await wsl.close();

	const local = rpc(t, f);
	assert.equal((await local.call("switch_session", { sessionPath: state.sessionFile })).success, true);
	assert.equal((await local.call("new_session")).success, true);
	assert.equal((await local.call("bash", probe)).data.output.trim(), `linux-cwd=${logicalPath}`);
	await local.close();
});

test("piped stdin selects print output without TUI controls", async (t) => {
	const f = await fixture(t);
	const result = spawnSync(process.execPath, f.args, {
		cwd: f.cwd,
		env: f.env,
		encoding: "utf8",
		input: "hello\n",
		timeout: 15000,
	});
	assert.equal(result.status, 0, result.stderr || result.error?.message);
	assert.equal(result.stdout, "PiX test response\n");
	assert.equal(result.stdout.includes("\u001b"), false);
});
