/**
 * createSeatToolPolicy tests (S2b, plan §4.6 / §5.7 / §5.8, H10 / H11 / H29 /
 * H30 / H40 / AC-6).
 *
 * Covers:
 *   - read_only denies built-in bash/run_background/read_output/stop_process,
 *     agent, plan/workflow tools, edit/write and unknown MCP names
 *   - read_only allows read/grep/find/ls, other team tools and an exactly
 *     allowlisted team_bash
 *   - the override never returns undefined and ignores input.mode
 *   - write tier: mutations need this seat's lease (or acquire it in this call);
 *     team_bash needs bashEnabled + non-empty, fully leased paths; unknown MCP
 *     entry points are denied (AC-6)
 *   - restricted: read tools need an explicit in-allowlist path (H30), team_bash
 *     is never allowed and bashEnabled is never even consulted (H11)
 *   - the read-only four stay allowed on another seat's leased path and register
 *     the read (noteRead / H40)
 *   - solo sessions are untouched (the built-in policy still governs them)
 *
 * Run with: npx tsx pix/src/main/__tests__/team-policy.test.ts
 */

import {
  inspectToolExecution,
  type AgentExecutionMode,
  type HostToolPolicyInput,
  type HostToolPolicyOverride,
  type ToolPolicyDecision,
} from "@earendil-works/pi-coding-agent";
import type { ToolAuthTier } from "../../shared/team-types.js";
import { createSeatToolPolicy, type SeatPolicyDenialInfo } from "../team/seat-policy.js";
import { WriteLeaseTable } from "../team/write-lease.js";

// ============================================================================
// Test harness (matches execution-context.test.ts / team-ids.test.ts style)
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
// Fixtures
// ============================================================================

const LOGICAL_CWD = "/ws";

/** Seat tools from plan §4.11; team_bash is the one that goes through the tier rules. */
const TEAM_TOOL_NAMES = [
  "send_team_message",
  "request_peer_explore",
  "claim_write_paths",
  "release_write_paths",
  "team_bash",
  "request_permission",
  "revise_deliverable",
  "stance_on_deliverable",
  "open_item",
  "claim_open_item",
  "resolve_open_item",
  "promote_thread",
  "request_exit",
];

const TIERS: ToolAuthTier[] = ["read_only", "write", "restricted"];

/** Same stand-in for H31's resolvePath as in team-write-lease.test.ts. */
function resolvePathKey(input: string): string {
  let p = input.trim().replace(/\\/g, "/");
  while (p.startsWith("./")) p = p.slice(2);
  if (p.startsWith("@/")) p = p.slice(2);
  if (p.startsWith("~/")) p = `/home/user/${p.slice(2)}`;
  else if (!p.startsWith("/")) p = `${LOGICAL_CWD}/${p}`;
  return p.toLowerCase();
}

interface SeatSpec {
  seatId: string;
  auth: ToolAuthTier;
  pathAllowlist?: string[];
  readonlyCommands?: string[];
  bash?: boolean;
}

interface PolicyHarness {
  policy: HostToolPolicyOverride;
  denials: SeatPolicyDenialInfo[];
  bashEnabledCalls: () => number;
}

function makeHarness(seat: SeatSpec, leases: WriteLeaseTable): PolicyHarness {
  const denials: SeatPolicyDenialInfo[] = [];
  let bashEnabledCalls = 0;
  const policy = createSeatToolPolicy({
    getAuth: () => seat.auth,
    getAllowlist: () => seat.pathAllowlist,
    getReadonlyCommands: () => seat.readonlyCommands ?? [],
    bashEnabled: () => {
      bashEnabledCalls++;
      return seat.bash === true;
    },
    leases,
    logicalCwd: LOGICAL_CWD,
    seatId: seat.seatId,
    teamToolNames: TEAM_TOOL_NAMES,
    onDenied: (info) => denials.push(info),
  });
  return { policy, denials, bashEnabledCalls: () => bashEnabledCalls };
}

