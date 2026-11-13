/**
 * WSL runtime: centralized wsl.exe spawn, ready timeout, warm-up/keep-alive,
 * pgid control file, and the taskkill-then-kill-pgid lifecycle.
 *
 * Per wsl_plan.md §4.6:
 *   - A normal command is equivalent to `wsl.exe -d distro --cd logicalCwd
 *     -e bash -c command`. The command is ALWAYS passed as an independent argv
 *     ($1 to the wrapper), never string-concatenated with cwd/distro/shell
 *     fragments.
 *   - stdio fixed ignore/pipe/pipe, windowsHide=true; does NOT call
 *     getShellConfig/getShellEnv. Inner bash uses the distro non-login default
 *     env (bash -c, NOT -lc).
 *   - options.env allows only explicit POSIX-safe key=value as env argv
 *     overlay; rejects PATH, HOME, USERPROFILE and values containing
 *     drive/UNC.
 *
 * Process group & abort/timeout (fixed approach):
 *   - Wrapper: setsid bash -c '"$@"' with command as $1; pgid = setsid session
 *     leader pid written to a control file. If setsid is unavailable, degrades
 *     to no-new-session + best-effort kill <child-pid>.
 *   - Control file: /tmp/pix-wsl/<host-pid>-<instance-id>/<command-id>.pgid; directory mkdir -p in
 *     warmUp with a setsid-availability probe (cached).
 *   - abort/timeout: (1) FIRST taskkill /F /T /PID the Windows wsl.exe so the
 *     main promise settles immediately; (2) THEN asynchronously
 *     killProcessGroup(controlFile) with 5s timeout, failure log-only.
 */

import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";

export interface WslRuntimeOptions {
  distro: string;
  executable?: string;
  readyTimeoutMs: number;
  killTimeoutMs: number;
  keepAliveIntervalMs: number;
}

export interface WslCommandResult {
  exitCode: number | null;
  stdout: Buffer;
  stderr: Buffer;
}

interface WslControlFile {
  path: string;
  timestamp: number;
}

interface WslSpawnOptions {
  logicalCwd?: string;
  env?: NodeJS.ProcessEnv;
  controlFile?: WslControlFile;
}

export interface WslRuntime {
  /** argv is the command vector after wsl.exe -d <distro> [--cd ...] -e. */
  spawn(
    argv: readonly string[],
    options?: WslSpawnOptions,
  ): ChildProcessWithoutNullStreams;
  run(
    argv: readonly string[],
    options?: {
      logicalCwd?: string;
      timeoutMs?: number;
      signal?: AbortSignal;
      env?: NodeJS.ProcessEnv;
    },
  ): Promise<WslCommandResult>;
  spawnBash(
    command: string,
    logicalCwd: string,
    options: {
      onData: (data: Buffer) => void;
      signal?: AbortSignal;
      timeout?: number;
      env?: NodeJS.ProcessEnv;
    },
  ): Promise<{ exitCode: number | null; timedOut: boolean }>;
  allocateControlFile(): WslControlFile;
  /**
   * Cached setsid-availability (probed in warmUp / lazily in spawnBash).
   * Returns false when not yet probed; grep uses this to degrade the wrapper
   * when setsid is unavailable (§4.6).
   */
  isSetsidAvailable(): boolean;
  warmUp(): Promise<void>;
  dispose(): Promise<void>;
}

/**
 * Internal injection points for testing. Not part of the public contract; the
 * second argument of createWslRuntime is optional and omitted in production.
 */
export interface WslRuntimeHooks {
  /** Override the spawn function (default: node:child_process spawn). */
  spawnFn?: WslSpawnFn;
  /** Override taskkill of the Windows host child (default: spawn taskkill). */
  taskkill?: (pid: number) => void;
  /** Override the host PID used in control file names (default: process.pid). */
  hostPid?: number;
  /** Override the control file directory (default: /tmp/pix-wsl). */
  controlDir?: string;
  /** Override the clock used for control file timestamps (default: Date.now). */
  now?: () => number;
}

