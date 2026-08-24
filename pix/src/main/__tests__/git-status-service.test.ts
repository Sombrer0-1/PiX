/**
 * Git status service tests (PiX 1.5.0, SDD §8 S2B).
 *
 * Two layers:
 *  ① Fake createRunner tests for the service layer: error classification
 *    (not-repository / git_not_found / timeout / execution_failed /
 *    invalid_location), porcelain v2 (-z) and numstat parsing against literal
 *    byte-string fixtures (fixtures model real git 2.54 output; no real git
 *    required), scopedToProject, truncated -> complete:false degradation,
 *    sorting, empty repo.
 *  ② Real-git integration tests against temp repositories (clean / staged /
 *    unstaged / untracked / rename / conflict / detached / empty repo /
 *    non-repo / nested scope). The group is skipped when git is not installed
 *    (probed with spawnSync "git --version").
 *
 * Run with: npx tsx src/main/__tests__/git-status-service.test.ts (repo root)
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createGitStatusService } from "../git/git-status-service.js";
import type { GitCommandOutput, GitCommandRunner } from "../git/git-command.js";
import type { GitChangedFile, GitWorkdirSnapshot, ProjectLocation } from "../../shared/types.js";

// ============================================================================
// Test harness (matches plan-ipc.test.ts style: passed/failed counters,
// process.exit(1) when anything failed)
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

function assertDeepEqual<T>(actual: T, expected: T, message: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
    console.log(`  PASS: ${message}`);
  } else {
    failed++;
    console.error(`  FAIL: ${message} - expected ${e}, got ${a}`);
  }
}

async function run(name: string, fn: () => Promise<void> | void): Promise<void> {
  console.log(`\n=== ${name} ===\n`);
  try {
    await fn();
  } catch (err) {
    failed++;
    console.error(`  FAIL: ${name} threw unexpectedly: ${String(err)}`);
  }
}

// ============================================================================
// Fixtures: literal porcelain v2 (-z) / numstat byte strings (git 2.54 format)
// ============================================================================

const OID = "332bce75ed3040b276972dc6725ac4b61bc6fa2";
const OID2 = "78981922613b2afb6025042ff6bd878ac1994e85";

/** -z 输出：每条记录以 NUL 终止（含结尾 NUL）。 */
const nulJoin = (records: string[]): string => records.join("\x00") + "\x00";

const BASIC_STATUS = nulJoin([
  `# branch.oid ${OID}`,
  "# branch.head main",
  "# branch.upstream origin/main",
  "# branch.ab +2 -3",
  `1 .M N... 100644 100644 100644 ${OID2} ${OID2} a.txt`,
  `1 M. N... 100644 100644 100644 ${OID2} ${OID2} b.txt`,
  "? new.txt",
]);

const UPSTREAM_NO_AB = nulJoin([
  `# branch.oid ${OID}`,
  "# branch.head main",
  "# branch.upstream origin/main",
]);

const RENAME_STATUS = nulJoin([
  `# branch.oid ${OID}`,
  "# branch.head main",
  `2 RM N... 100644 100644 100644 ${OID2} ${OID2} R100 moved.txt`,
  "a.txt", // -z：origPath 是重命名记录后的裸 NUL 字段
  "? new.txt",
]);

const CONFLICT_STATUS = nulJoin([
  `# branch.oid ${OID}`,
  "# branch.head main",
  `u UU N... 100644 100644 100644 100644 ${OID2} ${OID2} ${OID2} f.txt`,
]);

const DETACHED_STATUS = nulJoin([`# branch.oid ${OID}`, "# branch.head (detached)"]);

const EMPTY_STATUS = nulJoin(["# branch.oid (initial)", "# branch.head main"]);
const EMPTY_LEGACY_STATUS = nulJoin(["# branch.oid (initial)", "# branch.head (unknown)"]);

/** unborn HEAD 但已有暂存记录：已暂存数据不得被 emptyRepo 判定抹除（#C1）。 */
const UNBORN_STAGED_STATUS = nulJoin([
  "# branch.oid (initial)",
  "# branch.head main",
  `1 A. N... 100644 100644 100644 ${OID2} ${OID2} f.txt`,
]);

/** 文件名含换行字节（POSIX/WSL 合法）：-z 无 quoting，路径按原样接收（#15）。 */
const NEWLINE_PATH_STATUS = nulJoin([
  `# branch.oid ${OID}`,
  "# branch.head main",
  `1 .M N... 100644 100644 100644 ${OID2} ${OID2} a\nb.txt`,
]);

/** 重命名记录的 origPath 含换行字节（#15）：裸 NUL 字段整体作为 origPath。 */
const RENAME_NEWLINE_ORIGPATH_STATUS = nulJoin([
  `# branch.oid ${OID}`,
  "# branch.head main",
  `2 R. N... 100644 100644 100644 ${OID2} ${OID2} R100 new.txt`,
  "old\nname.txt",
]);

/** 旧 git：头行 LF 终止（记录仍 NUL 终止），首个记录与 LF 头行同 chunk。 */
const LEGACY_LF_HEADERS = `# branch.oid ${OID}\n# branch.head main\n` +
  `1 .M N... 100644 100644 100644 ${OID2} ${OID2} a.txt\x00`;