/** Calls the override and fails loudly if it ever returns undefined. */
function decide(
  policy: HostToolPolicyOverride,
  toolName: string,
  args: unknown = {},
  mode: AgentExecutionMode = "approval",
  extras: {
    cwd?: string;
    pathContext?: { pathStyle: "posix" | "win32"; homeDir: string; resolvePath: (path: string) => string };
  } = {},
): ToolPolicyDecision {
  const decision = policy({
    mode,
    toolName,
    args,
    cwd: extras.cwd ?? LOGICAL_CWD,
    pathContext: extras.pathContext as HostToolPolicyInput["pathContext"],
  });
  if (decision === undefined) throw new Error(`override returned undefined for "${toolName}"`);
  return decision;
}

function takesLease(leases: WriteLeaseTable, seatId: string, path: string): boolean {
  return leases.acquire(seatId, path).ok;
}

// ============================================================================
// Tests
// ============================================================================

await run("read_only denies shell / agent / plan / workflow / unknown tools", async () => {
  const leases = new WriteLeaseTable(resolvePathKey);
  const h = makeHarness({ seatId: "ro", auth: "read_only" }, leases);

  const deniedNames = [
    // H10: built-in shell and its background trio
    "bash",
    "run_background",
    "read_output",
    "stop_process",
    // H12 / H29: solo AgentTaskScheduler entry points
    "agent",
    "inspect_agent_task",
    "get_goal",
    "create_goal",
    "update_goal",
    // plan / workflow
    "submit_user_plan",
    "update_plan_step",
    "workflow",
    "ralph",
    "ralph-loop",
    "submit_workflow_result",
    // mutations a read-only seat must never reach
    "edit",
    "write",
    // unknown MCP / extension / plain unknown names (AC-6)
    "mcp__fs__write_file",
    "mcp__git__commit",
    "my_extension_tool",
    "rm",
    "__proto__",
  ];

  for (const toolName of deniedNames) {
    const decision = decide(h.policy, toolName, { command: "rm -rf /", path: "src/a.ts" });
    assertEqual(decision.allowed, false, `read_only denies "${toolName}"`);
    assert(
      typeof decision.reason === "string" && decision.reason.length > 0,
      `the denial of "${toolName}" carries a reason for the model`,
    );
    assertEqual(decision.requiresApproval, undefined, `"${toolName}" is blocked outright, never escalated`);
  }

  assertEqual(h.denials.length, deniedNames.length, "every refusal raised the §5.7 system hint");
  assertEqual(h.denials.every((info) => info.writeEntry), true, "all of them are write entry points");
  assertEqual(h.denials.every((info) => info.seatId === "ro"), true, "the hint names the seat");
  assertEqual(leases.list().length, 0, "a denied write never takes a lease");
});

await run("read_only allows read/grep/find/ls, team tools and allowlisted team_bash", async () => {
  const leases = new WriteLeaseTable(resolvePathKey);
  const h = makeHarness(
    { seatId: "ro", auth: "read_only", readonlyCommands: ["git status", "npm run lint"] },
    leases,
  );

  assertEqual(decide(h.policy, "read", { path: "src/a.ts" }).allowed, true, "read is allowed");
  assertEqual(decide(h.policy, "grep", { pattern: "foo", path: "src" }).allowed, true, "grep is allowed");
  assertEqual(decide(h.policy, "find", { pattern: "*.ts" }).allowed, true, "find is allowed");
  assertEqual(decide(h.policy, "ls", {}).allowed, true, "ls is allowed");
  assertEqual(h.denials.length, 0, "no read was reported as a writer violation");

  assertEqual(decide(h.policy, "team_bash", { command: "git status" }).allowed, true, "exact allowlist match is allowed");
  assertEqual(decide(h.policy, "team_bash", { command: "npm run lint" }).allowed, true, "second allowlist entry");
  assertEqual(decide(h.policy, "team_bash", { command: "git status --porcelain" }).allowed, false, "an extended command is not an exact match");
  assertEqual(decide(h.policy, "team_bash", { command: "git status " }).allowed, false, "a trailing space breaks the exact match");
  assertEqual(decide(h.policy, "team_bash", { command: "git status; rm -rf /" }).allowed, false, "a chained command is not an exact match");
  assertEqual(decide(h.policy, "team_bash", { command: "cat src/a.ts" }).allowed, false, "a non-allowlisted command is denied");
  assertEqual(decide(h.policy, "team_bash", {}).allowed, false, "team_bash without a command is denied");
  assertEqual(decide(h.policy, "team_bash", { command: 42 }).allowed, false, "a non-string command is denied");
  assertEqual(
    decide(h.policy, "team_bash", { command: "git status", paths: ["src/a.ts"] }).allowed,
    true,
    "the read-only tier needs no lease for an allowlisted command",
  );
});

