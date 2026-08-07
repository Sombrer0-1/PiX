/**
 * WSL distro resolver primitives.
 *
 * Parses `wsl.exe -l -v` UTF-16LE output, validates an explicitly-named WSL2
 * distro, and probes Linux-side facts (directory existence, home, automount
 * config). Per wsl_plan.md §4.4:
 *   - strip BOM/NUL, split columns on 2+ consecutive spaces, never rely on
 *     fixed column widths;
 *   - requireDistro accepts only the caller-supplied name and never reads the
 *     default marker to substitute the name;
 *   - v1 accepts only version 2;
 *   - ENOENT / non-WSL host / timeout surface as diagnostics upstream rather
 *     than uncaught exceptions (list() returns [] in those cases).
 */

import { spawn } from "node:child_process";

export interface WslDistroInfo {
  name: string;
  state: string;
  version: number;
  isDefault: boolean;
}

export interface WslAutomountConfig {
  enabled: boolean;
  root: string;
}

export interface WslDistroResolverOptions {
  executable?: string;
  listTimeoutMs?: number;
  probeTimeoutMs?: number;
}

interface WslCommandResult {
  exitCode: number | null;
  stdout: Buffer;
  stderr: Buffer;
}

const DEFAULT_EXECUTABLE = "wsl.exe";
const DEFAULT_LIST_TIMEOUT_MS = 10_000;
const DEFAULT_PROBE_TIMEOUT_MS = 30_000;

/**
 * Parse `wsl.exe -l -v` output. Accepts a UTF-16LE Buffer (the raw wsl.exe
 * stdout) or a pre-decoded string. Strips a leading BOM and any stray NUL
 * characters, then splits columns on runs of 2+ spaces. Does not filter by
 * version; requireDistro enforces the version-2 acceptance.
 */
export function parseWslListOutput(output: Buffer | string): WslDistroInfo[] {
  const text = (typeof output === "string" ? output : output.toString("utf16le"))
    .replace(/^\uFEFF/, "")
    .replace(/\u0000/g, "");
  const lines = text.split(/\r?\n/);
  const distros: WslDistroInfo[] = [];
  for (const rawLine of lines) {
    const line = rawLine.replace(/\u0000/g, "").trim();
    if (line.length === 0) continue;
    let isDefault = false;
    let rest = line;
    if (rest.startsWith("*")) {
      isDefault = true;
      rest = rest.slice(1).trimStart();
    }
    const columns = rest.split(/\s{2,}/);
    if (columns.length < 3) continue;
    const name = columns[0]!.trim();
    const state = columns[1]!.trim();
    const version = Number.parseInt(columns[2]!.trim(), 10);
    // The header row (NAME  STATE  VERSION) is skipped structurally here: its
    // VERSION column parses to NaN. No fixed header text is matched, per
    // wsl_plan.md section 4.4 (pure structural parsing).
    if (!name || !Number.isFinite(version)) continue;
    distros.push({ name, state, version, isDefault });
  }
  return distros;
}

/**
 * Parse the `[automount]` section of /etc/wsl.conf. When the section or keys
 * are absent, the WSL defaults apply: enabled=true, root=/mnt.
 */
function parseWslAutomountConfig(text: string): WslAutomountConfig {
  const lines = text.split(/\r?\n/);
  let inAutomount = false;
  let enabled = true;
  let root = "/mnt";
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#") || line.startsWith(";")) continue;
    if (line.startsWith("[") && line.endsWith("]")) {
      inAutomount = line.toLowerCase() === "[automount]";
      continue;
    }
    if (!inAutomount) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    const value = line.slice(eq + 1).trim();
    if (key === "enabled") {
      enabled = /^(true|yes|1)$/i.test(value);
    } else if (key === "root") {
      if (value) root = value;
    }
  }
  return { enabled, root };
}

export class WslDistroResolver {
  private readonly _executable: string;
  private readonly _listTimeoutMs: number;
  private readonly _probeTimeoutMs: number;

  constructor(options?: WslDistroResolverOptions) {
    this._executable = options?.executable ?? DEFAULT_EXECUTABLE;
    this._listTimeoutMs = options?.listTimeoutMs ?? DEFAULT_LIST_TIMEOUT_MS;
    this._probeTimeoutMs = options?.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  }

