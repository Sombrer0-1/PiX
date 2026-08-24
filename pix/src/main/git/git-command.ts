/**
 * Bounded git command runner (PiX 1.5.0, SDD §4.3.2).
 *
 * Executes single git commands with a hard timeout (2000ms default), a stdout
 * cap (1 MiB default) and a stderr cap (64 KiB), for both backends:
 *   - Windows: spawn("git", [--no-pager, -c core.fsmonitor=false, ...args],
 *     cwd = the project's physical path);
 *   - WSL:     spawn("wsl.exe", ["-d", <distro>, "--cd", <logical>, "-e",
 *     "git", ...], argv array passed verbatim, never a shell string).
 *
 * All commands carry the fixed global prefix --no-pager -c
 * core.fsmonitor=false (pager and fsmonitor background refresh suppressed)
 * and run with GIT_TERMINAL_PROMPT=0, so the service layer only passes the
 * command-specific arguments.
 *
 * The event loop follows wsl-distro.ts _run: a `settled` boolean guards the
 * close/error sentinels and the timeout/truncation kill paths so the promise
 * resolves exactly once. Timeouts and stdout overflow kill the child; on WSL
 * the kill lands on the wsl.exe host process and the distro-side read-only
 * status child may linger until it exits naturally (seconds at most) - that
 * residue is accepted, no taskkill/process-group management is introduced.
 */

import { spawn } from "node:child_process";

export interface GitCommandOutput {
  exitCode: number | null;
  /** utf8 解码后的 stdout；truncated 时为截断前已收集部分。 */
  stdout: string;
  stderr: string;
  /** stdout 达到上限（收集停止、进程被杀）。 */
  truncated: boolean;
  timedOut: boolean;
  /** 宿主侧二进制 ENOENT（Windows 的 git / WSL 的 wsl.exe）。 */
  notFound: boolean;
}

export type GitRunnerEnvironment =
  | { kind: "windows" }
  | { kind: "wsl"; distro: string };

/** cwd 在构造时绑定，run 只传 git 参数（一次快照一个 runner，cwd 恒定）。 */
export interface GitCommandRunner {
  run(args: string[]): Promise<GitCommandOutput>;
}

/** 固定全局参数前缀：抑制 pager 与 fsmonitor 后台刷新。 */
const GIT_GLOBAL_PREFIX = ["--no-pager", "-c", "core.fsmonitor=false"] as const;
const DEFAULT_TIMEOUT_MS = 2000;
const DEFAULT_MAX_STDOUT_BYTES = 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;

/** 创建有界 git 执行器：每条命令 timeout 2000ms、stdout 上限 1 MiB、stderr 上限 64 KiB。 */
export function createGitCommandRunner(
  env: GitRunnerEnvironment,
  cwd: { logical: string; physical: string },
  options?: { timeoutMs?: number; maxStdoutBytes?: number },
): GitCommandRunner {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxStdoutBytes = options?.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES;
  return {
    run: (args: string[]) => runGitCommand(env, cwd, args, timeoutMs, maxStdoutBytes),
  };
}

function runGitCommand(
  env: GitRunnerEnvironment,
  cwd: { logical: string; physical: string },
  args: string[],
  timeoutMs: number,
  maxStdoutBytes: number,
): Promise<GitCommandOutput> {
  return new Promise<GitCommandOutput>((resolve) => {
    const argv =
      env.kind === "windows"
        ? ["git", ...GIT_GLOBAL_PREFIX, ...args]
        : ["wsl.exe", "-d", env.distro, "--cd", cwd.logical, "-e", "git", ...GIT_GLOBAL_PREFIX, ...args];
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd: env.kind === "windows" ? cwd.physical : undefined,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const clearTimer = (): void => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    };
    const killChild = (): void => {
      try {
        child.kill();
      } catch {
        // ignore kill failures during cleanup
      }
    };
    const collectStdout = (): string => Buffer.concat(stdoutChunks).toString("utf8");
    const collectStderr = (): string => Buffer.concat(stderrChunks).toString("utf8");
    const finish = (result: GitCommandOutput): void => {
      if (settled) return;
      settled = true;
      clearTimer();
      resolve(result);
    };
    // stdout 达到上限：停止累积并 kill，truncated: true；截断前已收集部分
    // 原样保留（含恰好达到上限的字节）。恰好填满上限也立即截断——否则后续
    // 字节会被静默丢弃而 truncated 仍为 false，服务层会把不精确统计当精确。
    const truncate = (): void => {
      if (settled) return;
      killChild();
      finish({
        exitCode: null,
        stdout: collectStdout(),
        stderr: collectStderr(),
        truncated: true,
        timedOut: false,
        notFound: false,
      });
    };

    child.stdout.on("data", (chunk: Buffer) => {
      if (settled) return;
      const remaining = maxStdoutBytes - stdoutBytes;
      if (remaining <= 0) {
        truncate();
        return;
      }
      if (chunk.length <= remaining) {
        stdoutChunks.push(chunk);
        stdoutBytes += chunk.length;
        if (stdoutBytes >= maxStdoutBytes) truncate();
      } else {
        stdoutChunks.push(chunk.subarray(0, remaining));
        stdoutBytes += remaining;
        truncate();
      }
    });
    // stderr 收集到 64 KiB 停止（不截断标志；stderr 仅供服务层分类，不外传）。
    child.stderr.on("data", (chunk: Buffer) => {
      if (settled) return;
      if (stderrBytes >= MAX_STDERR_BYTES) return;
      const remaining = MAX_STDERR_BYTES - stderrBytes;
      stderrChunks.push(chunk.subarray(0, remaining));
      stderrBytes += Math.min(chunk.length, remaining);
    });

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        if (settled) return;
        killChild();
        finish({
          exitCode: null,
          stdout: collectStdout(),
          stderr: collectStderr(),
          truncated: false,
          timedOut: true,
          notFound: false,
        });
      }, timeoutMs);
    }

    // spawn error 事件且 code === "ENOENT"（Windows 的 git / WSL 的 wsl.exe
    // 缺失）→ notFound；其它 spawn 失败以 exitCode null 落盘，由服务层分类。
    child.on("error", (err: NodeJS.ErrnoException) => {
      if (settled) return;
      finish({
        exitCode: null,
        stdout: collectStdout(),
        stderr: collectStderr(),
        truncated: false,
        timedOut: false,
        notFound: err.code === "ENOENT",
      });
    });
    child.on("close", (exitCode: number | null) => {
      finish({
        exitCode,
        stdout: collectStdout(),
        stderr: collectStderr(),
        truncated: false,
        timedOut: false,
        notFound: false,
      });
    });
  });
}