await run("team tools pass on every tier; team_bash still follows the tier rules", async () => {
  const leases = new WriteLeaseTable(resolvePathKey);
  for (const auth of TIERS) {
    const h = makeHarness({ seatId: `seat-${auth}`, auth, bash: true }, leases);
    for (const toolName of TEAM_TOOL_NAMES) {
      if (toolName === "team_bash") continue;
      assertEqual(decide(h.policy, toolName, {}).allowed, true, `${auth}: ${toolName} is allowed`);
    }
    assertEqual(
      decide(h.policy, "team_bash", { command: "git status" }).allowed,
      false,
      `${auth}: team_bash goes through the tier rules instead`,
    );
  }
});

await run("H29 belt-and-braces: a denied built-in name inside teamToolNames is still denied", async () => {
  const leases = new WriteLeaseTable(resolvePathKey);
  const denials: SeatPolicyDenialInfo[] = [];
  // Misconfiguration stand-in: the caller's seat tool list wrongly carries built-in
  // names. H29 exists precisely so a missed excludeTools entry cannot open a hole.
  const smuggled = [...TEAM_TOOL_NAMES, "bash", "run_background", "read_output", "stop_process", "agent", "get_goal", "workflow"];
  const denied = ["bash", "run_background", "read_output", "stop_process", "agent", "get_goal", "workflow"];

  for (const auth of TIERS) {
    const policy = createSeatToolPolicy({
      getAuth: () => auth,
      getAllowlist: () => ["src"],
      getReadonlyCommands: () => ["git status"],
      bashEnabled: () => true,
      leases,
      logicalCwd: LOGICAL_CWD,
      seatId: `smuggle-${auth}`,
      teamToolNames: smuggled,
      onDenied: (info) => denials.push(info),
    });
    for (const toolName of denied) {
      const decision = decide(policy, toolName, { command: "echo hi", path: "src/a.ts" });
      assertEqual(decision.allowed, false, `${auth}: "${toolName}" stays denied even though teamToolNames lists it`);
    }
    // The genuine seat tools sharing that list are unaffected by the deny pass.
    assertEqual(decide(policy, "send_team_message", {}).allowed, true, `${auth}: real seat tools still pass`);
    assertEqual(decide(policy, "request_permission", {}).allowed, true, `${auth}: request_permission still passes`);
  }
  assertEqual(denials.length, TIERS.length * denied.length, "each smuggled name raised the §5.7 hint once per tier");
});

await run("write tier: mutations need this seat's lease", async () => {
  const leases = new WriteLeaseTable(resolvePathKey);
  const h = makeHarness({ seatId: "W", auth: "write" }, leases);

  assert(takesLease(leases, "A", "src/held.ts"), "A holds src/held.ts");
  const held = decide(h.policy, "edit", { path: "src/held.ts" });
  assertEqual(held.allowed, false, "edit on a path leased by another seat is denied");
  assert(held.reason?.includes("A") === true, "the reason names the current owner");
  assertEqual(leases.ownerOf("src/held.ts"), "A", "the denied edit did not take the lease over");
  assertEqual(h.denials.length, 1, "the denial raised the §5.7 hint");

  // plan §4.6: "已持约（或本调用内 acquire 成功）" - a free path is leased by this call.
  assertEqual(decide(h.policy, "edit", { path: "src/free.ts" }).allowed, true, "a free path is leased by this very call");
  assertEqual(leases.ownerOf("src/free.ts"), "W", "the allowed edit took the lease");

  // What claim_write_paths does before a batch of edits.
  assert(takesLease(leases, "W", "src/claimed.ts"), "W claims src/claimed.ts");
  assertEqual(decide(h.policy, "edit", { path: "src/claimed.ts" }).allowed, true, "edit on the seat's own lease");
  assertEqual(decide(h.policy, "write", { path: "src/claimed.ts" }).allowed, true, "write on the seat's own lease");
  assertEqual(decide(h.policy, "write", { path: "@/src/CLAIMED.ts" }).allowed, true, "the resolver folds the spelling onto the same lease");

  assertEqual(decide(h.policy, "write", {}).allowed, false, "a mutation without a path is denied");
  assertEqual(decide(h.policy, "write", { path: "   " }).allowed, false, "a blank path is denied");

  assertEqual(decide(h.policy, "read", { path: "src/held.ts" }).allowed, true, "a write seat may still read another seat's file");
  assertEqual(h.denials.length, 3, "hints: the held path, the pathless write, the blank path");
});