const DEFAULT_EXECUTABLE = "wsl.exe";
const DEFAULT_CONTROL_DIR = "/tmp/pix-wsl";
const CONTROL_FILE_READ_RETRIES = 10;
const CONTROL_FILE_READ_DELAY_MS = 100;
const KEEPALIVE_COMMAND = "true";

/**
 * Spawn function shape used internally. The real `spawn` from node:child_process
 * returns a narrower ChildProcessByStdio for `["ignore","pipe","pipe"]`; this
 * type widens stdin to Writable so the runtime can store children uniformly.
 * stdin is never read (stdio is "ignore"), making the cast safe.
 */
type WslSpawnFn = (
  command: string,
  args: readonly string[],
  options: {
    stdio: ("ignore" | "pipe")[] | "ignore";
    windowsHide?: boolean;
    detached?: boolean;
  },
) => ChildProcessWithoutNullStreams;

/**
 * Validate an env overlay per §4.6: only explicit POSIX-safe key=value pairs
 * are accepted. Rejects PATH, HOME, USERPROFILE (case-insensitive) and values
 * containing a Windows drive letter or UNC prefix. Returns the `env KEY=VALUE`
 * argv fragment (empty when no overlay is needed).
 */
function buildEnvArgv(env: NodeJS.ProcessEnv): string[] {
  if (!env || Object.keys(env).length === 0) return [];
  const pairs: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    const upperKey = key.toUpperCase();
    if (upperKey === "PATH" || upperKey === "HOME" || upperKey === "USERPROFILE") {
      throw new Error(
        `WSL env overlay rejects reserved key "${key}"; PATH, HOME and USERPROFILE are managed by the distro.`,
      );
    }
    if (!/^[A-Z_][A-Z0-9_]*$/i.test(key)) {
      throw new Error(
        `WSL env overlay rejects key "${key}"; expected a POSIX-safe identifier ([A-Za-z_][A-Za-z0-9_]*).`,
      );
    }
    if (/[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\")) {
      throw new Error(
        `WSL env overlay rejects value for "${key}" containing a Windows drive or UNC path.`,
      );
    }
    pairs.push(`${key}=${value}`);
  }
  return pairs.length > 0 ? ["env", ...pairs] : [];
}

/** Default taskkill: fire-and-forget Windows tree kill. */
function defaultTaskkill(spawnFn: WslSpawnFn, pid: number): void {
  try {
    spawnFn("taskkill", ["/F", "/T", "/PID", String(pid)], {
      stdio: "ignore",
      detached: true,
      windowsHide: true,
    });
  } catch {
    // taskkill failure is best-effort; the child may already be dead.
  }
}

class WslRuntimeImpl implements WslRuntime {
  private readonly _distro: string;
  private readonly _executable: string;
  private readonly _readyTimeoutMs: number;
  private readonly _killTimeoutMs: number;
  private readonly _keepAliveIntervalMs: number;
  private readonly _spawnFn: WslSpawnFn;
  private readonly _taskkillFn: (pid: number) => void;
  private readonly _controlDir: string;
  private readonly _now: () => number;

  private _idCounter = 0;
  private _setsidAvailable: boolean | null = null;
  private _keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  private _disposePromise: Promise<void> | null = null;
  private _warmUpPromise: Promise<void> | null = null;
  private _prepareControlDirPromise: Promise<void> | null = null;
  private readonly _groupCleanups = new Map<string, Promise<void>>();
  private readonly _liveChildren = new Map<ChildProcessWithoutNullStreams, {
    closed: Promise<void>;
    controlFile?: WslControlFile;
  }>();

  constructor(options: WslRuntimeOptions, hooks?: WslRuntimeHooks) {
    this._distro = options.distro;
    this._executable = options.executable ?? DEFAULT_EXECUTABLE;
    this._readyTimeoutMs = options.readyTimeoutMs;
    this._killTimeoutMs = options.killTimeoutMs;
    this._keepAliveIntervalMs = options.keepAliveIntervalMs;
    this._spawnFn = hooks?.spawnFn ?? (spawn as unknown as WslSpawnFn);
    this._taskkillFn =
      hooks?.taskkill ?? ((pid: number) => defaultTaskkill(this._spawnFn, pid));
    this._controlDir = `${hooks?.controlDir ?? DEFAULT_CONTROL_DIR}/${hooks?.hostPid ?? process.pid}-${randomUUID()}`;
    this._now = hooks?.now ?? Date.now;
  }

