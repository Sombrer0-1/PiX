/**
 * WriteLeaseTable tests (S2b, plan §4.6 / §5.8 / H31 / H40 / H44).
 *
 * Covers:
 *   - one writer per path key; a second seat gets { ok: false, ownerSeatId }
 *   - the pathKey comes from the injected resolver (several inputs collapse onto
 *     one key) and never from node's path.resolve
 *   - H40 read-modify-write: B reads a path A holds -> B's acquire/write is
 *     refused with staleRead until A releases AND B re-reads
 *   - a read of a free path is invalidated as soon as another seat acquires it
 *   - release(seat) clears every lease of that seat; release(seat, path) one
 *   - a refused acquire fires the write_conflict hook (H44) with path and owner
 *   - list()/restore() round-trip for the leases.json snapshot (§4.10)
 *
 * Run with: npx tsx pix/src/main/__tests__/team-write-lease.test.ts
 */

import { resolve as nodeResolve } from "node:path";
import { inspectToolExecution } from "@earendil-works/pi-coding-agent";
import type { WriteLease } from "../../shared/team-types.js";
import { createSeatToolPolicy } from "../team/seat-policy.js";
import {
  WriteLeaseTable,
  type WriteConflictInfo,
  type WriteLeaseAcquireResult,
} from "../team/write-lease.js";

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
// Helpers
// ============================================================================

type Acquired = { ok: true; lease: WriteLease };
type RefusedByOwner = { ok: false; ownerSeatId: string };
type RefusedStale = { ok: false; staleRead: true };

function acquired(result: WriteLeaseAcquireResult): result is Acquired {
  return result.ok === true;
}

function refusedByOwner(result: WriteLeaseAcquireResult): result is RefusedByOwner {
  return !result.ok && "ownerSeatId" in result;
}

function refusedStale(result: WriteLeaseAcquireResult): result is RefusedStale {
  return !result.ok && "staleRead" in result;
}

const LOGICAL_CWD = "/ws";

/**
 * Stand-in for H31's `backend.paths.resolvePath(input, logicalCwd)`: it folds the
 * model-visible spellings the real resolver handles (`@/` workspace root, `~/`
 * home, backslashes, case) onto one key. node's path.resolve would answer with a
 * host path ("E:\\develop\\pi\\src\\a.ts") and is never consulted.
 */
function resolvePathKey(input: string): string {
  let p = input.trim().replace(/\\/g, "/");
  while (p.startsWith("./")) p = p.slice(2);
  if (p.startsWith("@/")) p = p.slice(2);
  if (p.startsWith("~/")) p = `/home/user/${p.slice(2)}`;
  else if (!p.startsWith("/")) p = `${LOGICAL_CWD}/${p}`;
  return p.toLowerCase();
}

// ============================================================================
// Tests
// ============================================================================

await run("one writer per path key", async () => {
  const leases = new WriteLeaseTable(resolvePathKey);

  const first = leases.acquire("A", "src/a.ts");
  assert(acquired(first), "A acquires src/a.ts");
  if (acquired(first)) {
    assertEqual(first.lease.pathKey, "/ws/src/a.ts", "lease carries the resolver's pathKey");
    assertEqual(first.lease.ownerSeatId, "A", "lease carries the owner seatId");
    assertEqual(typeof first.lease.acquiredAt, "number", "lease carries acquiredAt");
  }
  assertEqual(leases.ownerOf("src/a.ts"), "A", "ownerOf reports A");
  assertEqual(leases.ownerOf("./src/a.ts"), "A", "ownerOf normalises through the resolver as well");

  const sameSeat = leases.acquire("A", "@/src/A.TS");
  assert(acquired(sameSeat) && sameSeat.lease === (acquired(first) ? first.lease : undefined), "re-acquire by the owner returns the existing lease");

  const second = leases.acquire("B", "src/a.ts");
  assert(refusedByOwner(second), "a second seat is refused");
  assert(refusedByOwner(second) && second.ownerSeatId === "A", "the refusal names the current owner");
  assertEqual(leases.ownerOf("src/a.ts"), "A", "the refused acquire did not steal the lease");
  assertEqual(leases.list().length, 1, "still exactly one lease");
});