/** 截断的输出：缺终止 NUL 的尾部残缺记录 "? unt" 应被丢弃。 */
const TRUNCATED_STATUS = `# branch.oid ${OID}\x00# branch.head main\x00` +
  `1 .M N... 100644 100644 100644 ${OID2} ${OID2} b.txt\x00? new.txt\x00? unt`;

const SORT_STATUS = nulJoin([
  `# branch.oid ${OID}`,
  "# branch.head main",
  `1 .M N... 100644 100644 100644 ${OID2} ${OID2} z.txt`,
  `1 D. N... 100644 100644 100644 ${OID2} ${OID2} d.txt`,
  `1 M. N... 100644 100644 100644 ${OID2} ${OID2} m.txt`,
  `u UU N... 100644 100644 100644 100644 ${OID2} ${OID2} ${OID2} c.txt`,
  "? u2.txt",
  "? u1.txt",
]);

const stdoutResult = (stdout: string, overrides: Partial<GitCommandOutput> = {}): GitCommandOutput => ({
  exitCode: 0,
  stdout,
  stderr: "",
  truncated: false,
  timedOut: false,
  notFound: false,
  ...overrides,
});

// ============================================================================
// Scripted runner: serves queued outputs per run() call (fails loudly on an
// unexpected call so tests implicitly assert the command sequence)
// ============================================================================

class ScriptedRunner implements GitCommandRunner {
  readonly calls: string[][] = [];

  constructor(private readonly script: Array<GitCommandOutput | ((args: string[]) => GitCommandOutput)>) {}

  run(args: string[]): Promise<GitCommandOutput> {
    this.calls.push([...args]);
    const entry = this.script[this.calls.length - 1];
    if (entry === undefined) {
      return Promise.reject(new Error(`Unexpected run #${this.calls.length}: git ${args.join(" ")}`));
    }
    return Promise.resolve(typeof entry === "function" ? entry(args) : entry);
  }
}

function makeService(runner: GitCommandRunner): GitStatusService {
  return createGitStatusService({ createRunner: () => runner });
}

function winLocation(physicalPath: string, path = physicalPath): ProjectLocation {
  return { path, physicalPath, name: "proj", environment: { kind: "windows" } };
}

function wslLocation(logicalPath: string, physicalPath: string, distro = "Ubuntu"): ProjectLocation {
  return { path: logicalPath, physicalPath, name: "proj", environment: { kind: "wsl", distro } };
}

function fileByPath(snapshot: GitWorkdirSnapshot, path: string): GitChangedFile | undefined {
  return snapshot.files.find((f) => f.path === path);
}

const ZERO_COUNTS = { staged: 0, unstaged: 0, untracked: 0, conflicts: 0, additions: 0, deletions: 0 };

/** fake-runner 测试用真实存在的目录：Windows 侧在创建 runner 前对
 * physicalPath 做存在性预检（#14），fake 用例的 physicalPath 必须真实存在。 */
const EXISTING_DIR = mkdtempSync(join(tmpdir(), "pix-git-status-cwd-"));
mkdirSync(join(EXISTING_DIR, "sub"), { recursive: true });
/** EXISTING_DIR 的正斜杠形式：fake runner 的 rev-parse toplevel 输出（匹配）。 */
const EXISTING_DIR_SLASH = EXISTING_DIR.replace(/\\/g, "/");

// ============================================================================
// ① Service-layer tests with a fake runner
// ============================================================================

await run("invalid location -> unavailable/invalid_location, runner never called", async () => {
  const runner = new ScriptedRunner([]);
  const service = makeService(runner);
  const s = await service.getStatus({ path: 42, physicalPath: "x", name: "n", environment: { kind: "windows" } } as unknown as ProjectLocation);
  assertEqual(s.kind, "unavailable", "kind");
  assertEqual(s.errorCode, "invalid_location", "errorCode");
  assertDeepEqual(s.files, [], "files empty");
  assertEqual(s.complete, false, "complete false");
  assertEqual(runner.calls.length, 0, "runner never called");

  const wslNoDistro = await service.getStatus({
    path: "/p",
    physicalPath: "C:\\p",
    name: "n",
    environment: { kind: "wsl" },
  } as unknown as ProjectLocation);
  assertEqual(wslNoDistro.errorCode, "invalid_location", "wsl without distro invalid");
});