await run("write tier H40: a read before the holder released blocks the later write", async () => {
  const leases = new WriteLeaseTable(resolvePathKey);
  const h = makeHarness({ seatId: "W", auth: "write" }, leases);

  assert(takesLease(leases, "A", "src/rw.ts"), "A holds src/rw.ts");
  assertEqual(decide(h.policy, "read", { path: "src/rw.ts" }).allowed, true, "W reads A's leased path (noteRead)");
  leases.release("A", "src/rw.ts");

  const blocked = decide(h.policy, "edit", { path: "src/rw.ts" });
  assertEqual(blocked.allowed, false, "the edit is refused: the copy read before A released may be stale");
  assert(blocked.reason?.includes("Read it again") === true, "the reason tells the seat to re-read");
  assertEqual(leases.ownerOf("src/rw.ts"), undefined, "the refused edit took no lease");

  assertEqual(decide(h.policy, "read", { path: "src/rw.ts" }).allowed, true, "the re-read is allowed");
  assertEqual(decide(h.policy, "edit", { path: "src/rw.ts" }).allowed, true, "after the re-read the edit is allowed");
  assertEqual(leases.ownerOf("src/rw.ts"), "W", "the edit took the lease");
});

await run("write tier team_bash: bashEnabled + non-empty fully leased paths", async () => {
  const leases = new WriteLeaseTable(resolvePathKey);
  assert(takesLease(leases, "W", "src/w.ts"), "W holds src/w.ts");

  const off = makeHarness({ seatId: "W", auth: "write", bash: false }, leases);
  assertEqual(
    decide(off.policy, "team_bash", { command: "npm test", paths: ["src/w.ts"] }).allowed,
    false,
    "bashEnabled=false denies even with leased paths",
  );

  const on = makeHarness({ seatId: "W", auth: "write", bash: true }, leases);
  assertEqual(decide(on.policy, "team_bash", { command: "npm test" }).allowed, false, "paths are required");
  assertEqual(decide(on.policy, "team_bash", { command: "npm test", paths: [] }).allowed, false, "an empty paths list is denied");
  assertEqual(decide(on.policy, "team_bash", { command: "npm test", paths: "src/w.ts" }).allowed, false, "a non-array paths value is denied");
  assertEqual(decide(on.policy, "team_bash", { command: "npm test", paths: [42] }).allowed, false, "a non-string path entry is denied");
  assertEqual(decide(on.policy, "team_bash", { command: "npm test", paths: ["src/other.ts"] }).allowed, false, "an unleased path is denied");
  assertEqual(
    decide(on.policy, "team_bash", { command: "npm test", paths: ["src/w.ts", "src/other.ts"] }).allowed,
    false,
    "one unleased path denies the whole call",
  );
  assertEqual(decide(on.policy, "team_bash", { command: "npm test", paths: ["src/w.ts"] }).allowed, true, "all paths leased -> allowed");
  assertEqual(decide(on.policy, "team_bash", { command: "npm test", paths: ["@/src/W.TS"] }).allowed, true, "the resolver folds the spelling onto the lease");
  // plan §4.6: "禁止解析 command 文本" - the paths lease is the only gate.
  assertEqual(
    decide(on.policy, "team_bash", { command: "rm -rf src/w.ts && npm test", paths: ["src/w.ts"] }).allowed,
    true,
    "command text is never parsed, only the leased paths are checked",
  );
});