await run("pathKey comes from the injected resolver, never from path.resolve", async () => {
  const leases = new WriteLeaseTable(resolvePathKey);

  // Four spellings of the same file collapse onto one key.
  assertEqual(leases.pathKeyOf("src/a.ts"), "/ws/src/a.ts", "relative input");
  assertEqual(leases.pathKeyOf("./src/a.ts"), "/ws/src/a.ts", "'./' input");
  assertEqual(leases.pathKeyOf("@/src/A.TS"), "/ws/src/a.ts", "'@/' + case folded input");
  assertEqual(leases.pathKeyOf("src\\a.ts"), "/ws/src/a.ts", "backslash input");
  assertEqual(leases.pathKeyOf("~/src/a.ts"), "/home/user/src/a.ts", "'~/' resolves through the resolver, not literally");
  assert(leases.pathKeyOf("src/a.ts") !== "~/src/a.ts", "the raw input is not used as the key");

  const held = leases.acquire("A", "src\\a.ts");
  assert(acquired(held), "A acquires through a backslash spelling");
  if (acquired(held)) {
    assertEqual(held.lease.pathKey, resolvePathKey("src/a.ts"), "the pathKey is exactly the injected resolver's answer");
    assert(
      held.lease.pathKey !== nodeResolve("src/a.ts"),
      `the pathKey is not node path.resolve output (${nodeResolve("src/a.ts")})`,
    );
  }
  assert(refusedByOwner(leases.acquire("B", "@/src/A.TS")), "a different spelling maps onto the same occupied key");

  // A different resolver produces different keys for the same input: resolution
  // is injected, not built into the table (H31).
  const other = new WriteLeaseTable((input) => `other:${input}`);
  assertEqual(other.pathKeyOf("src/a.ts"), "other:src/a.ts", "a second table uses its own resolver");
  const otherLease = other.acquire("A", "src/a.ts");
  assert(acquired(otherLease) && otherLease.lease.pathKey === "other:src/a.ts", "the second table keys from its resolver");
});

await run("H40: A holds, B reads, B cannot write until A releases and B re-reads", async () => {
  const leases = new WriteLeaseTable(resolvePathKey);
  const conflicts: WriteConflictInfo[] = [];
  leases.onConflict = (info) => conflicts.push(info);

  assert(acquired(leases.acquire("A", "src/a.ts")), "A acquires src/a.ts");
  leases.noteRead("B", "src/a.ts"); // B reads while A holds the lease
  assertEqual(conflicts.length, 0, "a read is not a conflict");

  const whileHeld = leases.acquire("B", "src/a.ts");
  assert(refusedStale(whileHeld), "B's acquire is refused with staleRead while A holds");
  assertEqual(leases.ownerOf("src/a.ts"), "A", "A keeps the lease");

  // A writes (the lease does not change) - B's cached copy is now definitely stale.
  const afterWrite = leases.acquire("B", "src/a.ts");
  assert(refusedStale(afterWrite), "B stays refused after A's write");

  leases.release("A", "src/a.ts");
  assertEqual(leases.ownerOf("src/a.ts"), undefined, "A released the path");
  assert(refusedStale(leases.acquire("B", "src/a.ts")), "the path is free but B's copy is stale, so B is still refused");

  leases.noteRead("B", "src/a.ts"); // B re-reads the now free path
  const reacquired = leases.acquire("B", "src/a.ts");
  assert(acquired(reacquired), "after re-reading, B acquires");
  assertEqual(leases.ownerOf("src/a.ts"), "B", "B now owns the lease");

  assertEqual(conflicts.length, 3, "every refused acquire was reported");
  assertEqual(conflicts[0]?.requestedBy, "B", "conflict names the requesting seat");
  assertEqual(conflicts[0]?.path, "src/a.ts", "conflict carries the raw input path");
  assertEqual(conflicts[0]?.pathKey, "/ws/src/a.ts", "conflict carries the resolved pathKey");
  assertEqual(conflicts[0]?.ownerSeatId, "A", "conflict carries the current owner for Attention");
  assertEqual(conflicts[0]?.staleRead, true, "conflict is flagged as a stale read");
  assertEqual(conflicts[2]?.ownerSeatId, undefined, "after release the conflict has no owner");
});