  /**
   * List installed distros. Returns [] when wsl.exe is missing, the host is not
   * WSL-capable, or the probe times out; these conditions surface as
   * diagnostics upstream rather than uncaught exceptions.
   */
  async list(): Promise<WslDistroInfo[]> {
    try {
      const result = await this._run(["-l", "-v"], this._listTimeoutMs);
      if (result.exitCode !== 0) return [];
      return parseWslListOutput(result.stdout);
    } catch {
      return [];
    }
  }

  /**
   * Resolve and validate an explicitly-named WSL2 distro. Never falls back to
   * the default distro and never substitutes the name from the default marker;
   * v1 accepts only version 2.
   */
  async requireDistro(name: string): Promise<WslDistroInfo> {
    const distros = await this.list();
    const match = distros.find((d) => d.name === name);
    if (!match) {
      throw new Error(
        `WSL distro "${name}" was not found. Install it or pick an available distro; ` +
          `the default distro is never substituted automatically.`,
      );
    }
    if (match.version !== 2) {
      throw new Error(
        `WSL distro "${name}" is version ${match.version}; PiX WSL support requires WSL2 (version 2). ` +
          `Convert it with: wsl --set-version ${name} 2`,
      );
    }
    return match;
  }

  /** Assert that a logical POSIX directory exists inside the distro. */
  async assertDirectory(distro: string, logicalCwd: string): Promise<void> {
    // Pass logicalCwd as $1 so paths with spaces/special characters survive
    // argv marshaling intact; the script itself is a fixed string.
    const result = await this._run(
      ["-d", distro, "-e", "bash", "-c", 'test -d "$1"', "bash", logicalCwd],
      this._probeTimeoutMs,
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `Directory "${logicalCwd}" does not exist in WSL distro "${distro}". ` +
          `Verify the path is an absolute POSIX path inside the distro.`,
      );
    }
  }

  /** Resolve the Linux home directory of the distro's default user. */
  async getHome(distro: string): Promise<string> {
    // `cd ~ && pwd` avoids embedding quotes in the script: `~` expands to the
    // user's home (from $HOME or the passwd database) and pwd prints it.
    const result = await this._run(
      ["-d", distro, "-e", "bash", "-c", "cd ~ && pwd"],
      this._probeTimeoutMs,
    );
    if (result.exitCode !== 0) {
      throw new Error(`Failed to resolve the home directory in WSL distro "${distro}".`);
    }
    const home = result.stdout.toString("utf8").split(/\r?\n/)[0]!.trim();
    if (!home) {
      throw new Error(`Home directory resolved empty in WSL distro "${distro}".`);
    }
    return home;
  }

  /** Read the [automount] configuration from /etc/wsl.conf (defaults applied when absent). */
  async getAutomountConfig(distro: string): Promise<WslAutomountConfig> {
    const result = await this._run(
      ["-d", distro, "-e", "bash", "-c", "cat /etc/wsl.conf 2>/dev/null"],
      this._probeTimeoutMs,
    );
    const text = result.exitCode === 0 ? result.stdout.toString("utf8") : "";
    return parseWslAutomountConfig(text);
  }

  private _run(args: readonly string[], timeoutMs: number): Promise<WslCommandResult> {
    return new Promise<WslCommandResult>((resolve, reject) => {
      const child = spawn(this._executable, [...args], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

      const clearTimer = (): void => {
        if (timer) {
          clearTimeout(timer);
          timer = undefined;
        }
      };
      const finish = (result: WslCommandResult): void => {
        if (settled) return;
        settled = true;
        clearTimer();
        resolve(result);
      };
      const fail = (err: Error): void => {
        if (settled) return;
        settled = true;
        clearTimer();
        try {
          child.kill();
        } catch {
          // ignore kill failures during cleanup
        }
        reject(err);
      };

      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          fail(new Error(`wsl.exe timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }

      child.on("error", (err: Error) => fail(err));
      child.on("close", (exitCode: number | null) => {
        finish({
          exitCode,
          stdout: Buffer.concat(stdoutChunks),
          stderr: Buffer.concat(stderrChunks),
        });
      });
    });
  }
}