await run("write tier denies unknown MCP / extension write entry points (AC-6)", async () => {
  const leases = new WriteLeaseTable(resolvePathKey);
  const h = makeHarness({ seatId: "W", auth: "write" }, leases);
  assert(takesLease(leases, "W", "src/w.ts"), "W holds src/w.ts");

  for (const toolName of ["mcp__fs__write_file", "mcp__git__commit", "mcp__shell__run", "my_extension_tool", "rm", "delete_file"]) {
    const decision = decide(h.policy, toolName, { path: "src/w.ts" });
    assertEqual(decision.allowed, false, `write tier denies unknown tool "${toolName}" even with a leased path`);
  }
  assertEqual(h.denials.length, 6, "each unknown entry point raised the §5.7 hint");
});

await run("restricted tier: explicit in-allowlist read paths only, never team_bash", async () => {
  const leases = new WriteLeaseTable(resolvePathKey);
  const h = makeHarness(
    { seatId: "R", auth: "restricted", pathAllowlist: ["src", "/ws/docs/spec.md"], bash: true },
    leases,
  );

  assertEqual(decide(h.policy, "read", {}).allowed, false, "read without a path is denied (H30)");
  assertEqual(decide(h.policy, "grep", { pattern: "x" }).allowed, false, "grep without a path is denied");
  assertEqual(decide(h.policy, "find", { pattern: "*.ts" }).allowed, false, "find without a path is denied");
  assertEqual(decide(h.policy, "ls", {}).allowed, false, "ls without a path is denied");
  assertEqual(decide(h.policy, "read", { path: "" }).allowed, false, "a blank path counts as missing");
  assertEqual(h.denials.length, 0, "a read refusal is not reported as a write violation");

  assertEqual(decide(h.policy, "read", { path: "src/a.ts" }).allowed, true, "a path inside the allowlist prefix is allowed");
  assertEqual(decide(h.policy, "ls", { path: "src" }).allowed, true, "the allowlist entry itself is allowed");
  assertEqual(decide(h.policy, "grep", { pattern: "x", path: "src/nested/deep" }).allowed, true, "nested paths are inside the prefix");
  assertEqual(decide(h.policy, "read", { path: "@/src/a.ts" }).allowed, true, "the resolver normalises before the prefix check");
  assertEqual(decide(h.policy, "read", { path: "/ws/docs/spec.md" }).allowed, true, "an absolute allowlist entry matches exactly");
  assertEqual(decide(h.policy, "read", { path: "docs/notes.md" }).allowed, false, "a sibling path is outside the allowlist");
  assertEqual(decide(h.policy, "read", { path: "src-evil/a.ts" }).allowed, false, "prefix confusion is not accepted");
  assertEqual(decide(h.policy, "read", { path: "~/src/a.ts" }).allowed, false, "a home path is outside the allowlist");
  assertEqual(decide(h.policy, "read", { path: "/etc/passwd" }).allowed, false, "an absolute outside path is denied");

  assertEqual(decide(h.policy, "edit", { path: "src/a.ts" }).allowed, false, "restricted never edits");
  assertEqual(decide(h.policy, "write", { path: "src/a.ts" }).allowed, false, "restricted never writes");
  assertEqual(decide(h.policy, "bash", { command: "ls" }).allowed, false, "restricted never gets built-in bash");

  const blank = makeHarness({ seatId: "R3", auth: "restricted", pathAllowlist: ["", "   "] }, leases);
  assertEqual(decide(blank.policy, "read", { path: "docs/x.md" }).allowed, false, "a blank allowlist entry does not widen the allowlist");
  assertEqual(decide(blank.policy, "read", { path: "src/a.ts" }).allowed, false, "an empty allowlist denies everything");

  const teamBash = decide(h.policy, "team_bash", { command: "git status", paths: ["src/a.ts"] });
  assertEqual(teamBash.allowed, false, "restricted never gets team_bash (H11)");
  assert(teamBash.reason?.includes("never allowed") === true, "the reason states the tier rule");
  assertEqual(h.bashEnabledCalls(), 0, "restricted ignores bashEnabled entirely");
});