await run("H40: a read of a free path is invalidated once another seat acquires it", async () => {
  const leases = new WriteLeaseTable(resolvePathKey);

  leases.noteRead("C", "src/b.ts"); // C reads while nobody holds it
  assertEqual(leases.ownerOf("src/b.ts"), undefined, "the path is free after C's read");
  assert(acquired(leases.acquire("C", "src/b.ts")), "an unclaimed path can still be acquired by its reader");
  leases.release("C", "src/b.ts");

  assert(acquired(leases.acquire("D", "src/b.ts")), "D acquires the path C read");
  assert(refusedStale(leases.acquire("C", "src/b.ts")), "C cannot write on the copy it read before D took the lease");

  leases.release("D", "src/b.ts");
  assert(refusedStale(leases.acquire("C", "src/b.ts")), "the refusal survives D's release until C re-reads");
  leases.noteRead("C", "src/b.ts");
  assert(acquired(leases.acquire("C", "src/b.ts")), "C re-reads and then acquires");
});

await run("the owner's own read never arms staleRead", async () => {
  const leases = new WriteLeaseTable(resolvePathKey);
  assert(acquired(leases.acquire("A", "src/a.ts")), "A acquires");
  leases.noteRead("A", "src/a.ts");
  assert(acquired(leases.acquire("A", "src/a.ts")), "A reading its own leased path keeps the lease writable");
});

await run("release without a path clears every lease of that seat", async () => {
  const leases = new WriteLeaseTable(resolvePathKey);
  assert(acquired(leases.acquire("A", "src/a.ts")), "A acquires src/a.ts");
  assert(acquired(leases.acquire("A", "src/b.ts")), "A acquires src/b.ts");
  assert(refusedByOwner(leases.acquire("B", "src/a.ts")), "B is refused on src/a.ts");
  assert(refusedByOwner(leases.acquire("B", "src/b.ts")), "B is refused on src/b.ts");

  leases.release("A");
  assertEqual(leases.ownerOf("src/a.ts"), undefined, "src/a.ts is free after release(seat)");
  assertEqual(leases.ownerOf("src/b.ts"), undefined, "src/b.ts is free after release(seat)");
  assertEqual(leases.list().length, 0, "no leases left");
  assert(acquired(leases.acquire("B", "src/a.ts")), "B can now acquire src/a.ts");
  assert(acquired(leases.acquire("B", "src/b.ts")), "B can now acquire src/b.ts");
});

await run("release with a path releases exactly one lease", async () => {
  const leases = new WriteLeaseTable(resolvePathKey);
  assert(acquired(leases.acquire("A", "src/a.ts")), "A acquires src/a.ts");
  assert(acquired(leases.acquire("A", "src/b.ts")), "A acquires src/b.ts");

  leases.release("B", "src/a.ts");
  assertEqual(leases.ownerOf("src/a.ts"), "A", "a non-owner cannot release someone else's lease");

  leases.release("A", "src/a.ts");
  assertEqual(leases.ownerOf("src/a.ts"), undefined, "src/a.ts released");
  assertEqual(leases.ownerOf("src/b.ts"), "A", "src/b.ts still held");
  assertEqual(leases.list().length, 1, "exactly one lease remains");

  leases.release("A", "src/b.ts");
  assertEqual(leases.list().length, 0, "releasing the last path empties the table");
  leases.release("A", "src/b.ts");
  assertEqual(leases.list().length, 0, "releasing an unheld path is a no-op");
});

