/**
 * WSL file operations: assembles the six SDK file-tool operations
 * (read/write/edit/grep/find/ls) on top of WslPathConverter + WslRuntime.
 *
 * Per wsl_plan.md §4.7:
 *   - read/write/edit/ls receive a POSIX logical absolute path; each op
 *     converts to a physical (UNC/drive) path via the converter after its
 *     outermost guard, then calls Node fs. The physical path never returns to
 *     the SDK.
 *   - write mkdir uses one `wsl.exe -d distro -e mkdir -p -- <logicalDir>` to
 *     avoid multiple 9P round-trips for recursive UNC mkdir.
 *   - find glob runs fd (or fdfind) inside WSL, returning absolute Linux paths;
 *     missing fd reports an apt install hint, never a Windows fd substitute.
 *   - grep spawnRipgrep runs rg inside WSL via setsid + control file (§4.6);
 *     missing rg surfaces an Error with the distro name and an apt hint.
 *   - ls prefers readdir withFileTypes; d_type unavailable falls back to
 *     per-entry lstat. Broken symlinks are listable.
 *   - toLogicalError rewrites UNC/drive fragments back to logical paths and is
 *     applied per-method so neither self-built nor raw Node fs errors leak
 *     physical paths.
 */

import { open, access as fsAccess, readFile as fsReadFile, writeFile as fsWriteFile, readdir as fsReaddir, stat as fsStat, lstat as fsLstat } from "node:fs/promises";
import { constants } from "node:fs";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { posix as pathPosix, win32 as pathWin32 } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  EditOperations,
  FindOperations,
  GrepOperations,
  LsOperations,
  ReadOperations,
  WriteOperations,
} from "@earendil-works/pi-coding-agent";
import { WslPathConverter } from "./wsl-paths.js";
import type { WslRuntime } from "./wsl-runtime.js";

export interface WslFileOperationsOptions {
  converter: WslPathConverter;
  runtime: WslRuntime;
  logicalCwd: string;
  physicalCwd: string;
}

export interface WslOperationSet {
  read: ReadOperations;
  write: WriteOperations;
  edit: EditOperations;
  grep: GrepOperations;
  find: FindOperations;
  ls: LsOperations;
}

const RUN_TIMEOUT_MS = 30_000;
const FD_TIMEOUT_MS = 60_000;
const MAX_CAUSE_DEPTH = 10;

// Image magic-byte sniffing mirrors packages/coding-agent/src/utils/mime.ts.
// The SDK util is not exported through the package barrel and the package
// `exports` map blocks deep imports, so the logic is inlined here to preserve
// image MIME detection for files reached via UNC/drive paths.
const IMAGE_SNIFF_BYTES = 4100;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// ============================================================================
// toLogicalError
// ============================================================================

/** Convert a Windows path to logical, returning the input unchanged on failure. */
function safeWindowsToLinux(converter: WslPathConverter, windowsPath: string): string {
  try {
    return converter.windowsToLinux(windowsPath);
  } catch {
    return windowsPath;
  }
}

/**
 * Rewrite UNC (\\wsl.localhost\<distro>\..., \\wsl$\<distro>\...) and Windows
 * drive ([A-Z]:\...) fragments inside a text string back to logical POSIX
 * paths. Path runs stop at whitespace or quotes so surrounding punctuation is
 * preserved.
 */