  // --------------------------------------------------------------------------
  // spawn / run
  // --------------------------------------------------------------------------

  spawn(
    argv: readonly string[],
    options?: WslSpawnOptions,
  ): ChildProcessWithoutNullStreams {
    if (this._disposePromise) {
      throw new Error("WslRuntime has been disposed; cannot spawn.");
    }
    const child = this._spawn(argv, options);
    const controlFile = options?.controlFile;
    const closed = new Promise<void>((resolve) => {
      child.once("close", (code, signal) => {
        if (controlFile && (child.killed || code === null || signal)) {
          void this._scheduleGroupCleanup(controlFile);
        }
        resolve();
      });
      child.once("error", () => resolve());
    });
    this._liveChildren.set(child, { closed, controlFile });
    void closed.then(() => this._liveChildren.delete(child));
    return child;
  }

  private _spawn(
    argv: readonly string[],
    options?: WslSpawnOptions,
  ): ChildProcessWithoutNullStreams {
    const envPrefix = buildEnvArgv(options?.env ?? {});
    const fullArgs: string[] = ["-d", this._distro];
    if (options?.logicalCwd) {
      fullArgs.push("--cd", options.logicalCwd);
    }
    fullArgs.push("-e");
    if (envPrefix.length > 0) {
      fullArgs.push(...envPrefix);
    }
    fullArgs.push(...argv);
    // stdio is fixed to ["ignore","pipe","pipe"]; WslSpawnFn widens stdin so
    // the result is usable as ChildProcessWithoutNullStreams. stdin is never
    // read (stdio is "ignore").
    return this._spawnFn(this._executable, fullArgs, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  }

  async run(
    argv: readonly string[],
    options?: {
      logicalCwd?: string;
      timeoutMs?: number;
      signal?: AbortSignal;
      env?: NodeJS.ProcessEnv;
    },
  ): Promise<WslCommandResult> {
    return this._collect(this.spawn(argv, options), options);
  }

  private _collect(
    child: ChildProcessWithoutNullStreams,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<WslCommandResult> {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;

    return new Promise<WslCommandResult>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;

      const finish = (exitCode: number | null): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (options?.signal) options.signal.removeEventListener("abort", onAbort);
        resolve({
          exitCode,
          stdout: Buffer.concat(stdoutChunks),
          stderr: Buffer.concat(stderrChunks),
        });
      };

      const onAbort = (): void => {
        if (child.pid) this._taskkillFn(child.pid);
      };

      child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
      child.on("error", () => finish(null));
      child.on("close", (code: number | null) => finish(code));

      if (options?.signal) {
        if (options.signal.aborted) {
          onAbort();
        } else {
          options.signal.addEventListener("abort", onAbort, { once: true });
        }
      }
      if (options?.timeoutMs && options.timeoutMs > 0) {
        timer = setTimeout(() => {
          if (child.pid) this._taskkillFn(child.pid);
        }, options.timeoutMs);
      }
    });
  }

  // --------------------------------------------------------------------------
  // spawnBash (setsid wrapper + control file)
  // --------------------------------------------------------------------------

  allocateControlFile(): WslControlFile {
    return {
      path: `${this._controlDir}/${this._idCounter++}.pgid`,
      timestamp: this._now(),
    };
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
  ): Promise<{ exitCode: number | null; timedOut: boolean }> {
    await this._prepareControlDirectory();
    const controlFile = this.allocateControlFile();

    const wrapper = this._buildWrapper(this.isSetsidAvailable());
    // command is $1, controlFile is $2, timestamp is $3 -- all independent
    // argv, never spliced into the wrapper string.
    const argv = [
      "bash",
      "-c",
      wrapper,
      "bash",
      command,
      controlFile.path,
      String(controlFile.timestamp),
    ];

    const child = this.spawn(argv, { logicalCwd, env: options.env, controlFile });
    let settled = false;
    let timedOut = false;

    let cancellation: Promise<void> | undefined;
    return new Promise<{ exitCode: number | null; timedOut: boolean }>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;

      const cleanup = (): void => {
        if (timer) clearTimeout(timer);
        if (options.signal) options.signal.removeEventListener("abort", onAbort);
      };

      const finish = (exitCode: number | null): void => {
        if (settled) return;
        settled = true;
        cleanup();
        if (cancellation) {
          void cancellation.then(() => resolve({ exitCode, timedOut }));
        } else {
          resolve({ exitCode, timedOut });
        }
      };

      const onAbort = (): void => {
        if (child.pid) this._taskkillFn(child.pid);
        cancellation = this._scheduleGroupCleanup(controlFile);
      };

      child.stdout.on("data", (chunk: Buffer) => options.onData(chunk));
      child.stderr.on("data", (chunk: Buffer) => options.onData(chunk));
      child.on("error", () => finish(null));
      child.on("close", (code: number | null) => finish(code));

      if (options.signal) {
        if (options.signal.aborted) {
          onAbort();
        } else {
          options.signal.addEventListener("abort", onAbort, { once: true });
        }
      }
      if (options.timeout && options.timeout > 0) {
        timer = setTimeout(() => {
          timedOut = true;
          onAbort();
        }, options.timeout);
      }
    });
  }

  /**
   * Build the fixed wrapper script. command is $1, controlFile is $2, timestamp
   * is $3. The wrapper writes "<pgid> <timestamp>" to the control file, waits
   * for the command, and propagates the exit code. Control info goes only to
   * the control file, never to stdout/stderr.
   */
  private _buildWrapper(setsidAvailable: boolean): string {
    const leader = setsidAvailable ? "setsid bash -c \"$1\"" : "bash -c \"$1\"";
    return (
      `CTRL="$2"; ` +
      `${leader} & ` +
      `echo "$! $3" > "$CTRL"; ` +
      'wait $!; code=$?; rm -f -- "$CTRL"; exit "$code"'
    );
  }

  /**
   * Cached setsid-availability. Probed in warmUp and lazily in spawnBash;
   * returns false when not yet probed so callers (grep's spawnWslRipgrep)
   * degrade to the no-setsid wrapper instead of rejecting (§4.6).
   */
  isSetsidAvailable(): boolean {
    return this._setsidAvailable ?? false;
  }

  // --------------------------------------------------------------------------
  // killProcessGroup
  // --------------------------------------------------------------------------

  private _scheduleGroupCleanup(controlFile: WslControlFile): Promise<void> {
    let cleanup = this._groupCleanups.get(controlFile.path);
    if (!cleanup) {
      cleanup = this._killProcessGroup(controlFile).catch((error: unknown) => {
        console.error(`[wsl-runtime] failed to clean up ${controlFile.path}: ${String(error)}`);
      }).finally(() => this._groupCleanups.delete(controlFile.path));
      this._groupCleanups.set(controlFile.path, cleanup);
    }
    return cleanup;
  }

  private async _killProcessGroup({ path, timestamp }: WslControlFile): Promise<void> {
    // Retry reading the control file: abort may fire before the wrapper writes
    // the pgid (10 x 100ms).
    let raw: string | null = null;
    for (let i = 0; i < CONTROL_FILE_READ_RETRIES; i++) {
      const result = await this._collect(this._spawn(["cat", path]), {
        timeoutMs: 1000,
      });
      const text = result.stdout.toString("utf8").trim();
      if (text) {
        raw = text;
        break;
      }
      await new Promise<void>((r) => setTimeout(r, CONTROL_FILE_READ_DELAY_MS));
    }
    if (!raw) {
      // No pgid recorded; orphan is handled by keep-alive / VM lifecycle.
      return;
    }
    const parts = raw.split(/\s+/);
    const pgidStr = parts[0] ?? "";
    const fileTimestamp = Number.parseInt(parts[1] ?? "", 10);
    const pgid = Number.parseInt(pgidStr, 10);
    if (!Number.isFinite(pgid) || pgid <= 0) {
      return;
    }
    // Best-effort PID-recycle guard: if we have metadata, verify the timestamp
    // matches this session window.
    if (fileTimestamp !== timestamp) {
      console.error(
        `[wsl-runtime] control file ${path} timestamp mismatch ` +
          `(file=${fileTimestamp}, expected=${timestamp}); skipping kill.`,
      );
      return;
    }
    // Single cleanup command: kill the process group (negative pid) and the
    // direct pid (degraded/no-setsid fallback), then remove the control file.
    // pgid and controlFile are passed as $1/$2, never spliced.
    const cleanupScript =
      'kill -KILL -"$1" 2>/dev/null; kill -KILL "$1" 2>/dev/null; rm -f "$2"';
    await this._collect(
      this._spawn(["bash", "-c", cleanupScript, "bash", String(pgid), path]),
      { timeoutMs: this._killTimeoutMs },
    );
  }

  // --------------------------------------------------------------------------
  // warmUp / keep-alive / dispose
  // --------------------------------------------------------------------------

  async warmUp(): Promise<void> {
    if (this._disposePromise) {
      throw new Error("WslRuntime has been disposed; cannot warmUp.");
    }
    if (this._warmUpPromise) {
      return this._warmUpPromise;
    }
    this._warmUpPromise = this._doWarmUp();
    return this._warmUpPromise;
  }

  private async _doWarmUp(): Promise<void> {
    // (1) Explicit-distro `true` -- verifies the distro is accessible.
    const ready = await this.run([KEEPALIVE_COMMAND], {
      timeoutMs: this._readyTimeoutMs,
    });
    if (ready.exitCode !== 0) {
      throw new Error(
        `WSL distro "${this._distro}" warm-up failed (wsl.exe -d ${this._distro} -e true exited with ${ready.exitCode}).`,
      );
    }
    await this._prepareControlDirectory();
    // (3) Start keep-alive interval.
    if (this._keepAliveIntervalMs > 0 && !this._keepAliveTimer && !this._disposePromise) {
      this._keepAliveTimer = setInterval(() => {
        void this.run([KEEPALIVE_COMMAND], {
          timeoutMs: this._readyTimeoutMs,
        }).catch(() => {
          // keep-alive failure is best-effort; the VM may be shutting down.
        });
      }, this._keepAliveIntervalMs);
      if (typeof this._keepAliveTimer.unref === "function") {
        this._keepAliveTimer.unref();
      }
    }
  }

  private _prepareControlDirectory(): Promise<void> {
    this._prepareControlDirPromise ??= this.run(
      ["bash", "-c", 'mkdir -p -- "$1" || exit; command -v setsid || true', "bash", this._controlDir],
      { timeoutMs: this._readyTimeoutMs },
    ).then((result) => {
      if (result.exitCode !== 0) {
        throw new Error(`Could not create the PiX control directory in WSL distro "${this._distro}".`);
      }
      this._setsidAvailable = result.stdout.toString("utf8").trim() !== "";
      if (!this._setsidAvailable) {
        console.error(`[wsl-runtime] setsid is unavailable in distro "${this._distro}"; using direct PID cleanup.`);
      }
    });
    return this._prepareControlDirPromise;
  }

  dispose(): Promise<void> {
    this._disposePromise ??= this._dispose();
    return this._disposePromise;
  }

  private async _dispose(): Promise<void> {
    if (this._keepAliveTimer) {
      clearInterval(this._keepAliveTimer);
      this._keepAliveTimer = null;
    }
    const children = [...this._liveChildren];
    for (const [child, { controlFile }] of children) {
      if (child.pid) {
        try {
          this._taskkillFn(child.pid);
        } catch {
          // best-effort
        }
      }
      if (controlFile) void this._scheduleGroupCleanup(controlFile);
    }
    await Promise.all(children.map(([, child]) => child.closed));
    await Promise.all(this._groupCleanups.values());
    if (this._prepareControlDirPromise) {
      await this._collect(this._spawn(["rm", "-rf", "--", this._controlDir]), { timeoutMs: this._killTimeoutMs });
    }
  }
}

export function createWslRuntime(
  options: WslRuntimeOptions,
  hooks?: WslRuntimeHooks,
): WslRuntime {
  return new WslRuntimeImpl(options, hooks);
}
