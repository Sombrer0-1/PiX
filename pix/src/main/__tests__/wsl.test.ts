/**
 * WSL resolver & path primitive tests.
 *
 * S3 subset (--filter paths): parseWslListOutput unit cases, the WslPathConverter
 * round-trips from wsl_plan.md §4.5, and the list()-returns-a-diagnostic
 * guarantee. Real-WSL distro cases are gated by PIX_WSL_TEST_DISTRO and skip
 * when unset; fake/unit cases must pass without a distro.
 *
 * Run with: npx tsx pix/src/main/__tests__/wsl.test.ts --filter paths
 */

import { parseWslListOutput, WslDistroResolver } from "../wsl/wsl-distro.js";
import { WslPathConverter } from "../wsl/wsl-paths.js";
import type { WslPathContext } from "../wsl/wsl-paths.js";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createWslRuntime } from "../wsl/wsl-runtime.js";
import type { WslRuntime, WslRuntimeHooks, WslCommandResult } from "../wsl/wsl-runtime.js";
import { createWslExecutionBackend } from "../wsl/wsl-execution-backend.js";
import { createWslBashOperations } from "../wsl/wsl-bash-operations.js";
import { createWslFileOperations, toLogicalError } from "../wsl/wsl-file-operations.js";
import * as os from "node:os";
import * as fs from "node:fs";
import * as nodePath from "node:path";

// ============================================================================
// Test harness
// ============================================================================

const cliArgs = process.argv.slice(2);
const filterIdx = cliArgs.indexOf("--filter");
const filter = filterIdx >= 0 ? cliArgs[filterIdx + 1] : undefined;
const shouldRun = (name: string): boolean => !filter || filter === name;

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

function assertThrows(fn: () => void, message: string): void {
  try {
    fn();
    failed++;
    console.error(`  FAIL: ${message} - expected throw`);
  } catch {
    passed++;
    console.log(`  PASS: ${message}`);
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

async function assertResolves(promise: Promise<unknown>, message: string): Promise<void> {
  try {
    await promise;
    passed++;
    console.log(`  PASS: ${message}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL: ${message} - unexpected rejection: ${String(err)}`);
  }
}

// BOM/NUL helpers built from char codes so the source stays pure ASCII.
const BOM = String.fromCharCode(0xfeff);
const NUL = String.fromCharCode(0);

// ============================================================================
// paths subset
// ============================================================================

if (shouldRun("paths")) {
  console.log("\n=== parseWslListOutput Tests ===\n");

  const sampleText =
    "  NAME            STATE           VERSION\r\n" +
    "* Ubuntu-22.04    Running         2\r\n" +
    "  Debian          Stopped         2\r\n" +
    "  OldDistro       Running         1\r\n";

  // UTF-16LE Buffer with BOM (the raw wsl.exe stdout shape).
  const bomBuffer = Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from(sampleText, "utf16le"),
  ]);
  {
    const distros = parseWslListOutput(bomBuffer);
    assertEqual(distros.length, 3, "parses 3 distros from UTF-16LE buffer with BOM");
    const ubuntu = distros[0]!;
    assertEqual(ubuntu.name, "Ubuntu-22.04", "first distro name is verbatim Ubuntu-22.04");
    assertEqual(ubuntu.state, "Running", "first distro state is Running");
    assertEqual(ubuntu.version, 2, "first distro version is 2");
    assertEqual(ubuntu.isDefault, true, "first distro is marked default via *");
    const debian = distros[1]!;
    assertEqual(debian.name, "Debian", "second distro name is Debian");
    assertEqual(debian.isDefault, false, "second distro is not default");
    assertEqual(distros[2]!.version, 1, "WSL1 distro is parsed (version filtering is requireDistro's job)");
  }

  // Pre-decoded string carrying a leading BOM.
  {
    const distros = parseWslListOutput(BOM + sampleText);
    assertEqual(distros.length, 3, "parses 3 distros from pre-decoded string with BOM");
    assertEqual(distros[0]!.name, "Ubuntu-22.04", "string-with-BOM first distro name matches");
  }

  // Stray NUL characters are stripped (e.g. mis-decoded UTF-16 residue).
  {
    const nulLaced =
      BOM + "  NAME" + NUL + "            STATE           VERSION\r\n* Ubuntu-22.04    Running         2\r\n";
    const distros = parseWslListOutput(nulLaced);
    assertEqual(distros.length, 1, "strips stray NULs and still parses the distro");
    assertEqual(distros[0]!.name, "Ubuntu-22.04", "NUL-stripped distro name matches");
  }

  // No BOM, no default marker.
  {
    const distros = parseWslListOutput("  NAME   STATE   VERSION\r\n  Alpine  Running  2\r\n");
    assertEqual(distros.length, 1, "parses without BOM");
    assertEqual(distros[0]!.isDefault, false, "no default marker -> isDefault false");
  }

  // Empty / header-only input.
  {
    assertEqual(parseWslListOutput("").length, 0, "empty input yields no distros");
    assertEqual(parseWslListOutput("  NAME   STATE   VERSION\r\n").length, 0, "header-only yields no distros");
    assertEqual(parseWslListOutput(Buffer.alloc(0)).length, 0, "empty buffer yields no distros");
  }

  // Columns split on 2+ spaces; a single space inside a name is preserved.
  {
    const distros = parseWslListOutput("  NAME   STATE   VERSION\r\n* My Distro   Running   2\r\n");
    assertEqual(distros.length, 1, "single-space name stays one column");
    assertEqual(distros[0]!.name, "My Distro", "name with single space is preserved");
  }

  // Issue 8: structural parsing works without an English-header gate.
  // (a) The first non-empty line is a distro row (no header at all).
  {
    const distros = parseWslListOutput(
      "* Ubuntu-22.04    Running         2\r\n  Debian          Stopped         2\r\n",
    );
    assertEqual(distros.length, 2, "parses distros when first non-empty line is a distro row (no header)");
    assertEqual(distros[0]!.name, "Ubuntu-22.04", "no-header first distro name");
    assertEqual(distros[0]!.isDefault, true, "no-header first distro is default via *");
    assertEqual(distros[0]!.version, 2, "no-header first distro version is 2");
    assertEqual(distros[1]!.name, "Debian", "no-header second distro name");
  }

  // (b) A non-English/localized header line is skipped (VERSION column is not a
  // number) and the distro rows are parsed. Proves no English-header text match.
  {
    const distros = parseWslListOutput(
      "  NAME            ZUSTAND         VERSION\r\n* Ubuntu-22.04    Running         2\r\n",
    );
    assertEqual(distros.length, 1, "localized (German ZUSTAND) header is skipped, distro parsed");
    assertEqual(distros[0]!.name, "Ubuntu-22.04", "localized-header distro name");
    assertEqual(distros[0]!.version, 2, "localized-header distro version is 2");
  }

  console.log("\n=== WslPathConverter Tests (§4.5 round-trips) ===\n");

  const ctx: WslPathContext = {
    distro: "Ubuntu-22.04",
    home: "/home/u",
    automountRoot: "/mnt",
    automountEnabled: true,
  };
  const converter = new WslPathConverter(ctx);

  // linuxToWindows
  assertEqual(
    converter.linuxToWindows("/home/u/repo"),
    "\\\\wsl.localhost\\Ubuntu-22.04\\home\\u\\repo",
    "/home/u/repo -> UNC",
  );
  assertEqual(
    converter.linuxToWindows("/mnt/c/Users/u/repo"),
    "C:\\Users\\u\\repo",
    "/mnt/c/Users/u/repo -> drive path",
  );
  assertEqual(
    converter.linuxToWindows("/mnt/wsl/foo"),
    "\\\\wsl.localhost\\Ubuntu-22.04\\mnt\\wsl\\foo",
    "/mnt/wsl/foo (multi-letter) -> UNC",
  );
  assertEqual(converter.linuxToWindows("/mnt/c"), "C:\\", "/mnt/c root -> C:\\");
  assertEqual(
    converter.linuxToWindows("/mnt/wslg"),
    "\\\\wsl.localhost\\Ubuntu-22.04\\mnt\\wslg",
    "/mnt/wslg (multi-letter) -> UNC",
  );

  // windowsToLinux
  assertEqual(
    converter.windowsToLinux("C:\\Users\\u\\repo"),
    "/mnt/c/Users/u/repo",
    "C:\\Users\\u\\repo -> /mnt/c/...",
  );
  assertEqual(
    converter.windowsToLinux("\\\\wsl.localhost\\Ubuntu-22.04\\home\\u\\repo"),
    "/home/u/repo",
    "same-distro UNC -> /home/u/repo",
  );
  assertEqual(
    converter.windowsToLinux("\\\\wsl$\\Ubuntu-22.04\\home\\u\\repo"),
    "/home/u/repo",
    "legacy \\\\wsl$ UNC -> /home/u/repo",
  );
  assertEqual(converter.windowsToLinux("C:\\"), "/mnt/c", "C:\\ root -> /mnt/c");

  // cross-distro rejection
  assertThrows(
    () => converter.assertSameDistro("\\\\wsl.localhost\\Debian\\home\\u"),
    "assertSameDistro cross-distro UNC throws",
  );
  assertThrows(
    () => converter.windowsToLinux("\\\\wsl.localhost\\Debian\\home\\u"),
    "windowsToLinux cross-distro UNC throws",
  );
  // same-distro UNC and non-UNC paths pass assertSameDistro.
  {
    let threw = false;
    try {
      converter.assertSameDistro("\\\\wsl.localhost\\Ubuntu-22.04\\home\\u");
      converter.assertSameDistro("C:\\Users");
      converter.assertSameDistro("/home/u");
    } catch {
      threw = true;
    }
    assert(!threw, "assertSameDistro accepts same-distro UNC and non-UNC paths");
  }

  // displayPath
  assertEqual(
    converter.displayPath("\\\\wsl.localhost\\Ubuntu-22.04\\home\\u\\repo"),
    "/home/u/repo",
    "displayPath(UNC) -> logical",
  );
  assertEqual(
    converter.displayPath("C:\\Users\\u\\repo"),
    "/mnt/c/Users/u/repo",
    "displayPath(drive) -> logical",
  );
  assertEqual(
    converter.displayPath("/home/u/repo"),
    "/home/u/repo",
    "displayPath(logical) returned unchanged",
  );

  // assertLogicalPath rejects Windows/UNC input.
  assertThrows(() => converter.assertLogicalPath("C:\\Users"), "assertLogicalPath rejects drive path");
  assertThrows(() => converter.assertLogicalPath("C:/Users"), "assertLogicalPath rejects forward-slash drive path");
  assertThrows(
    () => converter.assertLogicalPath("\\\\wsl.localhost\\Ubuntu-22.04\\home"),
    "assertLogicalPath rejects UNC",
  );
  {
    let threw = false;
    try {
      converter.assertLogicalPath("/home/u");
      converter.assertLogicalPath("/mnt/c/Users");
    } catch {
      threw = true;
    }
    assert(!threw, "assertLogicalPath accepts POSIX paths");
  }

  console.log("\n=== WslPathConverter: automount disabled ===\n");

  const noAutomount = new WslPathConverter({ ...ctx, automountEnabled: false });
  assertThrows(
    () => noAutomount.linuxToWindows("/mnt/c/Users"),
    "automount disabled: /mnt drive access throws",
  );
  assertThrows(
    () => noAutomount.windowsToLinux("C:\\Users"),
    "automount disabled: drive reverse-mapping throws",
  );
  // ext4 paths still map to UNC when automount is disabled.
  assertEqual(
    noAutomount.linuxToWindows("/home/u/repo"),
    "\\\\wsl.localhost\\Ubuntu-22.04\\home\\u\\repo",
    "automount disabled: ext4 path still maps to UNC",
  );

  console.log("\n=== WslPathConverter: custom automount root ===\n");

  const customRoot = new WslPathConverter({ ...ctx, automountRoot: "/wsl-mount" });
  assertEqual(
    customRoot.linuxToWindows("/wsl-mount/c/Users"),
    "C:\\Users",
    "custom automount root /wsl-mount maps single-letter drive",
  );
  // /mnt is no longer the automount root; /mnt/c falls through to UNC.
  assertEqual(
    customRoot.linuxToWindows("/mnt/c/Users"),
    "\\\\wsl.localhost\\Ubuntu-22.04\\mnt\\c\\Users",
    "default /mnt no longer drive-special-cased under custom root",
  );
  assertEqual(
    customRoot.windowsToLinux("D:\\data"),
    "/wsl-mount/d/data",
    "custom root reverse-maps drive to /wsl-mount/<lower>",
  );

  console.log("\n=== WslPathConverter: round-trip stability ===\n");

  const roundTripCases = [
    "/home/u/repo",
    "/mnt/c/Users/u/repo",
    "/mnt/c",
    "/var/log/app.log",
    "/mnt/wsl/foo",
  ];
  for (const linux of roundTripCases) {
    const win = converter.linuxToWindows(linux);
    const back = converter.windowsToLinux(win);
    assertEqual(back, linux, `round-trip ${linux} -> ${win} -> ${back}`);
  }

  console.log("\n=== WslDistroResolver: list() diagnostic (no WSL host) ===\n");

  // A bogus executable guarantees ENOENT; list() must return [] (diagnostic)
  // instead of throwing an uncaught exception.
  {
    const resolver = new WslDistroResolver({
      executable: "pix-nonexistent-wsl-binary-test.exe",
      listTimeoutMs: 2000,
    });
    const distros = await resolver.list();
    assert(Array.isArray(distros), "list() returns an array when wsl.exe is missing");
    assertEqual(distros.length, 0, "list() returns [] (diagnostic) when wsl.exe is missing");
  }
  // requireDistro surfaces a not-found diagnostic instead of substituting the default.
  {
    const resolver = new WslDistroResolver({
      executable: "pix-nonexistent-wsl-binary-test.exe",
      listTimeoutMs: 2000,
    });
    await assertRejects(
      resolver.requireDistro("Ubuntu-22.04"),
      "requireDistro rejects when no distros are available",
    );
  }

  console.log("\n=== Real WSL distro tests ===\n");

  const distroEnv = process.env.PIX_WSL_TEST_DISTRO;
  if (distroEnv) {
    console.log(`  PIX_WSL_TEST_DISTRO=${distroEnv}\n`);
    const resolver = new WslDistroResolver({ listTimeoutMs: 15000, probeTimeoutMs: 30000 });
    const distros = await resolver.list();
    assert(distros.length > 0, "list() returns at least one distro on a WSL host");
    assert(distros.some((d) => d.name === distroEnv), `list() includes ${distroEnv}`);
    const info = await resolver.requireDistro(distroEnv);
    assertEqual(info.name, distroEnv, "requireDistro returns the verbatim name");
    assertEqual(info.version, 2, "requireDistro accepts only version 2");
    const home = await resolver.getHome(distroEnv);
    assert(home.startsWith("/"), `getHome returns a POSIX path (got ${home})`);
    assert(home.length > 1, "getHome returns a non-root path");
    const automount = await resolver.getAutomountConfig(distroEnv);
    assertEqual(automount.enabled, true, "getAutomountConfig reports enabled by default");
    assertEqual(automount.root, "/mnt", "getAutomountConfig root defaults to /mnt");
    await assertResolves(
      resolver.assertDirectory(distroEnv, "/"),
      `assertDirectory(${distroEnv}, "/") passes`,
    );
    await assertRejects(
      resolver.assertDirectory(distroEnv, "/nonexistent-pix-test-xyz-123"),
      `assertDirectory(${distroEnv}, nonexistent) rejects`,
    );
  } else {
    console.log("  SKIP: set PIX_WSL_TEST_DISTRO to a WSL2 distro name to enable real-WSL cases.");
  }
}