await run("rev-parse classification: notFound / timedOut / not-repository / git_not_found / execution_failed", async () => {
  const notFound = new ScriptedRunner([
    { exitCode: null, stdout: "", stderr: "", truncated: false, timedOut: false, notFound: true },
  ]);
  let s = await makeService(notFound).getStatus(winLocation(EXISTING_DIR));
  assertEqual(s.kind, "unavailable", "notFound kind");
  assertEqual(s.errorCode, "git_not_found", "notFound errorCode");
  assertEqual(notFound.calls.length, 1, "notFound: only rev-parse ran");

  const timedOut = new ScriptedRunner([
    { exitCode: null, stdout: "", stderr: "", truncated: false, timedOut: true, notFound: false },
  ]);
  s = await makeService(timedOut).getStatus(winLocation(EXISTING_DIR));
  assertEqual(s.errorCode, "timeout", "timedOut errorCode");

  const notRepo = new ScriptedRunner([
    { exitCode: 128, stdout: "", stderr: "fatal: not a git repository (or any of the parent directories): .git", truncated: false, timedOut: false, notFound: false },
  ]);
  s = await makeService(notRepo).getStatus(winLocation(EXISTING_DIR));
  assertEqual(s.kind, "not-repository", "not-repository kind");
  assertEqual(s.complete, true, "not-repository complete");
  assertDeepEqual(s.files, [], "not-repository files empty");
  assertEqual(notRepo.calls.length, 1, "not-repository: only rev-parse ran");

  const exit127 = new ScriptedRunner([
    { exitCode: 127, stdout: "", stderr: "", truncated: false, timedOut: false, notFound: false },
  ]);
  s = await makeService(exit127).getStatus(winLocation(EXISTING_DIR));
  assertEqual(s.errorCode, "git_not_found", "exitCode 127 -> git_not_found");

  const commandNotFound = new ScriptedRunner([
    { exitCode: 1, stdout: "", stderr: "bash: git: command not found", truncated: false, timedOut: false, notFound: false },
  ]);
  s = await makeService(commandNotFound).getStatus(winLocation(EXISTING_DIR));
  assertEqual(s.errorCode, "git_not_found", "stderr command not found -> git_not_found");

  const corrupt = new ScriptedRunner([
    { exitCode: 128, stdout: "", stderr: "fatal: index file corrupt", truncated: false, timedOut: false, notFound: false },
  ]);
  s = await makeService(corrupt).getStatus(winLocation(EXISTING_DIR));
  assertEqual(s.errorCode, "execution_failed", "other failure -> execution_failed");
});

await run("status/diff command failures map to unavailable codes", async () => {
  const statusTimedOut = new ScriptedRunner([
    stdoutResult(EXISTING_DIR_SLASH + "\n"),
    { exitCode: null, stdout: "", stderr: "", truncated: false, timedOut: true, notFound: false },
  ]);
  let s = await makeService(statusTimedOut).getStatus(winLocation(EXISTING_DIR));
  assertEqual(s.kind, "unavailable", "status timedOut kind");
  assertEqual(s.errorCode, "timeout", "status timedOut errorCode");

  const statusNotFound = new ScriptedRunner([
    stdoutResult(EXISTING_DIR_SLASH + "\n"),
    { exitCode: null, stdout: "", stderr: "", truncated: false, timedOut: false, notFound: true },
  ]);
  s = await makeService(statusNotFound).getStatus(winLocation(EXISTING_DIR));
  assertEqual(s.errorCode, "git_not_found", "status notFound errorCode");

  const statusFailed = new ScriptedRunner([
    stdoutResult(EXISTING_DIR_SLASH + "\n"),
    { exitCode: 128, stdout: "", stderr: "fatal: bad index", truncated: false, timedOut: false, notFound: false },
  ]);
  s = await makeService(statusFailed).getStatus(winLocation(EXISTING_DIR));
  assertEqual(s.errorCode, "execution_failed", "status exit!=0 errorCode");

  const diffTimedOut = new ScriptedRunner([
    stdoutResult(EXISTING_DIR_SLASH + "\n"),
    stdoutResult(BASIC_STATUS),
    { exitCode: null, stdout: "", stderr: "", truncated: false, timedOut: true, notFound: false },
  ]);
  s = await makeService(diffTimedOut).getStatus(winLocation(EXISTING_DIR));
  assertEqual(s.errorCode, "timeout", "cached diff timedOut errorCode");
});

await run("runner receives the right env/cwd/options (windows + wsl)", async () => {
  let captured: { env: unknown; cwd: unknown; options: unknown } | undefined;
  const runner = new ScriptedRunner([stdoutResult(EXISTING_DIR_SLASH + "\n"), stdoutResult(""), stdoutResult(""), stdoutResult("")]);
  const service = createGitStatusService({
    timeoutMs: 3000,
    maxOutputBytes: 4096,
    createRunner: (env, cwd, options) => {
      captured = { env, cwd, options };
      return runner;
    },
  });
  await service.getStatus(wslLocation("/home/u/proj", "\\\\wsl.localhost\\Ubuntu\\home\\u\\proj", "Ubuntu-22.04"));
  assertDeepEqual(captured?.env, { kind: "wsl", distro: "Ubuntu-22.04" }, "wsl env");
  assertDeepEqual(captured?.cwd, { logical: "/home/u/proj", physical: "\\\\wsl.localhost\\Ubuntu\\home\\u\\proj" }, "wsl cwd");
  assertDeepEqual(captured?.options, { timeoutMs: 3000, maxStdoutBytes: 4096 }, "options map maxOutputBytes -> maxStdoutBytes");
  assertDeepEqual(runner.calls[0], ["rev-parse", "--show-toplevel"], "first call rev-parse");
  assertDeepEqual(
    runner.calls[1],
    ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all", "--", "."],
    "second call porcelain status (no global prefix)",
  );
  assertDeepEqual(
    runner.calls[2],
    ["diff", "--cached", "--numstat", "-z", "--no-renames", "--no-ext-diff", "--", "."],
    "third call cached numstat",
  );
  assertDeepEqual(
    runner.calls[3],
    ["diff", "--numstat", "-z", "--no-renames", "--no-ext-diff", "--", "."],
    "fourth call worktree numstat",
  );

  captured = undefined;
  const runner2 = new ScriptedRunner([stdoutResult(EXISTING_DIR_SLASH + "\n"), stdoutResult(""), stdoutResult(""), stdoutResult("")]);
  const service2 = createGitStatusService({ createRunner: (env, cwd, options) => {
    captured = { env, cwd, options };
    return runner2;
  } });
  await service2.getStatus(winLocation(EXISTING_DIR));
  assertDeepEqual(captured?.env, { kind: "windows" }, "windows env");
  assertDeepEqual(captured?.cwd, { logical: EXISTING_DIR, physical: EXISTING_DIR }, "windows cwd");
});