await run("an unrecognised tier fails closed instead of falling into the write branch", async () => {
  const leases = new WriteLeaseTable(resolvePathKey);
  // A corrupt persisted auth (e.g. a hand-edited meta.json) must not become the
  // widest tier. The seat even holds its own lease here, so only the tier rules
  // can keep team_bash away.
  const bogus = makeHarness(
    { seatId: "X", auth: "readonly" as ToolAuthTier, bash: true, pathAllowlist: ["src"] },
    leases,
  );
  assert(takesLease(leases, "X", "src/x.ts"), "X holds src/x.ts");
  assertEqual(
    decide(bogus.policy, "team_bash", { command: "npm test", paths: ["src/x.ts"] }).allowed,
    false,
    "an unknown tier never reaches the write tier's team_bash branch, even with a self-held lease",
  );
  assertEqual(decide(bogus.policy, "read", { path: "src/x.ts" }).allowed, false, "reads are denied for an unknown tier");
  assertEqual(decide(bogus.policy, "edit", { path: "src/x.ts" }).allowed, false, "mutations are denied for an unknown tier");
  assertEqual(decide(bogus.policy, "bash", {}).allowed, false, "built-in bash stays denied for an unknown tier");
  assertEqual(decide(bogus.policy, "mcp__x__y", {}).allowed, false, "unknown tools stay denied for an unknown tier");
  assertEqual(decide(bogus.policy, "send_team_message", {}).allowed, true, "the seat can still talk");

  // Control: the same leases under the real write tier do allow team_bash.
  const real = makeHarness({ seatId: "X", auth: "write", bash: true }, leases);
  assertEqual(
    decide(real.policy, "team_bash", { command: "npm test", paths: ["src/x.ts"] }).allowed,
    true,
    "control: the write tier allows the same call with the same lease",
  );
});

await run("the read-only four stay allowed on another seat's lease and register the read", async () => {
  const leases = new WriteLeaseTable(resolvePathKey);
  const h = makeHarness({ seatId: "R2", auth: "read_only" }, leases);
  assert(takesLease(leases, "A", "src/shared.ts"), "A holds src/shared.ts");

  assertEqual(decide(h.policy, "read", { path: "src/shared.ts" }).allowed, true, "read is allowed on another seat's leased path");
  assertEqual(decide(h.policy, "grep", { pattern: "x", path: "src/shared.ts" }).allowed, true, "grep is allowed too");
  assertEqual(decide(h.policy, "find", { pattern: "*.ts", path: "src/shared.ts" }).allowed, true, "find is allowed too");
  assertEqual(decide(h.policy, "ls", { path: "src/shared.ts" }).allowed, true, "ls is allowed too");
  assertEqual(leases.ownerOf("src/shared.ts"), "A", "reads never take the lease");

  const refused = leases.acquire("R2", "src/shared.ts");
  assert(refused.ok === false && "staleRead" in refused, "noteRead armed the staleRead refusal for R2 (H40)");
});

