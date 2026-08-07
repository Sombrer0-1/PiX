/**
 * WSL execution backend: composes the WslRuntime, WslPathConverter, the six
 * file operations and bash into a single SDK ExecutionBackend instance.
 *
 * Per wsl_plan.md §4.7:
 *   - Creates and owns the single WslRuntime; resolves only after warmUp
 *     completes; dispose is idempotent and only called by the context owner.
 *   - ToolPathContext is synthesized exactly per §4.7 (POSIX resolve + home
 *     expansion, displayPath via converter, toFileUrl via linuxToWindows,
 *     getMutationKey via Linux realpath, pathStyle "posix").
 *   - runtimeEnvironment provides platform="linux", osName=WSL2+distro and a
 *     complete shell object { kind:"wsl", path:"wsl.exe" } (shallow-replaced
 *     wholesale); no cwd field.
 *
 * The optional second `hooks` argument mirrors the S4 WslRuntimeHooks pattern:
 * it is an internal injection point for tests, not part of the public contract,
 * and omitted in production.
 */

import { posix as pathPosix } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  ExecutionBackend,
  RuntimeEnvironmentContext,
  ToolPathContext,
} from "@earendil-works/pi-coding-agent";
import type { WslAutomountConfig } from "./wsl-distro.js";
import { WslPathConverter } from "./wsl-paths.js";
import { createWslBashOperations } from "./wsl-bash-operations.js";
import { createWslFileOperations } from "./wsl-file-operations.js";
import {
  createWslRuntime,
  type WslRuntime,
  type WslRuntimeOptions,
} from "./wsl-runtime.js";

export interface CreateWslExecutionBackendOptions {
  distro: string;
  logicalCwd: string;
  physicalCwd: string;
  home: string;
  automount: WslAutomountConfig;
  runtimeOptions?: Partial<Omit<WslRuntimeOptions, "distro">>;
}

/**
 * Internal injection points for testing. Not part of the public contract; the
 * second argument of createWslExecutionBackend is optional and omitted in
 * production. Mirrors the WslRuntimeHooks pattern from wsl-runtime.ts.
 */
export interface WslExecutionBackendHooks {
  /** Override the WslRuntime (default: createWslRuntime). When injected, warmUp is skipped and dispose is not called by the backend. */
  runtime?: WslRuntime;
  /** Skip warmUp even when the backend owns the runtime. */
  skipWarmUp?: boolean;
}

const DEFAULT_READY_TIMEOUT_MS = 30_000;
const DEFAULT_KILL_TIMEOUT_MS = 5_000;
const DEFAULT_KEEPALIVE_INTERVAL_MS = 60_000;
const REALPATH_TIMEOUT_MS = 10_000;
const ASSERT_DIR_TIMEOUT_MS = 15_000;

/** Expand a leading ~ to home (POSIX). ~ and ~/... only; other inputs unchanged. */
function expandTilde(input: string, home: string): string {
  if (input === "~") return home;
  if (input.startsWith("~/")) return pathPosix.join(home, input.slice(2));
  return input;
}

/** Resolve a logical absolute path to its Linux realpath via `wsl.exe -e realpath`. */
async function linuxRealpath(runtime: WslRuntime, logicalPath: string): Promise<string> {
  try {
    const result = await runtime.run(["realpath", logicalPath], {
      timeoutMs: REALPATH_TIMEOUT_MS,
    });
    if (result.exitCode === 0) {
      const resolved = result.stdout.toString("utf8").trim();
      if (resolved) return resolved;
    }
  } catch {
    // fall through to the unmodified logical path
  }
  return logicalPath;
}

/** Build the ToolPathContext per §4.7 synthesis. */
function createWslToolPathContext(
  converter: WslPathConverter,
  runtime: WslRuntime,
  home: string,
): ToolPathContext {
  return {
    pathStyle: "posix",
    homeDir: home,
    resolvePath: (input, cwd) => pathPosix.resolve(cwd, expandTilde(input, home)),
    displayPath: (p) => converter.displayPath(p),
    toFileUrl: (abs) => pathToFileURL(converter.linuxToWindows(abs)).href,
    getMutationKey: async (abs) => linuxRealpath(runtime, abs),
  };
}

export async function createWslExecutionBackend(
  options: CreateWslExecutionBackendOptions,
  hooks?: WslExecutionBackendHooks,
): Promise<ExecutionBackend> {
  const { distro, logicalCwd, physicalCwd, home, automount, runtimeOptions } = options;

  const converter = new WslPathConverter({
    distro,
    home,
    automountRoot: automount.root,
    automountEnabled: automount.enabled,
  });

  const ownsRuntime = !hooks?.runtime;
  const runtime: WslRuntime = hooks?.runtime ?? createWslRuntime({
    distro,
    executable: runtimeOptions?.executable,
    readyTimeoutMs: runtimeOptions?.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
    killTimeoutMs: runtimeOptions?.killTimeoutMs ?? DEFAULT_KILL_TIMEOUT_MS,
    keepAliveIntervalMs: runtimeOptions?.keepAliveIntervalMs ?? DEFAULT_KEEPALIVE_INTERVAL_MS,
  });

  const opSet = createWslFileOperations({ converter, runtime, logicalCwd, physicalCwd });
  const paths = createWslToolPathContext(converter, runtime, home);
  const bash = createWslBashOperations({ runtime, logicalCwd });
  const runtimeEnvironment: Partial<RuntimeEnvironmentContext> = {
    platform: "linux",
    osName: `WSL2 (${distro})`,
    shell: { kind: "wsl", path: "wsl.exe" },
  };

  // Resolve only after warmUp completes (production path). When a runtime is
  // injected for testing, warmUp is skipped; the fake runtime owns its state.
  if (!hooks?.skipWarmUp && ownsRuntime) {
    await runtime.warmUp();
  }

  let disposed = false;
  const backend: ExecutionBackend = {
    paths,
    bash,
    read: opSet.read,
    write: opSet.write,
    edit: opSet.edit,
    grep: opSet.grep,
    find: opSet.find,
    ls: opSet.ls,
    runtimeEnvironment,
    assertProjectDirectory: async (cwd) => {
      const result = await runtime.run(
        ["bash", "-c", 'test -d "$1"', "bash", cwd],
        { timeoutMs: ASSERT_DIR_TIMEOUT_MS },
      );
      if (result.exitCode !== 0) {
        throw new Error(`Directory "${cwd}" does not exist in WSL distro "${distro}".`);
      }
    },
    getCwd: () => logicalCwd,
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      if (ownsRuntime) {
        await runtime.dispose();
      }
    },
  };
  return backend;
}