await run("parse: branch/upstream/ab + changed/untracked + numstat + counts", async () => {
  const runner = new ScriptedRunner([
    stdoutResult(EXISTING_DIR_SLASH + "\n"),
    stdoutResult(BASIC_STATUS),
    stdoutResult("1\t0\tb.txt\x00"),
    stdoutResult("3\t1\ta.txt\x00"),
  ]);
  const s = await makeService(runner).getStatus(winLocation(EXISTING_DIR));
  assertEqual(s.kind, "repository", "kind");
  assertEqual(s.repositoryName, EXISTING_DIR_SLASH.split("/").pop(), "repositoryName");
  assertEqual(s.scopedToProject, false, "not scoped");
  assertEqual(s.branch, "main", "branch");
  assertDeepEqual(s.upstream, { ref: "origin/main", ahead: 2, behind: 3 }, "upstream ahead/behind");
  assertEqual(s.complete, true, "complete");
  assert(typeof s.observedAt === "number" && Date.now() - s.observedAt < 30000, "observedAt recent");

  const a = fileByPath(s, "a.txt");
  assert(a !== undefined, "a.txt in files");
  assertEqual(a!.unstaged, true, "a unstaged");
  assertEqual(a!.staged, false, "a not staged");
  assertEqual(a!.additions, 3, "a additions from worktree numstat");
  assertEqual(a!.deletions, 1, "a deletions");

  const b = fileByPath(s, "b.txt");
  assert(b !== undefined, "b.txt in files");
  assertEqual(b!.staged, true, "b staged");
  assertEqual(b!.unstaged, false, "b not unstaged");
  assertEqual(b!.additions, 1, "b additions from cached numstat");

  const n = fileByPath(s, "new.txt");
  assert(n !== undefined, "new.txt in files");
  assertEqual(n!.untracked, true, "new untracked");
  assertEqual(n!.additions, null, "untracked additions null");

  assertDeepEqual(s.counts, { staged: 1, unstaged: 1, untracked: 1, conflicts: 0, additions: 4, deletions: 1 }, "counts");
});

await run("parse: upstream without branch.ab defaults ahead/behind to 0", async () => {
  const runner = new ScriptedRunner([
    stdoutResult(EXISTING_DIR_SLASH + "\n"),
    stdoutResult(UPSTREAM_NO_AB),
    stdoutResult(""),
    stdoutResult(""),
  ]);
  const s = await makeService(runner).getStatus(winLocation(EXISTING_DIR));
  assertDeepEqual(s.upstream, { ref: "origin/main", ahead: 0, behind: 0 }, "upstream defaults");
});

await run("parse: rename record (type 2) with NUL-separated origPath", async () => {
  const runner = new ScriptedRunner([
    stdoutResult(EXISTING_DIR_SLASH + "\n"),
    stdoutResult(RENAME_STATUS),
    stdoutResult("0\t1\ta.txt\x00" + "2\t0\tmoved.txt\x00"),
    stdoutResult(""),
  ]);
  const s = await makeService(runner).getStatus(winLocation(EXISTING_DIR));
  const moved = fileByPath(s, "moved.txt");
  assert(moved !== undefined, "moved.txt in files");
  assertEqual(moved!.renamed, true, "renamed");
  assertEqual(moved!.origPath, "a.txt", "origPath from trailing NUL field");
  assertEqual(moved!.staged, true, "staged (X=R)");
  assertEqual(moved!.unstaged, true, "unstaged (Y=M)");
  assertEqual(moved!.deleted, false, "not deleted");
  assertEqual(moved!.additions, 2, "additions from cached numstat new-path record");
  assertEqual(moved!.deletions, 1, "deletions from old-path record merged via origPath");
  assert(fileByPath(s, "a.txt") === undefined, "old rename path not listed");
  assertEqual(s.counts!.staged, 1, "staged count");
  assertEqual(s.counts!.additions, 2, "additions count");
  assertEqual(s.counts!.deletions, 1, "deletions count");
});

await run("parse: conflict (u record) stays null in numstat", async () => {
  // 实测 git 2.54：未合并路径仍出现在 numstat 中（0/0 与冲突内容计数）。
  // 服务层按 SDD 过滤冲突文件，行数保持 null。
  const runner = new ScriptedRunner([
    stdoutResult(EXISTING_DIR_SLASH + "\n"),
    stdoutResult(CONFLICT_STATUS),
    stdoutResult("0\t0\tf.txt\x00"),
    stdoutResult("0\t0\tf.txt\x004\t0\tf.txt\x00"),
  ]);
  const s = await makeService(runner).getStatus(winLocation(EXISTING_DIR));
  const f = fileByPath(s, "f.txt");
  assert(f !== undefined, "f.txt in files");
  assertEqual(f!.conflict, true, "conflict flag");
  assertEqual(f!.staged, false, "not staged");
  assertEqual(f!.unstaged, false, "not unstaged");
  assertEqual(f!.additions, null, "additions null (conflict excluded from numstat)");
  assertEqual(f!.deletions, null, "deletions null");
  assertEqual(s.counts!.conflicts, 1, "conflicts count");
});