await run("release(seat) clears the seat's reader registration and stale-read flags (F2-5)", async () => {
  // Reader registration: A read a free path and then left the table. If the
  // registration survived, the next writer would mark A stale forever.
  const readers = new WriteLeaseTable(resolvePathKey);
  readers.noteRead("A", "src/b.ts");
  readers.release("A"); // A owns no lease: the old release() returned early here
  assert(acquired(readers.acquire("B", "src/b.ts")), "B acquires the path A released");
  readers.release("B", "src/b.ts");
  assert(
    acquired(readers.acquire("A", "src/b.ts")),
    "release(seat) dropped A's reader registration: A is not marked stale by a later writer",
  );

  // Stale-read flag: C read the copy D held, then left; the flag must go with it.
  const stale = new WriteLeaseTable(resolvePathKey);
  assert(acquired(stale.acquire("D", "src/d.ts")), "D holds src/d.ts");
  stale.noteRead("C", "src/d.ts");
  assert(refusedStale(stale.acquire("C", "src/d.ts")), "C is refused with staleRead while D holds");
  stale.release("C");
  stale.release("D", "src/d.ts");
  assert(
    acquired(stale.acquire("C", "src/d.ts")),
    "release(C) cleared C's stale flag (the old release kept it forever)",
  );

  // release(seat, path) only clears that key's stale flag, never another key's.
  const onePath = new WriteLeaseTable(resolvePathKey);
  assert(acquired(onePath.acquire("E", "src/e.ts")), "E holds src/e.ts");
  onePath.noteRead("F", "src/e.ts");
  assert(refusedStale(onePath.acquire("F", "src/e.ts")), "F read E's copy → stale");
  onePath.release("F", "src/other.ts");
  onePath.release("E", "src/e.ts");
  assert(refusedStale(onePath.acquire("F", "src/e.ts")), "releasing one path leaves other stale flags alone");
});

await run("the write_conflict hook only fires for refused acquires", async () => {
  const leases = new WriteLeaseTable(resolvePathKey);
  const seen: WriteConflictInfo[] = [];
  leases.onConflict = (info) => seen.push(info);

  assert(acquired(leases.acquire("A", "src/a.ts")), "A acquires");
  assertEqual(seen.length, 0, "a granted acquire does not fire the hook");

  assert(acquired(leases.acquire("A", "src/a.ts")), "A re-acquires its own path");
  assertEqual(seen.length, 0, "re-acquiring your own lease does not fire the hook");

  assert(refusedByOwner(leases.acquire("B", "src/a.ts")), "B is refused");
  assertEqual(seen.length, 1, "the refusal fired the hook once");
  assertEqual(seen[0]?.ownerSeatId, "A", "the hook carries the current owner");

  leases.release("A", "src/a.ts");
  assertEqual(seen.length, 1, "release does not fire the hook");
  assert(acquired(leases.acquire("B", "src/a.ts")), "B acquires the released path");
  assertEqual(seen.length, 1, "the granted retry did not fire the hook");

  // The hook stays optional: a table constructed without one still refuses.
  const quiet = new WriteLeaseTable(resolvePathKey);
  assert(acquired(quiet.acquire("A", "src/a.ts")), "quiet table: A acquires");
  assert(refusedByOwner(quiet.acquire("B", "src/a.ts")), "quiet table: B is refused without a hook attached");
});

await run("list()/restore() round-trip the leases.json snapshot", async () => {
  const leases = new WriteLeaseTable(resolvePathKey);
  assert(acquired(leases.acquire("A", "src/b.ts")), "A acquires src/b.ts");
  assert(acquired(leases.acquire("B", "src/a.ts")), "B acquires src/a.ts");

  const snapshot = leases.list();
  assertEqual(snapshot.length, 2, "both leases are listed");
  assertEqual(snapshot[0]?.pathKey, "/ws/src/a.ts", "list() is sorted by pathKey");
  assertEqual(snapshot[0]?.ownerSeatId, "B", "list() keeps the owner");

  const copy = snapshot[0];
  if (copy) copy.ownerSeatId = "Z";
  assertEqual(leases.ownerOf("src/a.ts"), "B", "list() returns copies, not live leases");
  if (copy) copy.ownerSeatId = "B";

  const restored = new WriteLeaseTable(resolvePathKey);
  restored.restore(snapshot);
  assertEqual(restored.ownerOf("src/a.ts"), "B", "restore keeps ownership");
  assertEqual(restored.ownerOf("src/b.ts"), "A", "restore keeps ownership");
  assert(refusedByOwner(restored.acquire("C", "src/a.ts")), "a restored lease still refuses other seats");
  assert(acquired(restored.acquire("B", "src/a.ts")), "the restored owner keeps its lease");

  restored.restore([]);
  assertEqual(restored.list().length, 0, "restore replaces the current contents");
  assertEqual(restored.ownerOf("src/a.ts"), undefined, "the replaced lease is gone");
});

