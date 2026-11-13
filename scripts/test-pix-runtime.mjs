import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const runtimeTests = new URL("packages/pix-runtime/test/", root);
const cliTests = new URL("packages/pix-cli/test/", root);
const desktopTests = new URL("pix/src/main/__tests__/", root);
const desktopCases = [
  "acp-session-bridge",
  "agent-task-ipc",
  "agent-task-recovery",
  "agent-task-service",
  "agent-task-transcript",
  "execution-context",
  "model-tool-contracts",
  "plan-ipc",
  "session-bridge-background",
  "session-bridge-flush",
  "session-bridge-subagent",
  "subagent-runner",
  "team-solo-isolation",
  "todo-ipc",
  "workflow-ipc",
  "workflow-session-bridge",
];
if (process.argv.includes("--live")) desktopCases.push("agent-task-e2e", "agent-task-recovery.e2e");

let failures = 0;
function run(args, cwd = root) {
  const result = spawnSync(process.execPath, args, { cwd: fileURLToPath(cwd), stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) failures++;
}

for (const name of readdirSync(runtimeTests).filter((file) => file.endsWith(".test.ts"))) {
  run(["--import", "tsx", fileURLToPath(new URL(name, runtimeTests))]);
}
for (const name of desktopCases) {
  run(["--import", "tsx", fileURLToPath(new URL(`${name}.test.ts`, desktopTests))], new URL("pix/", root));
}
run(["--test", ...readdirSync(cliTests).filter((file) => file.endsWith(".test.mjs"))
  .map((file) => fileURLToPath(new URL(file, cliTests)))]);
run(["--test", "pix/scripts/packaged-deps.test.mjs", "pix/scripts/packaged-workflow.test.mjs"]);
process.exitCode = failures === 0 ? 0 : 1;