if (shouldRun("runtime")) {
  console.log("\n=== WSL Runtime Tests (S4) ===\n");

  // --------------------------------------------------------------------------
  // Fake child process + fake spawn/taskkill harness
  // --------------------------------------------------------------------------

  class FakeChild extends EventEmitter {
    readonly stdout: PassThrough;
    readonly stderr: PassThrough;
    readonly stdin: PassThrough;
    readonly pid: number;
    killed = false;

    constructor(pid: number) {
      super();
      this.pid = pid;
      this.stdout = new PassThrough();
      this.stderr = new PassThrough();
      this.stdin = new PassThrough();
    }

    kill(): boolean {
      this.killed = true;
      return true;
    }

    emitClose(code: number | null): void {
      this.stdout.end();
      this.stderr.end();
      this.emit("close", code, null);
    }
  }

  interface FakeSpawnCall {
    command: string;
    args: string[];
    stdio: unknown;
  }

  function createFakeHooks(opts?: {
    wrapperHangs?: boolean;
  }): {
    hooks: WslRuntimeHooks;
    calls: FakeSpawnCall[];
    controlFiles: Map<string, string>;
    taskkillCalls: number[];
    eventLog: string[];
    cleanupPromise: Promise<void>;
    wrapperChildPid: number | null;
  } {
    const calls: FakeSpawnCall[] = [];
    const controlFiles = new Map<string, string>();
    const taskkillCalls: number[] = [];
    const eventLog: string[] = [];
    const childrenByPid = new Map<number, FakeChild>();
    let pidCounter = 5000;
    let cleanupResolver: (() => void) | null = null;
    const cleanupPromise = new Promise<void>((resolve) => {
      cleanupResolver = resolve;
    });
    let wrapperChildPid: number | null = null;

    const fakeSpawn = (
      command: string,
      args: readonly string[],
      options: { stdio?: unknown },
    ): FakeChild => {
      calls.push({ command, args: [...args], stdio: options?.stdio });
      const child = new FakeChild(++pidCounter);
      childrenByPid.set(child.pid, child);

      const eIdx = args.indexOf("-e");
      const afterE = eIdx >= 0 ? args.slice(eIdx + 1) : [];

      // "true" (warmUp / keep-alive)
      if (afterE.length === 1 && afterE[0] === "true") {
        setTimeout(() => child.emitClose(0), 0);
        return child;
      }

      // "cat <path>" (read control file)
      if (afterE.length >= 2 && afterE[0] === "cat") {
        const path = afterE[1]!;
        const content = controlFiles.get(path);
        eventLog.push("readControlFile");
        setTimeout(() => {
          if (content) child.stdout.write(content);
          child.emitClose(0);
        }, 0);
        return child;
      }

      // "bash" "-c" <script> ...
      if (afterE.length >= 2 && afterE[0] === "bash" && afterE[1] === "-c") {
        const script = afterE[2] ?? "";
        const positional = afterE.slice(3);

        // Cleanup: kill + rm
        if (script.includes("kill -KILL") && script.includes("rm -f")) {
          const controlFile = positional[2];
          if (controlFile) controlFiles.delete(controlFile);
          eventLog.push("cleanup");
          setTimeout(() => {
            child.emitClose(0);
            if (cleanupResolver) cleanupResolver();
          }, 0);
          return child;
        }

        // warmUp sweep + setsid probe
        if (script.includes("mkdir -p") && script.includes("rm -f")) {
          controlFiles.clear();
          setTimeout(() => {
            child.stdout.write("setsid-ok\n");
            child.emitClose(0);
          }, 0);
          return child;
        }

        // setsid probe only
        if (script.includes("command -v setsid")) {
          setTimeout(() => {
            child.stdout.write("setsid-ok\n");
            child.emitClose(0);
          }, 0);
          return child;
        }

        // dispose sweep
        if (script.includes("rm -f") && script.includes(".pgid")) {
          controlFiles.clear();
          setTimeout(() => child.emitClose(0), 0);
          return child;
        }

        // spawnBash wrapper
        if (script.includes("CTRL=")) {
          const ctrlFile = positional[2];
          const timestamp = positional[3];
          if (ctrlFile) {
            const pgid = ++pidCounter;
            controlFiles.set(ctrlFile, `${pgid} ${timestamp ?? 0}`);
          }
          wrapperChildPid = child.pid;
          if (!opts?.wrapperHangs) {
            setTimeout(() => {
              child.stdout.write("command output\n");
              child.emitClose(0);
            }, 0);
          }
          // When wrapperHangs is true, the child stays open until taskkill
          // emits close(null) -- simulating a long-running command.
          return child;
        }
      }

      // Default
      setTimeout(() => child.emitClose(0), 0);
      return child;
    };

    const fakeTaskkill = (pid: number): void => {
      taskkillCalls.push(pid);
      eventLog.push("taskkill");
      const child = childrenByPid.get(pid);
      if (child) {
        setTimeout(() => child.emitClose(null), 0);
      }
    };

    const hooks = {
      spawnFn: fakeSpawn,
      taskkill: fakeTaskkill,
      hostPid: 4242,
      controlDir: "/tmp/pix-wsl",
      now: () => 1700000000000,
    } as unknown as WslRuntimeHooks;

    return {
      hooks,
      calls,
      controlFiles,
      taskkillCalls,
      eventLog,
      cleanupPromise,
      get wrapperChildPid(): number | null {
        return wrapperChildPid;
      },
    };
  }

  const BASE_OPTS = {
    distro: "Ubuntu-22.04",
    readyTimeoutMs: 5000,
    killTimeoutMs: 5000,
    keepAliveIntervalMs: 0,
  };

  // --------------------------------------------------------------------------
  // Test: argv order -d/--cd/-e/bash/-c + stdin ignore + command as $1
  // --------------------------------------------------------------------------

  {
    const fake = createFakeHooks();
    const runtime = createWslRuntime(BASE_OPTS, fake.hooks);
    const received: Buffer[] = [];
    await runtime.spawnBash("echo 'hello world'", "/home/user/project", {
      onData: (data: Buffer) => received.push(data),
    });
    await runtime.dispose();

    const wrapperCall = fake.calls.find((c) =>
      c.args.some((a) => typeof a === "string" && a.includes("CTRL=")),
    );
    assert(!!wrapperCall, "spawnBash produced a wrapper call containing CTRL=");
    const args = wrapperCall!.args;

    const dIdx = args.indexOf("-d");
    const cdIdx = args.indexOf("--cd");
    const eIdx = args.indexOf("-e");
    // The first "bash" after "-e" is the shell, not $0.
    const bashIdx = args.indexOf("bash", eIdx);
    const cIdx = args.indexOf("-c", bashIdx);

    assert(dIdx >= 0 && dIdx < cdIdx, "argv order: -d before --cd");
    assert(cdIdx >= 0 && cdIdx < eIdx, "argv order: --cd before -e");
    assert(eIdx >= 0 && eIdx < bashIdx, "argv order: -e before bash");
    assert(bashIdx >= 0 && bashIdx < cIdx, "argv order: bash before -c");

    assertEqual(args[dIdx + 1], "Ubuntu-22.04", "argv: -d <distro>");
    assertEqual(args[cdIdx + 1], "/home/user/project", "argv: --cd <logicalCwd>");
    assertEqual(args[eIdx + 1], "bash", "argv: -e bash");

    const wrapperScript = args[cIdx + 1]!;
    assert(wrapperScript.includes("CTRL="), "wrapper script contains CTRL=");
    assert(wrapperScript.includes("setsid"), "wrapper script uses setsid");

    // command is $1 (independent argv), NOT spliced into the wrapper.
    const commandArg = args[cIdx + 2 + 1]!; // skip "bash" ($0) after -c
    assertEqual(commandArg, "echo 'hello world'", "command passed as independent argv $1");
    assert(
      !wrapperScript.includes("echo 'hello world'"),
      "command not spliced into wrapper string",
    );

    // stdin is "ignore"
    const stdio = wrapperCall!.stdio as string[];
    assertEqual(stdio[0], "ignore", "stdio stdin is ignore");
    assertEqual(stdio[1], "pipe", "stdio stdout is pipe");
    assertEqual(stdio[2], "pipe", "stdio stderr is pipe");

    // onData received output
    const output = Buffer.concat(received).toString("utf8");
    assert(output.includes("command output"), "onData received command output");
  }

  // --------------------------------------------------------------------------
  // Test: control file writes pgid
  // --------------------------------------------------------------------------

  {
    const fake = createFakeHooks();
    const runtime = createWslRuntime(BASE_OPTS, fake.hooks);
    await runtime.spawnBash("ls -la", "/home/user", {
      onData: () => {},
    });

    assert(fake.controlFiles.size > 0, "control file was written by wrapper");
    const entry = [...fake.controlFiles.entries()][0]!;
    const ctrlPath = entry[0];
    const content = entry[1];
    assert(
      ctrlPath.startsWith("/tmp/pix-wsl/4242-"),
      `control file path format: ${ctrlPath}`,
    );
    assert(ctrlPath.endsWith(".pgid"), "control file has .pgid extension");
    const parts = content.split(/\s+/);
    const pgid = Number.parseInt(parts[0]!, 10);
    assert(Number.isFinite(pgid) && pgid > 0, `control file contains valid pgid: ${content}`);
    const timestamp = Number.parseInt(parts[1] ?? "", 10);
    assertEqual(timestamp, 1700000000000, "control file contains start timestamp");

    await runtime.dispose();
  }

  // --------------------------------------------------------------------------
  // Test: abort taskkills host child THEN killProcessGroup, control file
  // self-deletes
  // --------------------------------------------------------------------------

  {
    const fake = createFakeHooks({ wrapperHangs: true });
    const runtime = createWslRuntime(BASE_OPTS, fake.hooks);
    const controller = new AbortController();
    const resultPromise = runtime.spawnBash("sleep 100", "/home/user", {
      onData: () => {},
      signal: controller.signal,
    });

    // Let the wrapper spawn and write the control file.
    await new Promise((r) => setTimeout(r, 10));

    controller.abort();
    const result = await resultPromise;
    await fake.cleanupPromise;

    assertEqual(result.exitCode, null, "aborted spawnBash resolves with exitCode null");
    assert(fake.taskkillCalls.length > 0, "taskkill was called on host child");
    assert(
      fake.wrapperChildPid !== null && fake.taskkillCalls.includes(fake.wrapperChildPid),
      "taskkill called with host wrapper child pid",
    );

    // Order: taskkill before readControlFile before cleanup.
    const taskkillIdx = fake.eventLog.indexOf("taskkill");
    const readIdx = fake.eventLog.indexOf("readControlFile");
    const cleanupIdx = fake.eventLog.indexOf("cleanup");
    assert(taskkillIdx >= 0, "taskkill recorded in event log");
    assert(readIdx >= 0, "readControlFile recorded in event log");
    assert(cleanupIdx >= 0, "cleanup recorded in event log");
    assert(taskkillIdx < readIdx, "taskkill before killProcessGroup reads control file");
    assert(readIdx < cleanupIdx, "readControlFile before cleanup command");

    // Control file self-deleted.
    assertEqual(fake.controlFiles.size, 0, "control file self-deleted after cleanup");

    await runtime.dispose();
  }

  // --------------------------------------------------------------------------
  // Test: timeout (not abort) -> WslBashOperations.exec rejects with "timeout:"
  // Issue 1: when spawnBash times out without an abort, the adapter throws an
  // Error whose message starts with "timeout:" so the bash tool renders
  // "Command timed out" (matching createLocalBashOperations).
  // --------------------------------------------------------------------------

  {
    const fake = createFakeHooks({ wrapperHangs: true });
    const runtime = createWslRuntime(BASE_OPTS, fake.hooks);
    const bashOps = createWslBashOperations({ runtime, logicalCwd: "/home/user" });
    let timeoutErr: Error | null = null;
    try {
      await bashOps.exec("sleep 100", "/home/user", {
        onData: () => {},
        timeout: 1, // seconds -> 1000ms in spawnBash
      });
    } catch (e) {
      timeoutErr = e instanceof Error ? e : new Error(String(e));
    }
    assert(timeoutErr !== null, "exec rejects when spawnBash times out (not aborted)");
    assert(
      timeoutErr !== null && timeoutErr.message.startsWith("timeout:"),
      `exec rejection message starts with 'timeout:' (got: ${timeoutErr?.message})`,
    );
    assertEqual(timeoutErr?.message ?? "", "timeout:1", "exec timeout message is 'timeout:<seconds>'");
    // Timeout uses the same taskkill-then-kill-pgid order as abort.
    assert(fake.taskkillCalls.length > 0, "timeout taskkilled the host child");
    // Let the async killProcessGroup cleanup finish before dispose.
    await fake.cleanupPromise;
    await runtime.dispose();
  }

  // --------------------------------------------------------------------------
  // Test: warmUp sweeps leftovers + setsid probe
  // --------------------------------------------------------------------------

  {
    const fake = createFakeHooks();
    // Pre-populate leftover control files from a previous session.
    fake.controlFiles.set("/tmp/pix-wsl/1111-0.pgid", "999 0");
    fake.controlFiles.set("/tmp/pix-wsl/1111-1.pgid", "998 0");
    assertEqual(fake.controlFiles.size, 2, "pre-populated 2 leftover control files");

    const runtime = createWslRuntime(BASE_OPTS, fake.hooks);
    await runtime.warmUp();

    // warmUp sweeps leftovers.
    assertEqual(fake.controlFiles.size, 0, "warmUp swept leftover control files");

    // warmUp ran `true` (explicit-distro check).
    const trueCall = fake.calls.find(
      (c) => c.args.indexOf("true") === c.args.length - 1 && c.args.includes("-e"),
    );
    assert(!!trueCall, "warmUp ran wsl.exe -d distro -e true");
    assertEqual(trueCall!.args[1], "Ubuntu-22.04", "warmUp true uses explicit distro");

    await runtime.dispose();
  }

  // --------------------------------------------------------------------------
  // Test: env overlay validation
  // --------------------------------------------------------------------------

  {
    const fake = createFakeHooks();
    const runtime = createWslRuntime(BASE_OPTS, fake.hooks);

    assertThrows(
      () => runtime.spawn(["true"], { env: { PATH: "/usr/bin" } }),
      "env overlay rejects PATH key",
    );
    assertThrows(
      () => runtime.spawn(["true"], { env: { HOME: "/home/user" } }),
      "env overlay rejects HOME key",
    );
    assertThrows(
      () => runtime.spawn(["true"], { env: { USERPROFILE: "C:\\Users" } }),
      "env overlay rejects USERPROFILE key",
    );
    assertThrows(
      () => runtime.spawn(["true"], { env: { FOO: "C:\\Windows" } }),
      "env overlay rejects drive path in value",
    );
    assertThrows(
      () => runtime.spawn(["true"], { env: { FOO: "\\\\wsl.localhost\\Ubuntu\\home" } }),
      "env overlay rejects UNC path in value",
    );

    // Valid env overlay: env KEY=VALUE prefix is inserted after -e.
    const fake2 = createFakeHooks();
    const runtime2 = createWslRuntime(BASE_OPTS, fake2.hooks);
    runtime2.spawn(["true"], { env: { MY_VAR: "hello" } });
    await runtime2.dispose();
    const call = fake2.calls[0]!;
    const eIdx = call.args.indexOf("-e");
    assertEqual(call.args[eIdx + 1], "env", "valid env overlay inserts env command after -e");
    assertEqual(call.args[eIdx + 2], "MY_VAR=hello", "valid env overlay includes KEY=VALUE pair");

    await runtime.dispose();
  }

  // --------------------------------------------------------------------------
  // Test: run() returns exitCode/stdout/stderr
  // --------------------------------------------------------------------------

  {
    const fake = createFakeHooks();
    const runtime = createWslRuntime(BASE_OPTS, fake.hooks);
    const result = await runtime.run(["echo", "test"], { timeoutMs: 5000 });
    assertEqual(result.exitCode, 0, "run returns exit code 0");
    assert(Buffer.isBuffer(result.stdout), "run returns stdout as Buffer");
    assert(Buffer.isBuffer(result.stderr), "run returns stderr as Buffer");
    // Verify argv structure: -d distro -e echo test
    const call = fake.calls[0]!;
    assertEqual(call.args[0], "-d", "run argv starts with -d");
    assertEqual(call.args[1], "Ubuntu-22.04", "run argv has distro");
    assertEqual(call.args[2], "-e", "run argv has -e (no --cd when logicalCwd omitted)");
    assertEqual(call.args[3], "echo", "run argv has echo after -e");
    await runtime.dispose();
  }

  // --------------------------------------------------------------------------
  // Test: real WSL distro (PIX_WSL_TEST_DISTRO)
  // --------------------------------------------------------------------------

  {
    const distroEnv = process.env.PIX_WSL_TEST_DISTRO;
    if (distroEnv) {
      console.log(`  PIX_WSL_TEST_DISTRO=${distroEnv}\n`);
      const runtime = createWslRuntime({
        distro: distroEnv,
        readyTimeoutMs: 30_000,
        killTimeoutMs: 5_000,
        keepAliveIntervalMs: 0,
      });
      try {
        await runtime.warmUp();
        // warmUp runs wsl.exe -d distro -e true; if it succeeds, the distro
        // is accessible and setsid was probed.
        assert(true, `warmUp succeeded for distro ${distroEnv}`);

        // Verify a simple bash command works.
        const result = await runtime.run(["echo", "pix-wsl-test"], {
          timeoutMs: 10_000,
        });
        assertEqual(result.exitCode, 0, `real WSL echo exit code 0`);
        const out = result.stdout.toString("utf8").trim();
        assertEqual(out, "pix-wsl-test", `real WSL echo output matches`);
      } finally {
        await runtime.dispose();
      }
    } else {
      console.log("  SKIP: set PIX_WSL_TEST_DISTRO to a WSL2 distro to enable real-WSL cases.");
    }
  }
}