function rewriteFragments(text: string, converter: WslPathConverter): string {
  if (!text) return text;
  let out = text;
  out = out.replace(/\\\\wsl\.localhost\\[^\\]+(?:\\[^\s'"]*)*/g, (m) => safeWindowsToLinux(converter, m));
  out = out.replace(/\\\\wsl\$\\[^\\]+(?:\\[^\s'"]*)*/g, (m) => safeWindowsToLinux(converter, m));
  // Backslash-only so URL schemes (http://, https://) are not mistaken for a
  // drive letter + path. Real Windows drive fragments in Node fs errors use
  // backslashes (C:\...); forward-slash drive paths are not rewritten here.
  out = out.replace(/[A-Za-z]:[\\](?:[^\s'"]*)/g, (m) => safeWindowsToLinux(converter, m));
  return out;
}

/** Recursively rewrite an Error's message, path and cause chain. */
function rewriteError(e: Error, converter: WslPathConverter, depth: number): Error {
  const message = rewriteFragments(e.message, converter);
  const newErr = new Error(message);
  const newErrRecord = newErr as unknown as Record<string, unknown>;
  const eRecord = e as unknown as Record<string, unknown>;
  // Preserve useful own properties (code, syscall, errno) except those handled
  // explicitly (message/stack/cause/path).
  for (const key of Object.keys(e)) {
    if (key === "message" || key === "stack" || key === "cause" || key === "path") continue;
    newErrRecord[key] = eRecord[key];
  }
  const pathVal = eRecord.path;
  if (typeof pathVal === "string" && pathVal) {
    newErrRecord.path = safeWindowsToLinux(converter, pathVal);
  }
  const cause = eRecord.cause;
  if (cause instanceof Error && depth < MAX_CAUSE_DEPTH) {
    newErrRecord.cause = rewriteError(cause, converter, depth + 1);
  } else if (typeof cause === "string") {
    newErrRecord.cause = rewriteFragments(cause, converter);
  } else if (cause !== undefined) {
    newErrRecord.cause = cause;
  }
  return newErr;
}

/**
 * Translate an error into a model-visible logical form. Rewrites e.path via
 * converter.windowsToLinux, then regex-replaces UNC/drive fragments in
 * error.message and error.cause.message (recursive). Returns a new Error;
 * preserves the existing (rewritten) cause chain and own properties like code.
 */
export function toLogicalError(e: unknown, converter: WslPathConverter): Error {
  const original = e instanceof Error ? e : new Error(String(e));
  return rewriteError(original, converter, 0);
}

// ============================================================================
// Image MIME detection (mirrors packages/coding-agent/src/utils/mime.ts)
// ============================================================================

function startsWith(buffer: Uint8Array, bytes: number[]): boolean {
  if (buffer.length < bytes.length) return false;
  return bytes.every((byte, index) => buffer[index] === byte);
}

function startsWithAscii(buffer: Uint8Array, offset: number, text: string): boolean {
  if (buffer.length < offset + text.length) return false;
  for (let index = 0; index < text.length; index++) {
    if (buffer[offset + index] !== text.charCodeAt(index)) return false;
  }
  return true;
}

function readUint32BE(buffer: Uint8Array, offset: number): number {
  return (
    (buffer[offset] ?? 0) * 0x1000000 +
    ((buffer[offset + 1] ?? 0) << 16) +
    ((buffer[offset + 2] ?? 0) << 8) +
    (buffer[offset + 3] ?? 0)
  );
}

function isPng(buffer: Uint8Array): boolean {
  return (
    buffer.length >= 16 &&
    readUint32BE(buffer, PNG_SIGNATURE.length) === 13 &&
    startsWithAscii(buffer, 12, "IHDR")
  );
}

function isAnimatedPng(buffer: Uint8Array): boolean {
  let offset = PNG_SIGNATURE.length;
  while (offset + 8 <= buffer.length) {
    const chunkLength = readUint32BE(buffer, offset);
    const chunkTypeOffset = offset + 4;
    if (startsWithAscii(buffer, chunkTypeOffset, "acTL")) return true;
    if (startsWithAscii(buffer, chunkTypeOffset, "IDAT")) return false;
    const nextOffset = offset + 8 + chunkLength + 4;
    if (nextOffset <= offset || nextOffset > buffer.length) return false;
    offset = nextOffset;
  }
  return false;
}

function detectImageMimeTypeFromBuffer(buffer: Uint8Array): string | null {
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) {
    return buffer[3] === 0xf7 ? null : "image/jpeg";
  }
  if (startsWith(buffer, PNG_SIGNATURE)) {
    return isPng(buffer) && !isAnimatedPng(buffer) ? "image/png" : null;
  }
  if (startsWithAscii(buffer, 0, "GIF")) {
    return "image/gif";
  }
  if (startsWithAscii(buffer, 0, "RIFF") && startsWithAscii(buffer, 8, "WEBP")) {
    return "image/webp";
  }
  return null;
}

async function detectImageMimeTypeFromPath(physicalPath: string): Promise<string | null> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(physicalPath, "r");
    const buffer = Buffer.alloc(IMAGE_SNIFF_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, IMAGE_SNIFF_BYTES, 0);
    return detectImageMimeTypeFromBuffer(buffer.subarray(0, bytesRead));
  } catch {
    return null;
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // best-effort
      }
    }
  }
}

// ============================================================================
// grep spawnRipgrep helpers (setsid wrapper + control file)
// ============================================================================

/**
 * Spawn rg inside WSL via a setsid wrapper that records the pgid in a control
 * file. On child close, killProcessGroup cleans up the Linux rg so the grep
 * tool's matchCount>=limit early-kill does not orphan rg (§4.6 grep reuse).
 *
 * The wrapper probes `command -v rg` first; if rg is missing it prints an apt
 * install hint (containing the distro name) to stderr and exits 127, so the
 * grep tool's outer catch surfaces the hint instead of a bare "rg not found".
 *
 * The grep tool passes the Windows process env, which is not POSIX-safe; the
 * WSL rg uses the distro's default env, so env is intentionally not forwarded.
 */
function spawnWslRipgrep(
  runtime: WslRuntime,
  converter: WslPathConverter,
  controlCounter: { value: number },
  args: string[],
  cwd: string,
): ChildProcessWithoutNullStreams {
  const distro = converter.distro;
  const id = controlCounter.value++;
  const controlFile = `/tmp/pix-wsl/rg-${process.pid}-${id}.pgid`;
  const aptHint = `ripgrep (rg) is not installed in WSL distro "${distro}"; install it with: sudo apt install ripgrep`;
  // Share spawnBash's cached setsid probe (§4.6); when setsid is unavailable,
  // run rg without a new session so the command still executes instead of
  // failing 127. killProcessGroup already tries both kill -KILL -<pgid> and
  // kill -KILL <pid>, so the degraded (no-setsid) path is still cleaned up by
  // the direct-pid kill.
  const setsidLeader = runtime.isSetsidAvailable() ? 'setsid rg "$@" &' : 'rg "$@" &';
  // $1 = controlFile, $2 = aptHint, $3.. = rg args. rg args are passed as
  // independent argv ($@), never spliced into the wrapper string.
  const wrapper =
    'CTRL="$1"; HINT="$2"; shift 2; ' +
    'if ! command -v rg >/dev/null 2>&1; then printf "%s\\n" "$HINT" >&2; exit 127; fi; ' +
    `${setsidLeader} echo $! > "$CTRL"; wait $!; exit $?`;
  const child = runtime.spawn(
    ["bash", "-c", wrapper, "bash", controlFile, aptHint, ...args],
    { logicalCwd: cwd },
  );
  child.on("close", () => {
    void runtime.killProcessGroup(controlFile).catch(() => {
      // cleanup is best-effort; the orphan is bounded by keep-alive / VM lifecycle
    });
  });
  return child;
}

// ============================================================================
// find fd binary resolution
// ============================================================================

/** Probe fd then fdfind (Debian/Ubuntu) inside the distro; cached per op set. */
async function resolveFdBinary(
  runtime: WslRuntime,
  cache: { value: string | null | undefined },
): Promise<string | null> {
  if (cache.value !== undefined) return cache.value;
  for (const bin of ["fd", "fdfind"]) {
    const result = await runtime.run(
      ["bash", "-c", 'command -v "$1" 2>/dev/null', "bash", bin],
      { timeoutMs: 5000 },
    );
    if (result.exitCode === 0 && result.stdout.toString("utf8").trim()) {
      cache.value = bin;
      return bin;
    }
  }
  cache.value = null;
  return null;
}

// ============================================================================
// createWslFileOperations
// ============================================================================

export function createWslFileOperations(options: WslFileOperationsOptions): WslOperationSet {
  const { converter, runtime } = options;
  const distro = converter.distro;
  const rgControlCounter = { value: 0 };
  const fdCache = { value: undefined as string | null | undefined };

  const toPhysical = (logicalPath: string): string => {
    converter.assertLogicalPath(logicalPath);
    return converter.linuxToWindows(logicalPath);
  };

  const read: ReadOperations = {
    readFile: async (absolutePath) => {
      const physical = toPhysical(absolutePath);
      try {
        return await fsReadFile(physical);
      } catch (e) {
        throw toLogicalError(e, converter);
      }
    },
    access: async (absolutePath) => {
      const physical = toPhysical(absolutePath);
      try {
        await fsAccess(physical, constants.R_OK);
      } catch (e) {
        throw toLogicalError(e, converter);
      }
    },
    detectImageMimeType: async (absolutePath) => {
      const physical = toPhysical(absolutePath);
      return detectImageMimeTypeFromPath(physical);
    },
  };

  const write: WriteOperations = {
    readFile: async (absolutePath) => {
      const physical = toPhysical(absolutePath);
      try {
        return await fsReadFile(physical);
      } catch (e) {
        throw toLogicalError(e, converter);
      }
    },
    writeFile: async (absolutePath, content) => {
      const physical = toPhysical(absolutePath);
      try {
        await fsWriteFile(physical, content, "utf-8");
      } catch (e) {
        throw toLogicalError(e, converter);
      }
    },
    mkdir: async (dir) => {
      converter.assertLogicalPath(dir);
      try {
        const result = await runtime.run(["mkdir", "-p", "--", dir], {
          timeoutMs: RUN_TIMEOUT_MS,
        });
        if (result.exitCode !== 0) {
          throw new Error(
            `mkdir failed for "${dir}" in WSL distro "${distro}": ${result.stderr.toString("utf8").trim()}`,
          );
        }
      } catch (e) {
        throw toLogicalError(e, converter);
      }
    },
  };

  const edit: EditOperations = {
    readFile: read.readFile,
    writeFile: write.writeFile,
    access: async (absolutePath) => {
      const physical = toPhysical(absolutePath);
      try {
        await fsAccess(physical, constants.R_OK | constants.W_OK);
      } catch (e) {
        throw toLogicalError(e, converter);
      }
    },
  };

  const find: FindOperations = {
    exists: async (absolutePath) => {
      const physical = toPhysical(absolutePath);
      try {
        await fsAccess(physical, constants.F_OK);
        return true;
      } catch {
        return false;
      }
    },
    glob: async (pattern, cwd, globOptions) => {
      converter.assertLogicalPath(cwd);
      const fdBin = await resolveFdBinary(runtime, fdCache);
      if (!fdBin) {
        throw new Error(
          `fd is not installed in WSL distro "${distro}"; install it with: sudo apt install fd-find`,
        );
      }
      const args = [
        "--glob",
        "--color=never",
        "--hidden",
        "--no-require-git",
        "--max-results",
        String(globOptions.limit),
      ];
      let effectivePattern = pattern;
      if (pattern.includes("/")) {
        args.push("--full-path");
        if (!pattern.startsWith("/") && !pattern.startsWith("**/") && pattern !== "**") {
          effectivePattern = `**/${pattern}`;
        }
      }
      args.push("--", effectivePattern, cwd);
      let result;
      try {
        result = await runtime.run([fdBin, ...args], {
          logicalCwd: cwd,
          timeoutMs: FD_TIMEOUT_MS,
        });
      } catch (e) {
        throw toLogicalError(e, converter);
      }
      if (result.exitCode !== null && result.exitCode !== 0 && result.exitCode !== 1) {
        throw new Error(
          `fd failed in WSL distro "${distro}": ${result.stderr.toString("utf8").trim()}`,
        );
      }
      const lines = result.stdout
        .toString("utf8")
        .split(/\r?\n/)
        .map((l) => l.replace(/\r$/, "").trim())
        .filter((l) => l.length > 0);
      // Guarantee absolute Linux paths regardless of fd's output format.
      return lines.map((l) => (pathPosix.isAbsolute(l) ? l : pathPosix.resolve(cwd, l)));
    },
  };

  const grep: GrepOperations = {
    isDirectory: async (absolutePath) => {
      const physical = toPhysical(absolutePath);
      try {
        const st = await fsStat(physical);
        return st.isDirectory();
      } catch (e) {
        throw toLogicalError(e, converter);
      }
    },
    readFile: async (absolutePath) => {
      converter.assertLogicalPath(absolutePath);
      // context > 0 reads use `wsl.exe -e cat` to avoid 9P content reads while
      // keeping getFileLines streaming (§4.7).
      let result;
      try {
        result = await runtime.run(["cat", absolutePath], { timeoutMs: RUN_TIMEOUT_MS });
      } catch (e) {
        throw toLogicalError(e, converter);
      }
      if (result.exitCode !== 0) {
        throw new Error(
          `Failed to read "${absolutePath}" in WSL distro "${distro}": ${result.stderr.toString("utf8").trim()}`,
        );
      }
      return result.stdout.toString("utf8");
    },
    spawnRipgrep: (args, cwd) =>
      spawnWslRipgrep(runtime, converter, rgControlCounter, args, cwd),
  };

  const ls: LsOperations = {
    exists: async (absolutePath) => {
      const physical = toPhysical(absolutePath);
      try {
        await fsAccess(physical, constants.F_OK);
        return true;
      } catch {
        return false;
      }
    },
    stat: async (absolutePath) => {
      const physical = toPhysical(absolutePath);
      try {
        return await fsStat(physical);
      } catch (e) {
        throw toLogicalError(e, converter);
      }
    },
    readdir: async (absolutePath) => {
      const physical = toPhysical(absolutePath);
      try {
        return await fsReaddir(physical);
      } catch (e) {
        throw toLogicalError(e, converter);
      }
    },
    readdirWithTypes: async (absolutePath) => {
      const physical = toPhysical(absolutePath);
      try {
        const entries = await fsReaddir(physical, { withFileTypes: true });
        const result: Array<{ name: string; isDirectory: boolean }> = [];
        for (const entry of entries) {
          // Use the dirent type when known; fall back to lstat when d_type is
          // unavailable (9P may report DT_UNKNOWN). lstat (not stat) keeps
          // broken symlinks listable as non-directories.
          const typeKnown =
            entry.isDirectory() ||
            entry.isFile() ||
            entry.isSymbolicLink();
          let isDir = entry.isDirectory();
          if (!typeKnown) {
            try {
              isDir = (await fsLstat(pathWin32.join(physical, entry.name))).isDirectory();
            } catch {
              isDir = false;
            }
          }
          result.push({ name: entry.name, isDirectory: isDir });
        }
        return result;
      } catch (e) {
        throw toLogicalError(e, converter);
      }
    },
  };

  return { read, write, edit, grep, find, ls };
}