await run("parse: detached HEAD -> detachedHeadOid (7 chars), no branch", async () => {
  const runner = new ScriptedRunner([
    stdoutResult(EXISTING_DIR_SLASH + "\n"),
    stdoutResult(DETACHED_STATUS),
    stdoutResult(""),
    stdoutResult(""),
  ]);
  const s = await makeService(runner).getStatus(winLocation(EXISTING_DIR));
  assertEqual(s.detachedHeadOid, "332bce7", "detachedHeadOid short form");
  assertEqual(s.branch, undefined, "branch undefined");
  assertEqual(s.emptyRepo, undefined, "not empty repo");
});

await run("parse: empty repo (unborn HEAD) -> files [], zero counts, emptyRepo", async () => {
  for (const [fixture, label] of [
    [EMPTY_STATUS, "modern (branch.head main)"],
    [EMPTY_LEGACY_STATUS, "legacy (branch.head (unknown))"],
  ] as const) {
    const runner = new ScriptedRunner([stdoutResult(EXISTING_DIR_SLASH + "\n"), stdoutResult(fixture), stdoutResult(""), stdoutResult("")]);
    const s = await makeService(runner).getStatus(winLocation(EXISTING_DIR));
    assertEqual(s.kind, "repository", `${label}: kind`);
    assertEqual(s.emptyRepo, true, `${label}: emptyRepo`);
    assertDeepEqual(s.files, [], `${label}: files empty`);
    assertEqual(s.branch, undefined, `${label}: no branch`);
    assertDeepEqual(s.counts, ZERO_COUNTS, `${label}: zero counts`);
  }
});

await run("parse: unborn HEAD with staged files keeps real data (#C1)", async () => {
  const runner = new ScriptedRunner([
    stdoutResult(EXISTING_DIR_SLASH + "\n"),
    stdoutResult(UNBORN_STAGED_STATUS),
    stdoutResult("2\t0\tf.txt\x00"),
    stdoutResult(""),
  ]);
  const s = await makeService(runner).getStatus(winLocation(EXISTING_DIR));
  assertEqual(s.kind, "repository", "kind");
  assertEqual(s.emptyRepo, undefined, "not emptyRepo (has staged changes)");
  assertEqual(s.branch, "main", "branch main");
  const f = fileByPath(s, "f.txt");
  assert(f !== undefined, "f.txt in files");
  assertEqual(f!.staged, true, "staged");
  assertEqual(f!.additions, 2, "additions from numstat");
  assertDeepEqual(
    s.counts,
    { staged: 1, unstaged: 0, untracked: 0, conflicts: 0, additions: 2, deletions: 0 },
    "real counts despite unborn HEAD",
  );
});

await run("parse: file name with newline byte parsed verbatim (#15)", async () => {
  const runner = new ScriptedRunner([
    stdoutResult(EXISTING_DIR_SLASH + "\n"),
    stdoutResult(NEWLINE_PATH_STATUS),
    stdoutResult("1\t1\ta\nb.txt\x00"),
    stdoutResult(""),
  ]);
  const s = await makeService(runner).getStatus(winLocation(EXISTING_DIR));
  const f = fileByPath(s, "a\nb.txt");
  assert(f !== undefined, "newline path file listed");
  assertEqual(f!.unstaged, true, "unstaged");
  assertEqual(f!.additions, 1, "additions");
  assertEqual(f!.deletions, 1, "deletions");
  assert(fileByPath(s, "a") === undefined, "no truncated path 'a'");
  assert(fileByPath(s, "b.txt") === undefined, "no stray fragment 'b.txt'");
});

await run("parse: rename origPath with newline byte (#15 + #8 merge)", async () => {
  const runner = new ScriptedRunner([
    stdoutResult(EXISTING_DIR_SLASH + "\n"),
    stdoutResult(RENAME_NEWLINE_ORIGPATH_STATUS),
    stdoutResult("0\t1\told\nname.txt\x00" + "1\t0\tnew.txt\x00"),
    stdoutResult(""),
  ]);
  const s = await makeService(runner).getStatus(winLocation(EXISTING_DIR));
  const moved = fileByPath(s, "new.txt");
  assert(moved !== undefined, "new.txt in files");
  assertEqual(moved!.renamed, true, "renamed");
  assertEqual(moved!.origPath, "old\nname.txt", "origPath verbatim with newline");
  assertEqual(moved!.additions, 1, "additions from new-path record");
  assertEqual(moved!.deletions, 1, "deletions merged via newline origPath");
});

await run("parse: legacy LF-terminated header lines (old git) still parse (#15)", async () => {
  const runner = new ScriptedRunner([
    stdoutResult(EXISTING_DIR_SLASH + "\n"),
    stdoutResult(LEGACY_LF_HEADERS),
    stdoutResult(""),
    stdoutResult(""),
  ]);
  const s = await makeService(runner).getStatus(winLocation(EXISTING_DIR));
  assertEqual(s.branch, "main", "branch parsed from LF-terminated headers");
  const a = fileByPath(s, "a.txt");
  assert(a !== undefined, "record sharing the chunk after LF headers parsed");
  assertEqual(a!.unstaged, true, "unstaged");
});