if (shouldRun("operations")) {
  console.log("\n=== WSL Operations Tests (S5) ===\n");

  // --------------------------------------------------------------------------
  // Fake child + fake runtime for find/grep (file ops use real fs via /mnt/c)
  // --------------------------------------------------------------------------

  class OpsFakeChild extends EventEmitter {
    readonly stdout: PassThrough;
    readonly stderr: PassThrough;
    readonly stdin: PassThrough;
    readonly pid: number;
    killed = false;

    constructor(pid: number) {
      super();
      this.pid = pid;
      this.stdout = new PassThrough();
      this.stderr = new PassThrough();
      this.stdin = new PassThrough();
    }

    kill(): boolean {
      this.killed = true;
      return true;
    }
  }

  interface FakeRuntimeConfig {
    rgAvailable: boolean;
    rgStdout: string;
    fdOutput: string[];
  }

  interface FakeRunCall {
    argv: string[];
  }

  class OpsFakeRuntime implements WslRuntime {
    readonly runCalls: FakeRunCall[] = [];
    readonly spawnCalls: FakeRunCall[] = [];
    readonly killGroupCalls: string[] = [];
    lastSpawnedChild: OpsFakeChild | null = null;
    private readonly _cfg: FakeRuntimeConfig;
    private _pidCounter = 7000;

    constructor(cfg: FakeRuntimeConfig) {
      this._cfg = cfg;
    }

    spawn(argv: readonly string[]): ChildProcessWithoutNullStreams {
      this.spawnCalls.push({ argv: [...argv] });
      const child = new OpsFakeChild(++this._pidCounter);
      this.lastSpawnedChild = child;
      const isRgWrapper = argv.some(
        (a) => typeof a === "string" && a.includes("setsid rg"),
      );
      if (isRgWrapper) {
        const aptHint = argv.find(
          (a) => typeof a === "string" && a.includes("apt install ripgrep"),
        );
        if (!this._cfg.rgAvailable) {
          setTimeout(() => {
            if (aptHint) child.stderr.write(aptHint + "\n");
            child.emit("close", 127, null);
          }, 0);
        } else if (this._cfg.rgStdout) {
          setTimeout(() => {
            child.stdout.write(this._cfg.rgStdout);
            child.emit("close", 0, null);
          }, 0);
        }
        // When rgStdout is empty, leave the child open so the early-kill test
        // can drive the close event itself.
      }
      return child as unknown as ChildProcessWithoutNullStreams;
    }

    async run(argv: readonly string[]): Promise<WslCommandResult> {
      this.runCalls.push({ argv: [...argv] });
      const empty: WslCommandResult = { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      const head = argv[0];
      if (head === "mkdir") return empty;
      if (head === "realpath") {
        return { exitCode: 0, stdout: Buffer.from(argv[1] ?? ""), stderr: Buffer.alloc(0) };
      }
      if (head === "cat") {
        return { exitCode: 0, stdout: Buffer.from("canned-context-line\n"), stderr: Buffer.alloc(0) };
      }
      if (head === "fd" || head === "fdfind") {
        return { exitCode: 0, stdout: Buffer.from(this._cfg.fdOutput.join("\n") + "\n"), stderr: Buffer.alloc(0) };
      }
      if (head === "bash" && argv[1] === "-c") {
        const script = argv[2] ?? "";
        if (script.includes("command -v")) {
          const bin = argv[4];
          return { exitCode: 0, stdout: Buffer.from(bin ?? "fd"), stderr: Buffer.alloc(0) };
        }
        if (script.includes("test -d")) {
          return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
        }
      }
      return empty;
    }

    async spawnBash(): Promise<{ exitCode: number | null }> {
      return { exitCode: 0 };
    }

    isSetsidAvailable(): boolean {
      return true;
    }

    async killProcessGroup(controlFile: string): Promise<void> {
      this.killGroupCalls.push(controlFile);
    }

    async warmUp(): Promise<void> {}

    async dispose(): Promise<void> {}
  }

  // --------------------------------------------------------------------------
  // Real temp dir on the Windows drive, mapped to /mnt/<drive>/...
  // --------------------------------------------------------------------------

  const fsConverter = new WslPathConverter({
    distro: "Ubuntu-22.04",
    home: "/home/u",
    automountRoot: "/mnt",
    automountEnabled: true,
  });
  const tmpPhysical = fs.mkdtempSync(nodePath.join(os.tmpdir(), "pix-wsl-ops-"));
  const tmpLogical = fsConverter.windowsToLinux(tmpPhysical);

  const fakeRuntime = new OpsFakeRuntime({
    rgAvailable: true,
    rgStdout: "",
    fdOutput: [`${tmpLogical}/file1.ts`, `${tmpLogical}/file2.ts`],
  });

  const backend = await createWslExecutionBackend(
    {
      distro: "Ubuntu-22.04",
      logicalCwd: tmpLogical,
      physicalCwd: tmpPhysical,
      home: "/home/u",
      automount: { enabled: true, root: "/mnt" },
    },
    { runtime: fakeRuntime },
  );

  // --------------------------------------------------------------------------
  // read contract
  // --------------------------------------------------------------------------

  {
    const readLogical = `${tmpLogical}/read.txt`;
    const readPhysical = fsConverter.linuxToWindows(readLogical);
    fs.writeFileSync(readPhysical, "hello read");

    const buf = await backend.read!.readFile(readLogical);
    assertEqual(buf.toString("utf8"), "hello read", "read.readFile returns file content via physical path");

    await assertResolves(backend.read!.access(readLogical), "read.access resolves for existing file");

    await assertRejects(
      backend.read!.readFile(`${tmpLogical}/missing.txt`),
      "read.readFile rejects for missing file",
    );
    let leaked = false;
    try {
      await backend.read!.readFile(`${tmpLogical}/missing.txt`);
    } catch (e) {
      const msg = e instanceof Error ? `${e.message} ${(e as { path?: string }).path ?? ""}` : String(e);
      if (/\\\\wsl|wsl\.localhost|wsl\$|[A-Za-z]:[\\/]/.test(msg)) leaked = true;
    }
    assert(!leaked, "read error message has no UNC/drive");
  }

  // --------------------------------------------------------------------------
  // write contract
  // --------------------------------------------------------------------------

  {
    const writeLogical = `${tmpLogical}/written.txt`;
    await backend.write!.writeFile(writeLogical, "written content");
    const onDisk = fs.readFileSync(fsConverter.linuxToWindows(writeLogical), "utf8");
    assertEqual(onDisk, "written content", "write.writeFile writes content to the physical file");

    const reread = await backend.write!.readFile!(writeLogical);
    assertEqual(reread.toString("utf8"), "written content", "write.readFile reads back the content");

    const mkdirLogical = `${tmpLogical}/newdir`;
    await backend.write!.mkdir(mkdirLogical);
    const mkdirCall = fakeRuntime.runCalls.find((c) => c.argv[0] === "mkdir");
    assert(!!mkdirCall, "write.mkdir issued a wsl.exe mkdir command");
    assertEqual(mkdirCall!.argv[1], "-p", "write.mkdir uses mkdir -p");
    assertEqual(mkdirCall!.argv[2], "--", "write.mkdir separates args with --");
    assertEqual(mkdirCall!.argv[3], mkdirLogical, "write.mkdir targets the logical dir");
  }

  // --------------------------------------------------------------------------
  // edit contract
  // --------------------------------------------------------------------------

  {
    const editLogical = `${tmpLogical}/edit.txt`;
    fs.writeFileSync(fsConverter.linuxToWindows(editLogical), "original");
    await assertResolves(backend.edit!.access(editLogical), "edit.access resolves for existing file");
    const buf = await backend.edit!.readFile(editLogical);
    assertEqual(buf.toString("utf8"), "original", "edit.readFile returns content");
    await backend.edit!.writeFile(editLogical, "edited");
    assertEqual(
      fs.readFileSync(fsConverter.linuxToWindows(editLogical), "utf8"),
      "edited",
      "edit.writeFile persists changes",
    );
    await assertRejects(
      backend.edit!.access(`${tmpLogical}/nope.txt`),
      "edit.access rejects for missing file",
    );
  }

  // --------------------------------------------------------------------------
  // ls contract
  // --------------------------------------------------------------------------

  {
    const lsLogical = `${tmpLogical}/lsdir`;
    fs.mkdirSync(fsConverter.linuxToWindows(lsLogical));
    fs.writeFileSync(fsConverter.linuxToWindows(`${lsLogical}/a.txt`), "a");
    fs.mkdirSync(fsConverter.linuxToWindows(`${lsLogical}/sub`));

    assert(await backend.ls!.exists(lsLogical), "ls.exists returns true for a directory");
    assert(!await backend.ls!.exists(`${lsLogical}/missing`), "ls.exists returns false for missing path");
    const st = await backend.ls!.stat(lsLogical);
    assert(st.isDirectory(), "ls.stat reports a directory");
    const names = await backend.ls!.readdir(lsLogical);
    assert(names.includes("a.txt") && names.includes("sub"), "ls.readdir lists entries");
    const typed = await backend.ls!.readdirWithTypes!(lsLogical);
    const aEntry = typed.find((e) => e.name === "a.txt");
    const subEntry = typed.find((e) => e.name === "sub");
    assert(!!aEntry && !aEntry.isDirectory, "ls.readdirWithTypes marks file as non-directory");
    assert(!!subEntry && subEntry.isDirectory, "ls.readdirWithTypes marks directory as directory");

    // broken symlink is listable, does not fail the whole directory
    fs.symlinkSync(`${tmpLogical}/nowhere`, fsConverter.linuxToWindows(`${lsLogical}/broken`));
    const typed2 = await backend.ls!.readdirWithTypes!(lsLogical);
    const broken = typed2.find((e) => e.name === "broken");
    assert(!!broken && !broken.isDirectory, "ls.readdirWithTypes lists broken symlink as non-directory");
  }

  // --------------------------------------------------------------------------
  // find contract
  // --------------------------------------------------------------------------

  {
    assert(await backend.find!.exists(tmpLogical), "find.exists returns true for the project dir");
    const results = await backend.find!.glob("*.ts", tmpLogical, {
      ignore: ["**/node_modules/**", "**/.git/**"],
      limit: 100,
    });
    assert(results.length === 2, "find.glob returns fd results");
    assert(
      results.every((p) => p.startsWith("/mnt/") && nodePath.posix.isAbsolute(p)),
      "find.glob returns absolute Linux paths",
    );
    const fdCall = fakeRuntime.runCalls.find((c) => c.argv[0] === "fd" || c.argv[0] === "fdfind");
    assert(!!fdCall, "find.glob ran fd inside WSL");
    assert(fdCall!.argv.includes("--glob"), "find.glob passed --glob to fd");
    assert(fdCall!.argv.includes(tmpLogical), "find.glob passed the logical cwd to fd");

    // missing fd surfaces an apt hint
    const noFdRuntime = new OpsFakeRuntime({ rgAvailable: true, rgStdout: "", fdOutput: [] });
    // Force resolveFdBinary to miss by making command -v return nothing.
    noFdRuntime.run = async (argv: readonly string[]): Promise<WslCommandResult> => {
      noFdRuntime.runCalls.push({ argv: [...argv] });
      if (argv[0] === "bash" && (argv[2] ?? "").includes("command -v")) {
        return { exitCode: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      }
      return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    };
    const noFdOps = createWslFileOperations({
      converter: fsConverter,
      runtime: noFdRuntime,
      logicalCwd: tmpLogical,
      physicalCwd: tmpPhysical,
    });
    let fdErr: Error | null = null;
    try {
      await noFdOps.find.glob("*.ts", tmpLogical, { ignore: [], limit: 10 });
    } catch (e) {
      fdErr = e instanceof Error ? e : new Error(String(e));
    }
    assert(!!fdErr, "find.glob rejects when fd is missing");
    assert(
      fdErr!.message.includes("Ubuntu-22.04") && fdErr!.message.includes("apt install fd-find"),
      "missing-fd error contains distro name and apt hint",
    );
  }

  // --------------------------------------------------------------------------
  // grep contract: isDirectory / readFile / spawnRipgrep missing-rg / early-kill
  // --------------------------------------------------------------------------

  {
    assert(await backend.grep!.isDirectory(tmpLogical), "grep.isDirectory returns true for a directory");

    const catContent = await backend.grep!.readFile(`${tmpLogical}/anything`);
    assertEqual(catContent, "canned-context-line\n", "grep.readFile uses wsl.exe -e cat for context");

    // missing-rg surfaces an apt hint via stderr + exit 127
    const noRgRuntime = new OpsFakeRuntime({ rgAvailable: false, rgStdout: "", fdOutput: [] });
    const noRgOps = createWslFileOperations({
      converter: fsConverter,
      runtime: noRgRuntime,
      logicalCwd: tmpLogical,
      physicalCwd: tmpPhysical,
    });
    const rgChild = noRgOps.grep.spawnRipgrep!(
      ["--json", "pat", tmpLogical],
      tmpLogical,
      process.env,
    );
    const stderrChunks: Buffer[] = [];
    let closeCode: number | null = null;
    rgChild.stderr.on("data", (c: Buffer) => stderrChunks.push(c));
    rgChild.on("close", (code: number | null) => {
      closeCode = code;
    });
    await new Promise((r) => setTimeout(r, 20));
    const stderrText = Buffer.concat(stderrChunks).toString("utf8");
    assertEqual(closeCode, 127, "missing-rg child exits 127");
    assert(stderrText.includes("Ubuntu-22.04"), "missing-rg error contains distro name");
    assert(stderrText.includes("apt install ripgrep"), "missing-rg error contains apt install hint");

    // early-kill: child close triggers killProcessGroup on the rg control file
    const earlyKillRuntime = new OpsFakeRuntime({ rgAvailable: true, rgStdout: "", fdOutput: [] });
    const earlyKillOps = createWslFileOperations({
      converter: fsConverter,
      runtime: earlyKillRuntime,
      logicalCwd: tmpLogical,
      physicalCwd: tmpPhysical,
    });
    const spawned = earlyKillOps.grep.spawnRipgrep!(
      ["--json", "pat", tmpLogical],
      tmpLogical,
      process.env,
    );
    // Simulate the grep tool's matchCount>=limit early-kill: kill + close.
    spawned.kill();
    spawned.emit("close", null, null);
    await new Promise((r) => setTimeout(r, 20));
    assert(earlyKillRuntime.killGroupCalls.length > 0, "grep early-kill calls killProcessGroup");
    assert(
      earlyKillRuntime.killGroupCalls[0]!.startsWith("/tmp/pix-wsl/rg-"),
      "killProcessGroup called with the rg control file path",
    );
  }

  // --------------------------------------------------------------------------
  // Issue 9: spawnWslRipgrep degrades when setsid is unavailable. The wrapper
  // uses 'rg "$@" &' (no new session) instead of 'setsid rg "$@" &' so the
  // command still executes; killProcessGroup already tries both -<pgid> and
  // <pid>, so the degraded path is still cleaned up (§4.6).
  // --------------------------------------------------------------------------

  {
    const noSetsidSpawnCalls: Array<{ argv: string[] }> = [];
    class NoSetsidRuntime implements WslRuntime {
      spawn(argv: readonly string[]): ChildProcessWithoutNullStreams {
        noSetsidSpawnCalls.push({ argv: [...argv] });
        const child = new OpsFakeChild(8100);
        setTimeout(() => child.emit("close", 0, null), 0);
        return child as unknown as ChildProcessWithoutNullStreams;
      }
      async run(): Promise<WslCommandResult> {
        return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      }
      async spawnBash(): Promise<{ exitCode: number | null }> {
        return { exitCode: 0 };
      }
      isSetsidAvailable(): boolean {
        return false;
      }
      async killProcessGroup(): Promise<void> {}
      async warmUp(): Promise<void> {}
      async dispose(): Promise<void> {}
    }

    const noSetsidOps = createWslFileOperations({
      converter: fsConverter,
      runtime: new NoSetsidRuntime(),
      logicalCwd: tmpLogical,
      physicalCwd: tmpPhysical,
    });
    noSetsidOps.grep.spawnRipgrep!(["--json", "pat", tmpLogical], tmpLogical, process.env);
    await new Promise((r) => setTimeout(r, 10));

    assert(noSetsidSpawnCalls.length > 0, "spawnWslRipgrep spawned a child even without setsid");
    const spawnArgv = noSetsidSpawnCalls[0]!.argv;
    const cIdx = spawnArgv.indexOf("-c");
    const wrapperScript = cIdx >= 0 ? (spawnArgv[cIdx + 1] ?? "") : "";
    assert(
      wrapperScript.includes('rg "$@" &'),
      "degraded wrapper runs rg directly (rg \"$@\" &)",
    );
    assert(
      !wrapperScript.includes("setsid"),
      "degraded wrapper does not reference setsid when unavailable",
    );
  }

  // --------------------------------------------------------------------------
  // backend.paths synthesis per §4.7
  // --------------------------------------------------------------------------

  {
    const paths = backend.paths;
    assertEqual(paths.pathStyle, "posix", "paths.pathStyle is posix");
    assertEqual(paths.homeDir, "/home/u", "paths.homeDir is the WSL home");

    assertEqual(
      paths.resolvePath("foo", "/home/u"),
      "/home/u/foo",
      "resolvePath resolves a relative input against cwd",
    );
    assertEqual(
      paths.resolvePath("~/bar", "/mnt/c"),
      "/home/u/bar",
      "resolvePath expands ~ to home",
    );
    assertEqual(
      paths.resolvePath("/abs/path", "/mnt/c"),
      "/abs/path",
      "resolvePath keeps absolute input unchanged",
    );

    assertEqual(
      paths.displayPath!(tmpPhysical),
      tmpLogical,
      "displayPath converts a physical path to logical",
    );
    assertEqual(
      paths.displayPath!(tmpLogical),
      tmpLogical,
      "displayPath returns a logical path unchanged",
    );

    const fileUrl = paths.toFileUrl!("/home/u/repo");
    assert(fileUrl.startsWith("file:"), "toFileUrl returns a file URL");
    assert(fileUrl.includes("wsl.localhost"), "toFileUrl targets the WSL UNC host");

    const mutationKey = await paths.getMutationKey!("/home/u/repo");
    assertEqual(mutationKey, "/home/u/repo", "getMutationKey uses wsl.exe -e realpath");
    const realpathCall = fakeRuntime.runCalls.find((c) => c.argv[0] === "realpath");
    assert(!!realpathCall, "getMutationKey ran wsl.exe -e realpath");
    assertEqual(realpathCall!.argv[1], "/home/u/repo", "getMutationKey passes the logical path to realpath");
  }

  // --------------------------------------------------------------------------
  // toLogicalError strategy
  // --------------------------------------------------------------------------

  {
    const uncMsg = `ENOENT: no such file or directory, open '\\\\wsl.localhost\\Ubuntu-22.04\\home\\u\\missing.txt'`;
    const err1 = new Error(uncMsg);
    (err1 as { path?: string }).path = "\\\\wsl.localhost\\Ubuntu-22.04\\home\\u\\missing.txt";
    (err1 as { code?: string }).code = "ENOENT";
    const translated1 = toLogicalError(err1, fsConverter);
    assert(!translated1.message.includes("wsl.localhost"), "toLogicalError strips UNC from message");
    assert(translated1.message.includes("/home/u/missing.txt"), "toLogicalError rewrites UNC to logical in message");
    assertEqual(
      (translated1 as { path?: string }).path,
      "/home/u/missing.txt",
      "toLogicalError rewrites error.path to logical",
    );
    assertEqual((translated1 as { code?: string }).code, "ENOENT", "toLogicalError preserves error.code");

    const driveErr = new Error(`ENOENT: open 'C:\\Users\\u\\missing.txt'`);
    const translated2 = toLogicalError(driveErr, fsConverter);
    assert(!/[A-Za-z]:[\\/]/.test(translated2.message), "toLogicalError strips drive letters from message");
    assert(translated2.message.includes("/mnt/c/Users/u/missing.txt"), "toLogicalError rewrites drive to /mnt/c");

    const legacyErr = new Error(`open '\\\\wsl$\\Ubuntu-22.04\\home\\u\\x'`);
    const translated3 = toLogicalError(legacyErr, fsConverter);
    assert(!translated3.message.includes("wsl$"), "toLogicalError strips legacy \\\\wsl$ UNC from message");

    // Recursive cause chain
    const causeErr = new Error(`cause 'C:\\data\\x'`);
    const parentErr = new Error(`parent '\\\\wsl.localhost\\Ubuntu-22.04\\home\\u\\y'`, { cause: causeErr });
    const translated4 = toLogicalError(parentErr, fsConverter);
    const tCause = (translated4 as { cause?: Error }).cause;
    assert(!!tCause, "toLogicalError preserves the cause");
    assert(!tCause!.message.includes("C:\\data"), "toLogicalError rewrites cause.message recursively");

    // Non-Error input
    const translated5 = toLogicalError("string C:\\foo", fsConverter);
    assert(translated5 instanceof Error, "toLogicalError wraps a non-Error in an Error");
    assert(!translated5.message.includes("C:\\"), "toLogicalError rewrites a non-Error string message");

    // Issue 10: URLs (http://, https://) are not corrupted. The drive-fragment
    // regex matches only a backslash after the colon (C:\...), so the forward
    // slash in a URL scheme is left intact even with automount enabled.
    const urlErr = new Error(
      "Failed to fetch http://example.com/api and https://example.org/path?q=1",
    );
    const translatedUrl = toLogicalError(urlErr, fsConverter);
    assertEqual(
      translatedUrl.message,
      "Failed to fetch http://example.com/api and https://example.org/path?q=1",
      "toLogicalError does not corrupt http(s) URLs (automount enabled)",
    );
    assert(translatedUrl.message.includes("http://example.com"), "http URL preserved verbatim");
    assert(translatedUrl.message.includes("https://example.org"), "https URL preserved verbatim");
  }

  // cleanup fake-backed test temp dir
  try {
    fs.rmSync(tmpPhysical, { recursive: true, force: true });
  } catch {
    // best-effort
  }
  await backend.dispose?.();

  // --------------------------------------------------------------------------
  // Real WSL distro (PIX_WSL_TEST_DISTRO)
  // --------------------------------------------------------------------------

  {
    const distroEnv = process.env.PIX_WSL_TEST_DISTRO;
    if (distroEnv) {
      console.log(`  PIX_WSL_TEST_DISTRO=${distroEnv}\n`);
      const realConverter = new WslPathConverter({
        distro: distroEnv,
        home: "/root",
        automountRoot: "/mnt",
        automountEnabled: true,
      });
      const realTmpPhysical = fs.mkdtempSync(nodePath.join(os.tmpdir(), "pix-wsl-real-"));
      const realTmpLogical = realConverter.windowsToLinux(realTmpPhysical);
      const filePath = `${realTmpLogical}/hello.txt`;
      fs.writeFileSync(realConverter.linuxToWindows(filePath), "hello wsl");

      const realBackend = await createWslExecutionBackend({
        distro: distroEnv,
        logicalCwd: realTmpLogical,
        physicalCwd: realTmpPhysical,
        home: "/root",
        automount: { enabled: true, root: "/mnt" },
        runtimeOptions: {
          readyTimeoutMs: 30_000,
          killTimeoutMs: 5_000,
          keepAliveIntervalMs: 0,
        },
      });
      try {
        const content = await realBackend.read!.readFile(filePath);
        assertEqual(content.toString("utf8"), "hello wsl", "real WSL /mnt/c existing read succeeds");

        let errText = "";
        try {
          await realBackend.read!.readFile(`${filePath}.nonexistent`);
        } catch (e) {
          errText = e instanceof Error ? `${e.message} ${(e as { path?: string }).path ?? ""}` : String(e);
        }
        assert(errText.length > 0, "real WSL missing-file read rejects with an error");
        assert(
          !/\\\\wsl|wsl\.localhost|wsl\$|[A-Za-z]:[\\/]/.test(errText),
          "real WSL error text has no UNC/drive",
        );

        // runtimeEnvironment override shape
        const env = realBackend.runtimeEnvironment!;
        assertEqual(env.platform, "linux", "real backend runtimeEnvironment.platform is linux");
        assert(!!env.shell && env.shell.kind === "wsl", "real backend shell.kind is wsl");
        assertEqual(env.shell!.path, "wsl.exe", "real backend shell.path is wsl.exe");
        assert(env.osName?.includes(distroEnv) ?? false, "real backend osName includes the distro");
      } finally {
        await realBackend.dispose?.();
        try {
          fs.rmSync(realTmpPhysical, { recursive: true, force: true });
        } catch {
          // best-effort
        }
      }
    } else {
      console.log("  SKIP: set PIX_WSL_TEST_DISTRO to a WSL2 distro to enable real-WSL operations cases.");
    }
  }
}

if (shouldRun("regression")) {
  console.log("\n=== WSL Cross-Cutting Regression Tests (S10) ===\n");

  // A fake runtime that records spawnBash/spawn/run calls and simulates `cat`
  // by reading the physical file through the converter. This lets the /mnt/c
  // round-trip test prove bash and the read operation resolve to the same
  // Windows file without a real WSL VM.
  class RegressionFakeChild extends EventEmitter {
    readonly stdout: PassThrough;
    readonly stderr: PassThrough;
    readonly stdin: PassThrough;
    readonly pid: number;
    killed = false;

    constructor(pid: number) {
      super();
      this.pid = pid;
      this.stdout = new PassThrough();
      this.stderr = new PassThrough();
      this.stdin = new PassThrough();
    }

    kill(): boolean {
      this.killed = true;
      return true;
    }
  }

  class RegressionFakeRuntime implements WslRuntime {
    readonly spawnBashCalls: Array<{ command: string; cwd: string }> = [];
    readonly spawnCalls: Array<{ argv: string[]; logicalCwd?: string }> = [];
    readonly runCalls: Array<{ argv: string[] }> = [];
    readonly killGroupCalls: string[] = [];
    private readonly _converter: WslPathConverter;
    private _pid = 9000;

    constructor(converter: WslPathConverter) {
      this._converter = converter;
    }

    spawn(
      argv: readonly string[],
      options?: { logicalCwd?: string; env?: NodeJS.ProcessEnv },
    ): ChildProcessWithoutNullStreams {
      this.spawnCalls.push({ argv: [...argv], logicalCwd: options?.logicalCwd });
      const child = new RegressionFakeChild(++this._pid);
      setTimeout(() => child.emit("close", 0, null), 0);
      return child as unknown as ChildProcessWithoutNullStreams;
    }

    async run(argv: readonly string[]): Promise<WslCommandResult> {
      this.runCalls.push({ argv: [...argv] });
      if (argv[0] === "realpath") {
        return { exitCode: 0, stdout: Buffer.from(argv[1] ?? ""), stderr: Buffer.alloc(0) };
      }
      if (argv[0] === "cat") {
        const logical = argv[1] ?? "";
        try {
          const physical = this._converter.linuxToWindows(logical);
          return { exitCode: 0, stdout: fs.readFileSync(physical), stderr: Buffer.alloc(0) };
        } catch {
          return { exitCode: 1, stdout: Buffer.alloc(0), stderr: Buffer.from("No such file") };
        }
      }
      if (argv[0] === "mkdir") {
        return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      }
      if (argv[0] === "fd" || argv[0] === "fdfind") {
        return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      }
      if (argv[0] === "bash" && argv[1] === "-c") {
        const script = argv[2] ?? "";
        if (script.includes("command -v")) {
          const bin = argv[4];
          return { exitCode: 0, stdout: Buffer.from(bin ?? "fd"), stderr: Buffer.alloc(0) };
        }
      }
      return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    }

    async spawnBash(
      command: string,
      logicalCwd: string,
      options: {
        onData: (data: Buffer) => void;
        signal?: AbortSignal;
        timeout?: number;
        env?: NodeJS.ProcessEnv;
      },
    ): Promise<{ exitCode: number | null }> {
      this.spawnBashCalls.push({ command, cwd: logicalCwd });
      // Simulate `cat <path>` by reading the physical file via the converter,
      // proving /mnt/c resolves to the same Windows file as the read operation.
      const match = /^cat (.+)$/.exec(command.trim());
      if (match) {
        const logical = match[1]!.replace(/^["']|["']$/g, "");
        try {
          const physical = this._converter.linuxToWindows(logical);
          options.onData(fs.readFileSync(physical));
        } catch {
          // missing file: emit nothing
        }
      }
      return { exitCode: 0 };
    }

    async killProcessGroup(_controlFile: string): Promise<void> {}
    isSetsidAvailable(): boolean {
      return true;
    }
    async warmUp(): Promise<void> {}
    async dispose(): Promise<void> {}
  }

  const regConverter = new WslPathConverter({
    distro: "Ubuntu-22.04",
    home: "/home/u",
    automountRoot: "/mnt",
    automountEnabled: true,
  });

  const regTmpPhysical = fs.mkdtempSync(nodePath.join(os.tmpdir(), "pix-wsl-reg-"));
  const regTmpLogical = regConverter.windowsToLinux(regTmpPhysical);
  const regRuntime = new RegressionFakeRuntime(regConverter);
  const regBackend = await createWslExecutionBackend(
    {
      distro: "Ubuntu-22.04",
      logicalCwd: regTmpLogical,
      physicalCwd: regTmpPhysical,
      home: "/home/u",
      automount: { enabled: true, root: "/mnt" },
    },
    { runtime: regRuntime },
  );

  // --------------------------------------------------------------------------
  // /mnt/c round-trip: bash and read access the same Windows file (§5.7)
  // --------------------------------------------------------------------------

  {
    const filePath = `${regTmpLogical}/roundtrip.txt`;
    const filePhysical = regConverter.linuxToWindows(filePath);
    fs.writeFileSync(filePhysical, "roundtrip-content");

    // read operation reads via Node fs on the drive path.
    const readContent = await regBackend.read!.readFile(filePath);
    assertEqual(readContent.toString("utf8"), "roundtrip-content", "/mnt/c read returns file content");

    // bash "cat <logicalPath>" accesses the same Windows file via the converter.
    const bashOps = createWslBashOperations({ runtime: regRuntime, logicalCwd: regTmpLogical });
    let bashOutput = Buffer.alloc(0);
    await bashOps.exec(`cat ${filePath}`, regTmpLogical, {
      onData: (d: Buffer) => {
        bashOutput = Buffer.concat([bashOutput, d]);
      },
    });
    assertEqual(bashOutput.toString("utf8"), "roundtrip-content", "/mnt/c bash cat returns the same file content");

    // The physical path is a Windows drive path, not UNC (the value is the
    // drive, not a UNC under /mnt/c). §5.7: "验证值为 drive path，不是 UNC 下的 /mnt/c".
    assert(filePhysical[1] === ":", "/mnt/c physical path is a Windows drive path");
    assert(!filePhysical.startsWith("\\\\"), "/mnt/c physical path is not UNC");
  }

  // --------------------------------------------------------------------------
  // space/$/unicode in paths: single argv, no shell splicing (§5.7)
  // --------------------------------------------------------------------------

  {
    const weirdName = "spa ce$sym 文件.txt";
    const weirdLogical = `${regTmpLogical}/${weirdName}`;
    const weirdPhysical = regConverter.linuxToWindows(weirdLogical);
    fs.writeFileSync(weirdPhysical, "weird-content");

    // File ops preserve the full logical path through conversion.
    const weirdRead = await regBackend.read!.readFile(weirdLogical);
    assertEqual(weirdRead.toString("utf8"), "weird-content", "read handles paths with space/$/unicode");

    // find passes the cwd as a single argv element (not shell-split). A cwd
    // containing spaces, $ and unicode must survive as one argv token.
    const weirdDirLogical = `${regTmpLogical}/weird dir$x`;
    fs.mkdirSync(regConverter.linuxToWindows(weirdDirLogical));
    await regBackend.find!.glob("*.txt", weirdDirLogical, { ignore: [], limit: 10 });
    const fdCall = regRuntime.runCalls.find((c) => c.argv[0] === "fd" || c.argv[0] === "fdfind");
    assert(!!fdCall, "find ran fd for the weird-named cwd");
    assert(fdCall!.argv.includes(weirdDirLogical), "find passes the weird cwd as a single argv element");
  }

  // --------------------------------------------------------------------------
  // broken symlink: ls lists it; read reports a logical path error (§5.7)
  // --------------------------------------------------------------------------

  {
    const brokenLogical = `${regTmpLogical}/broken-link`;
    fs.symlinkSync(`${regTmpLogical}/nowhere`, regConverter.linuxToWindows(brokenLogical));

    // ls.readdirWithTypes lists the broken symlink as a non-directory.
    const typed = await regBackend.ls!.readdirWithTypes!(regTmpLogical);
    const brokenEntry = typed.find((e) => e.name === "broken-link");
    assert(!!brokenEntry && !brokenEntry.isDirectory, "broken symlink is listable as non-directory");

    // read.readFile on the broken symlink rejects with a logical path error.
    let brokenErr = "";
    try {
      await regBackend.read!.readFile(brokenLogical);
    } catch (e) {
      brokenErr = e instanceof Error ? `${e.message} ${(e as { path?: string }).path ?? ""}` : String(e);
    }
    assert(brokenErr.length > 0, "read on broken symlink rejects");
    assert(
      !/\\\\wsl|wsl\.localhost|wsl\$|[A-Za-z]:[\\/]/.test(brokenErr),
      "broken symlink error has no UNC/drive",
    );
    assert(brokenErr.includes("broken-link"), "broken symlink error references the logical path");
  }

  // --------------------------------------------------------------------------
  // case sensitivity: ext4 paths preserve case (§5.7)
  // --------------------------------------------------------------------------

  {
    const caseA = "/home/u/MyRepo";
    const caseB = "/home/u/myrepo";
    assertEqual(
      regConverter.linuxToWindows(caseA),
      "\\\\wsl.localhost\\Ubuntu-22.04\\home\\u\\MyRepo",
      "ext4 path preserves case MyRepo",
    );
    assertEqual(
      regConverter.linuxToWindows(caseB),
      "\\\\wsl.localhost\\Ubuntu-22.04\\home\\u\\myrepo",
      "ext4 path preserves case myrepo",
    );
    assert(
      regConverter.linuxToWindows(caseA) !== regConverter.linuxToWindows(caseB),
      "distinct-case ext4 paths map to distinct UNCs",
    );
    // displayPath preserves ext4 case (no global lowercasing).
    assertEqual(
      regConverter.displayPath("\\\\wsl.localhost\\Ubuntu-22.04\\home\\u\\MyRepo"),
      "/home/u/MyRepo",
      "displayPath preserves ext4 case",
    );
    // /mnt/<drive> lowercases only the drive letter; the rest stays case-sensitive.
    assertEqual(
      regConverter.windowsToLinux("C:\\Users\\MyRepo"),
      "/mnt/c/Users/MyRepo",
      "drive reverse-mapping lowercases only the drive letter",
    );
  }

  // --------------------------------------------------------------------------
  // /mnt/wsl -> UNC (multi-letter mount is not drive-special-cased) (§5.7)
  // --------------------------------------------------------------------------

  {
    assertEqual(
      regConverter.linuxToWindows("/mnt/wsl/foo"),
      "\\\\wsl.localhost\\Ubuntu-22.04\\mnt\\wsl\\foo",
      "/mnt/wsl falls through to UNC (not a drive)",
    );
    assertEqual(
      regConverter.linuxToWindows("/mnt/wslg"),
      "\\\\wsl.localhost\\Ubuntu-22.04\\mnt\\wslg",
      "/mnt/wslg falls through to UNC (not a drive)",
    );
  }

  // --------------------------------------------------------------------------
  // Cross-cutting: tool error messages contain no UNC/drive (§4.7 toLogicalError)
  // --------------------------------------------------------------------------

  {
    const noLeak = (text: string): boolean => /\\\\wsl|wsl\.localhost|wsl\$|[A-Za-z]:[\\/]/.test(text);

    // read error
    let readErr = "";
    try {
      await regBackend.read!.readFile(`${regTmpLogical}/missing-read.txt`);
    } catch (e) {
      readErr = e instanceof Error ? `${e.message} ${(e as { path?: string }).path ?? ""}` : String(e);
    }
    assert(readErr.length > 0, "read missing file rejects");
    assert(!noLeak(readErr), "read error has no UNC/drive");

    // write.readFile error
    let writeErr = "";
    try {
      await regBackend.write!.readFile!(`${regTmpLogical}/missing-write.txt`);
    } catch (e) {
      writeErr = e instanceof Error ? `${e.message} ${(e as { path?: string }).path ?? ""}` : String(e);
    }
    assert(writeErr.length > 0, "write.readFile missing rejects");
    assert(!noLeak(writeErr), "write.readFile error has no UNC/drive");

    // edit.access error
    let editErr = "";
    try {
      await regBackend.edit!.access(`${regTmpLogical}/missing-edit.txt`);
    } catch (e) {
      editErr = e instanceof Error ? `${e.message} ${(e as { path?: string }).path ?? ""}` : String(e);
    }
    assert(editErr.length > 0, "edit.access missing rejects");
    assert(!noLeak(editErr), "edit.access error has no UNC/drive");

    // ls.readdir error
    let lsErr = "";
    try {
      await regBackend.ls!.readdir(`${regTmpLogical}/missing-lsdir`);
    } catch (e) {
      lsErr = e instanceof Error ? `${e.message} ${(e as { path?: string }).path ?? ""}` : String(e);
    }
    assert(lsErr.length > 0, "ls.readdir missing rejects");
    assert(!noLeak(lsErr), "ls.readdir error has no UNC/drive");

    // ls.stat error
    let statErr = "";
    try {
      await regBackend.ls!.stat(`${regTmpLogical}/missing-stat.txt`);
    } catch (e) {
      statErr = e instanceof Error ? `${e.message} ${(e as { path?: string }).path ?? ""}` : String(e);
    }
    assert(statErr.length > 0, "ls.stat missing rejects");
    assert(!noLeak(statErr), "ls.stat error has no UNC/drive");
  }

  // cleanup fake-backed regression temp dir
  try {
    fs.rmSync(regTmpPhysical, { recursive: true, force: true });
  } catch {
    // best-effort
  }
  await regBackend.dispose?.();
}

console.log("\n=== Summary ===");
console.log(`Passed: ${passed}, Failed: ${failed}`);
if (failed > 0) {
  process.exit(1);
}