await run("the override never returns undefined and ignores input.mode", async () => {
  const modes: AgentExecutionMode[] = ["approval", "unattended", "read-only"];
  const probeNames = [
    "",
    "__proto__",
    "constructor",
    "hasOwnProperty",
    "bash",
    "team_bash",
    "TEAM_BASH",
    "read",
    "grep",
    "find",
    "ls",
    "edit",
    "write",
    "agent",
    "workflow",
    "mcp__x__y",
  ];
  const probeArgs: unknown[] = [
    undefined,
    {},
    { command: "php -v" },
    { path: "src/a.ts", paths: ["src/a.ts"] },
    { paths: 42 },
    { paths: ["src/a.ts", null] },
  ];

  let probes = 0;
  let undefinedCount = 0;
  let badShape = 0;
  for (const auth of TIERS) {
    const h = makeHarness(
      { seatId: `probe-${auth}`, auth, bash: true, readonlyCommands: ["git status"] },
      new WriteLeaseTable(resolvePathKey),
    );
    for (const toolName of probeNames) {
      for (const mode of modes) {
        for (const args of probeArgs) {
          probes++;
          const decision = h.policy({ mode, toolName, args, cwd: LOGICAL_CWD });
          if (decision === undefined) undefinedCount++;
          else if (typeof decision.allowed !== "boolean") badShape++;
        }
      }
    }
  }
  assertEqual(undefinedCount, 0, `all ${probes} probed calls (tier x tool x mode x args) returned a decision`);
  assertEqual(badShape, 0, "every decision carries a boolean allowed flag");

  const modeLeases = new WriteLeaseTable(resolvePathKey);
  const h = makeHarness({ seatId: "mode", auth: "read_only" }, modeLeases);
  const perMode = modes.map((mode) => h.policy({ mode, toolName: "bash", args: { command: "echo hi" }, cwd: LOGICAL_CWD }));
  assertEqual(
    new Set(perMode.map((decision) => JSON.stringify(decision))).size,
    1,
    "a read_only seat's bash decision is identical in every execution mode",
  );
  assert(
    perMode.every((decision) => decision !== undefined && decision.allowed === false),
    "bash stays denied even in unattended mode (no fallback to inspectToolExecution)",
  );
});

await run("solo sessions are untouched by the seat override", async () => {
  const soloEdit = inspectToolExecution({
    mode: "approval",
    toolName: "edit",
    args: { path: "src/a.ts" },
    cwd: LOGICAL_CWD,
  });
  assertEqual(soloEdit.allowed, true, "solo baseline: the built-in policy still allows an in-cwd edit");

  const soloBash = inspectToolExecution({
    mode: "unattended",
    toolName: "bash",
    args: { command: "echo hi" },
    cwd: LOGICAL_CWD,
  });
  assertEqual(soloBash.allowed, true, "solo baseline: built-in bash is untouched");

  const h = makeHarness({ seatId: "ro", auth: "read_only" }, new WriteLeaseTable(resolvePathKey));
  assertEqual(decide(h.policy, "bash", { command: "echo hi" }).allowed, false, "the same call is denied inside a team seat");
  assertEqual(
    decide(h.policy, "edit", { path: "src/a.ts" }).allowed,
    false,
    "the same edit is denied inside a read_only seat",
  );
});

await run("write tier: mutations outside cwd / Windows device / WSL Windows-style paths are denied", async () => {
  const leases = new WriteLeaseTable(resolvePathKey);
  const h = makeHarness({ seatId: "W", auth: "write" }, leases);

  assertEqual(decide(h.policy, "edit", { path: "src/free.ts" }).allowed, true, "relative in-cwd path is allowed");
  assertEqual(decide(h.policy, "edit", { path: "../outside.ts" }).allowed, false, "parent of cwd is denied");
  assertEqual(decide(h.policy, "write", { path: "/etc/passwd" }).allowed, false, "absolute outside path is denied");
  assertEqual(decide(h.policy, "edit", { path: "aux.log" }).allowed, false, "Windows reserved device name is denied");
  assertEqual(
    decide(h.policy, "write", { path: "C:\\\\Windows\\\\system32\\\\hosts" }, "approval", {
      pathContext: { pathStyle: "posix", homeDir: "/home/u", resolvePath: (path) => path },
    }).allowed,
    false,
    "Windows drive letter is denied in WSL/posix context",
  );
  assertEqual(
    decide(h.policy, "write", { path: "\\\\server\\\\share\\\\file.ts" }, "approval", {
      pathContext: { pathStyle: "posix", homeDir: "/home/u", resolvePath: (path) => path },
    }).allowed,
    false,
    "UNC path is denied in WSL/posix context",
  );
});

// ============================================================================

console.log("\n=== Summary ===\n");
console.log(`Passed: ${passed}, Failed: ${failed}`);
if (failed > 0) {
  process.exit(1);
}