await run("parse: numstat record for unknown path (no origPath match) is ignored", async () => {
  const runner = new ScriptedRunner([
    stdoutResult(EXISTING_DIR_SLASH + "\n"),
    stdoutResult(BASIC_STATUS),
    stdoutResult("5\t5\tz.txt\x00"),
    stdoutResult("1\t0\tb.txt\x00"),
  ]);
  const s = await makeService(runner).getStatus(winLocation(EXISTING_DIR));
  assert(fileByPath(s, "z.txt") === undefined, "z.txt not listed");
  assertEqual(s.counts!.additions, 1, "additions exclude unknown-path record");
  assertEqual(s.counts!.deletions, 0, "deletions exclude unknown-path record");
});

await run("windows: nonexistent physicalPath -> unavailable/invalid_location before runner (#14)", async () => {
  const missing = join(tmpdir(), `pix-git-status-missing-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const runner = new ScriptedRunner([]);
  const s = await makeService(runner).getStatus(winLocation(missing));
  assertEqual(s.kind, "unavailable", "kind");
  assertEqual(s.errorCode, "invalid_location", "errorCode");
  assertEqual(runner.calls.length, 0, "runner never called");
});

await run("wsl: physicalPath existence not prechecked (wsl.exe handles cwd, #14)", async () => {
  const runner = new ScriptedRunner([stdoutResult("/home/u/proj\n"), stdoutResult(""), stdoutResult(""), stdoutResult("")]);
  const s = await makeService(runner).getStatus(wslLocation("/home/u/proj", "\\\\wsl.localhost\\Ubuntu\\home\\u\\proj"));
  assertEqual(s.kind, "repository", "kind");
  assertEqual(runner.calls.length, 4, "four commands ran");
});

await run("truncated status/diff -> complete false, partial records dropped, valid records kept", async () => {
  const runner = new ScriptedRunner([
    stdoutResult(EXISTING_DIR_SLASH + "\n"),
    stdoutResult(TRUNCATED_STATUS, { truncated: true }),
    stdoutResult("1\t0\tb.txt\x00" + "3\t", { truncated: true }),
    stdoutResult(""),
  ]);
  const s = await makeService(runner).getStatus(winLocation(EXISTING_DIR));
  assertEqual(s.complete, false, "complete false on truncation");
  assertEqual(s.branch, "main", "headers before truncation still parsed");
  const n = fileByPath(s, "new.txt");
  assert(n !== undefined, "complete record before truncation parsed");
  assert(fileByPath(s, "unt") === undefined, "partial trailing record dropped");
  const b = fileByPath(s, "b.txt");
  assert(b !== undefined, "b.txt in files");
  assertEqual(b!.additions, 1, "complete numstat record applied");
});

await run("sorting: conflict > untracked > modified > deleted > renamed (path lexicographic within group)", async () => {
  const runner = new ScriptedRunner([
    stdoutResult(EXISTING_DIR_SLASH + "\n"),
    stdoutResult(SORT_STATUS),
    stdoutResult(""),
    stdoutResult(""),
  ]);
  const s = await makeService(runner).getStatus(winLocation(EXISTING_DIR));
  assertDeepEqual(
    s.files.map((f) => f.path),
    ["c.txt", "u1.txt", "u2.txt", "d.txt", "m.txt", "z.txt"],
    "sort order (staged deletion d.txt joins the modified group per highest-group rule)",
  );
  const d = fileByPath(s, "d.txt");
  assert(d !== undefined, "d.txt in files");
  assertEqual(d!.deleted, true, "d deleted flag");
  assertEqual(d!.staged, true, "d staged flag");
  assertEqual(s.counts!.staged, 2, "staged count (d + m)");
  assertEqual(s.counts!.unstaged, 1, "unstaged count (z)");
  assertEqual(s.counts!.untracked, 2, "untracked count");
  assertEqual(s.counts!.conflicts, 1, "conflicts count");
});

await run("scopedToProject: windows normalize vs wsl strict", async () => {
  // Windows：两侧统一斜杠方向且大小写不敏感（physicalPath 须真实存在——#14
  // 预检，此处用 EXISTING_DIR，toplevel 取它的斜杠/大小写变体）
  const projSlash = EXISTING_DIR.replace(/\\/g, "/");
  const projSlashUpper = projSlash.toUpperCase();
  const r1 = new ScriptedRunner([stdoutResult(projSlashUpper + "\n"), stdoutResult(""), stdoutResult(""), stdoutResult("")]);
  const s1 = await makeService(r1).getStatus(winLocation(EXISTING_DIR));
  assertEqual(s1.scopedToProject, false, "windows equal (slash + case insensitive)");
  assertEqual(s1.repositoryName, projSlashUpper.split("/").pop(), "repositoryName basename");

  const r2 = new ScriptedRunner([stdoutResult(projSlash + "\n"), stdoutResult(""), stdoutResult(""), stdoutResult("")]);
  const s2 = await makeService(r2).getStatus(winLocation(join(EXISTING_DIR, "sub")));
  assertEqual(s2.scopedToProject, true, "windows nested -> scoped");

  // WSL：posix 语义、严格字符串比较
  const r3 = new ScriptedRunner([stdoutResult("/home/u/proj\n"), stdoutResult(""), stdoutResult(""), stdoutResult("")]);
  const s3 = await makeService(r3).getStatus(wslLocation("/home/u/proj", "\\\\wsl.localhost\\Ubuntu\\home\\u\\proj"));
  assertEqual(s3.scopedToProject, false, "wsl equal (strict)");

  const r4 = new ScriptedRunner([stdoutResult("/home/u/proj\n"), stdoutResult(""), stdoutResult(""), stdoutResult("")]);
  const s4 = await makeService(r4).getStatus(wslLocation("/home/u/proj/sub", "\\\\wsl.localhost\\Ubuntu\\home\\u\\proj\\sub"));
  assertEqual(s4.scopedToProject, true, "wsl nested -> scoped");

  const r5 = new ScriptedRunner([stdoutResult("/home/u/proj\n"), stdoutResult(""), stdoutResult(""), stdoutResult("")]);
  const s5 = await makeService(r5).getStatus(wslLocation("/home/u/Proj", "\\\\wsl.localhost\\Ubuntu\\home\\u\\Proj"));
  assertEqual(s5.scopedToProject, true, "wsl case-sensitive -> scoped");
});

// ============================================================================
// ② Integration tests against real git (skipped when git is not installed)
// ============================================================================

const HAS_GIT = (() => {
  const probe = spawnSync("git", ["--version"], { stdio: "ignore" });
  return probe.error === undefined && probe.status === 0;
})();

const WORKSPACE = mkdtempSync(join(tmpdir(), "pix-git-status-ws-"));

function git(dir: string, args: string[], expectOk = true): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  const result = { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  if (expectOk && result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${result.status}): ${result.stderr}`);
  }
  return result;
}

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main", "."]);
  git(dir, ["config", "user.email", "t@t"]);
  git(dir, ["config", "user.name", "t"]);
  git(dir, ["config", "core.autocrlf", "false"]);
}