await run("solo sessions never reach the lease table", async () => {
  // T-3：原用例建了一张空表，然后断言「表还是空的」——表与受测代码没有任何引用
  // 关系，三条断言恒真（把 write-lease.ts 整个改成空实现也照样绿）。改成
  // 「同一输入 + 两种表状态 → 内置策略给出同一个判定」：表被接进默认策略
  // （solo 被租约影响）时，两次结果不再相同。
  const soloEdit = {
    mode: "approval",
    toolName: "edit",
    args: { path: "src/a.ts" },
    cwd: LOGICAL_CWD,
  } as const;

  const free = new WriteLeaseTable(resolvePathKey);
  const freeConflicts: WriteConflictInfo[] = [];
  free.onConflict = (info) => freeConflicts.push(info);
  const withoutLease = inspectToolExecution({ ...soloEdit, args: { path: "src/a.ts" } });

  // 预置一条别人的租约：如果内置策略看过这张表，同一个 solo edit 必然变成拒绝。
  const held = new WriteLeaseTable(resolvePathKey);
  const heldConflicts: WriteConflictInfo[] = [];
  held.onConflict = (info) => heldConflicts.push(info);
  const acquired = held.acquire("some-seat", "src/a.ts");
  assert(acquired.ok, "预置租约成功（这条用例的前提）");
  const withForeignLease = inspectToolExecution({ ...soloEdit, args: { path: "src/a.ts" } });

  // A solo session installs no host override: the built-in policy decides and
  // the table is never consulted (plan §2.4, test row S2b).
  assertEqual(withoutLease.allowed, true, "the built-in policy still allows the solo edit");
  assertEqual(withForeignLease.allowed, true, "a foreign lease never denies a solo edit");
  assertEqual(
    withForeignLease.allowed === withoutLease.allowed && withForeignLease.reason === withoutLease.reason,
    true,
    "the verdict does not depend on the lease table state",
  );

  // 反向确认表本身没被 solo 路径动过：租约还在，也没记读者/冲突。
  assertEqual(held.ownerOf("src/a.ts"), "some-seat", "the seeded lease is untouched");
  assertEqual(held.list().length, 1, "the table kept exactly its seeded lease");
  assertEqual(free.list().length, 0, "the free table took no lease");
  assertEqual(heldConflicts.length + freeConflicts.length, 0, "no write_conflict was raised");

  // 对照：真的接上租约表的席位策略会拒绝同一次写（solo 用的内置策略不允许这样）。
  const seatPolicy = createSeatToolPolicy({
    getAuth: () => "write",
    getAllowlist: () => undefined,
    getReadonlyCommands: () => [],
    bashEnabled: () => false,
    leases: held,
    logicalCwd: LOGICAL_CWD,
    seatId: "some-other-seat",
    teamToolNames: [],
  });
  const seatVerdict = seatPolicy({ ...soloEdit, args: { path: "src/a.ts" } });
  assert(
    seatVerdict !== undefined && seatVerdict.allowed === false,
    "同一张表在席位策略里确实会拒绝（证明上面的通过来自「不查表」）",
  );
});

// ============================================================================

console.log("\n=== Summary ===\n");
console.log(`Passed: ${passed}, Failed: ${failed}`);
if (failed > 0) {
  process.exit(1);
}