function commitAll(dir: string, message: string): void {
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", message]);
}

async function statusAt(physicalPath: string, path = physicalPath): Promise<GitWorkdirSnapshot> {
  const service = createGitStatusService();
  return service.getStatus({ path, physicalPath, name: "proj", environment: { kind: "windows" } });
}

if (!HAS_GIT) {
  console.log("\n=== real-git integration tests SKIPPED (git not found) ===\n");
} else {
  await run("integration: clean repo", async () => {
    const dir = join(WORKSPACE, "clean");
    initRepo(dir);
    writeFileSync(join(dir, "f.txt"), "line1\nline2\n", "utf8");
    commitAll(dir, "init");
    const s = await statusAt(dir);
    assertEqual(s.kind, "repository", "kind repository");
    assertEqual(s.complete, true, "complete");
    assertEqual(s.branch, "main", "branch main");
    assertEqual(s.scopedToProject, false, "not scoped");
    assertEqual(s.repositoryName, "clean", "repositoryName");
    assertEqual(s.emptyRepo, undefined, "not empty");
    assertDeepEqual(s.files, [], "no files");
    assertDeepEqual(s.counts, ZERO_COUNTS, "zero counts");
  });

  await run("integration: staged + unstaged + untracked with line counts", async () => {
    const dir = join(WORKSPACE, "mixed");
    initRepo(dir);
    writeFileSync(join(dir, "f.txt"), "one\ntwo\n", "utf8");
    commitAll(dir, "init");
    writeFileSync(join(dir, "f.txt"), "one\ntwo\nthree\nfour\n", "utf8"); // 工作区 +2
    writeFileSync(join(dir, "g.txt"), "g1\ng2\ng3\n", "utf8");
    git(dir, ["add", "g.txt"]); // 暂存新文件 +3
    writeFileSync(join(dir, "h.txt"), "h\n", "utf8"); // 未跟踪
    const s = await statusAt(dir);
    assertEqual(s.kind, "repository", "kind");

    const f = fileByPath(s, "f.txt");
    assert(f !== undefined, "f.txt in files");
    assertEqual(f!.unstaged, true, "f unstaged");
    assertEqual(f!.additions, 2, "f additions");
    assertEqual(f!.deletions, 0, "f deletions");

    const g = fileByPath(s, "g.txt");
    assert(g !== undefined, "g.txt in files");
    assertEqual(g!.staged, true, "g staged");
    assertEqual(g!.additions, 3, "g additions");

    const h = fileByPath(s, "h.txt");
    assert(h !== undefined, "h.txt in files");
    assertEqual(h!.untracked, true, "h untracked");
    assertEqual(h!.additions, null, "h additions null");

    assertDeepEqual(s.counts, { staged: 1, unstaged: 1, untracked: 1, conflicts: 0, additions: 5, deletions: 0 }, "counts");
  });

  await run("integration: rename via git mv", async () => {
    const dir = join(WORKSPACE, "rename");
    initRepo(dir);
    writeFileSync(join(dir, "f.txt"), "one\ntwo\nthree\n", "utf8");
    commitAll(dir, "init");
    git(dir, ["mv", "f.txt", "renamed.txt"]);
    writeFileSync(join(dir, "renamed.txt"), "one\ntwo\nthree\nfour\n", "utf8"); // 内容 +1 行后暂存
    git(dir, ["add", "renamed.txt"]);
    const s = await statusAt(dir);
    const moved = fileByPath(s, "renamed.txt");
    assert(moved !== undefined, "renamed.txt in files");
    assertEqual(moved!.renamed, true, "renamed flag");
    assertEqual(moved!.origPath, "f.txt", "origPath f.txt");
    assertEqual(moved!.staged, true, "staged rename");
    assertEqual(moved!.unstaged, false, "not unstaged");
    // --no-renames 下 numstat 输出旧路径 0/-3 记录，经 origPath 归并进新路径
    assertEqual(moved!.additions, 4, "additions from new-path numstat record");
    assertEqual(moved!.deletions, 3, "deletions from old-path record merged via origPath");
    assert(fileByPath(s, "f.txt") === undefined, "old path not listed");
    assertEqual(s.counts!.staged, 1, "staged count");
    assertEqual(s.counts!.additions, 4, "additions count");
    assertEqual(s.counts!.deletions, 3, "deletions count");
  });

  await run("integration: merge conflict", async () => {
    const dir = join(WORKSPACE, "conflict");
    initRepo(dir);
    writeFileSync(join(dir, "f.txt"), "base\n", "utf8");
    commitAll(dir, "base");
    git(dir, ["checkout", "-qb", "side"]);
    writeFileSync(join(dir, "f.txt"), "side\n", "utf8");
    commitAll(dir, "side");
    git(dir, ["checkout", "-q", "main"]);
    writeFileSync(join(dir, "f.txt"), "main\n", "utf8");
    commitAll(dir, "main");
    git(dir, ["merge", "side", "-m", "merge"], false); // 预期冲突，允许非零退出
    const s = await statusAt(dir);
    const f = fileByPath(s, "f.txt");
    assert(f !== undefined, "f.txt in files");
    assertEqual(f!.conflict, true, "conflict flag");
    assertEqual(f!.additions, null, "conflict additions null");
    assertEqual(s.counts!.conflicts, 1, "conflicts count");
  });

  await run("integration: detached HEAD", async () => {
    const dir = join(WORKSPACE, "detached");
    initRepo(dir);
    writeFileSync(join(dir, "f.txt"), "one\n", "utf8");
    commitAll(dir, "init");
    git(dir, ["checkout", "-q", "--detach"]);
    const s = await statusAt(dir);
    assertEqual(s.branch, undefined, "no branch");
    const short = git(dir, ["rev-parse", "--short=7", "HEAD"]).stdout.trim();
    assertEqual(s.detachedHeadOid, short, "detachedHeadOid matches git short oid");
  });

  await run("integration: empty repo (no commits)", async () => {
    const dir = join(WORKSPACE, "empty");
    initRepo(dir);
    const s = await statusAt(dir);
    assertEqual(s.kind, "repository", "kind repository");
    assertEqual(s.emptyRepo, true, "emptyRepo");
    assertDeepEqual(s.files, [], "no files");
    assertDeepEqual(s.counts, ZERO_COUNTS, "zero counts");
  });

  await run("integration: empty repo with staged file keeps real data (#C1)", async () => {
    const dir = join(WORKSPACE, "empty-staged");
    initRepo(dir);
    writeFileSync(join(dir, "f.txt"), "hi\n", "utf8");
    git(dir, ["add", "f.txt"]);
    const s = await statusAt(dir);
    assertEqual(s.kind, "repository", "kind repository");
    assertEqual(s.emptyRepo, undefined, "not emptyRepo (has staged changes)");
    assertEqual(s.branch, "main", "branch main");
    const f = fileByPath(s, "f.txt");
    assert(f !== undefined, "f.txt in files");
    assertEqual(f!.staged, true, "staged");
    assertEqual(f!.additions, 1, "additions");
    assertEqual(s.counts!.staged, 1, "staged count");
    assertEqual(s.counts!.additions, 1, "additions count");
  });

  await run("integration: directory outside any git worktree", async () => {
    const dir = join(WORKSPACE, "nonrepo");
    mkdirSync(dir, { recursive: true });
    const s = await statusAt(dir);
    assertEqual(s.kind, "not-repository", "kind not-repository");
    assertEqual(s.complete, true, "complete");
    assertDeepEqual(s.files, [], "no files");
  });

  await run("integration: nested project inside a parent repo is scoped", async () => {
    const root = join(WORKSPACE, "nested-root");
    initRepo(root);
    mkdirSync(join(root, "sub"), { recursive: true });
    writeFileSync(join(root, "sub", "inner.txt"), "i\n", "utf8");
    writeFileSync(join(root, "outside.txt"), "o\n", "utf8");
    commitAll(root, "init");
    writeFileSync(join(root, "sub", "inner.txt"), "i\nchanged\n", "utf8");
    writeFileSync(join(root, "outside.txt"), "o\nchanged\n", "utf8");
    const sub = join(root, "sub");
    const s = await statusAt(sub);
    assertEqual(s.scopedToProject, true, "scopedToProject");
    assertEqual(s.repositoryName, "nested-root", "repositoryName is parent repo basename");
    assertDeepEqual(s.files.map((f) => f.path), ["sub/inner.txt"], "only changes inside the project directory");
    assertEqual(s.counts!.unstaged, 1, "unstaged count");
  });
}

// ============================================================================

try {
  rmSync(WORKSPACE, { recursive: true, force: true });
  rmSync(EXISTING_DIR, { recursive: true, force: true });
} catch {
  // temp workspace cleanup is best-effort
}

console.log(`\nPassed: ${passed}, Failed: ${failed}`);
if (failed > 0) {
  process.exit(1);
}
