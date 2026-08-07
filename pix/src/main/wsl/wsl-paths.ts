/**
 * WSL path conversion primitives.
 *
 * Pure-string Linux <-> Windows path converter bound to a single WSL2 distro.
 * Implements the fixed conversion rules in wsl_plan.md §4.5:
 *   - /<automountRoot>/<single ASCII letter>/  -> Windows drive (e.g. /mnt/c -> C:\)
 *   - other absolute POSIX paths               -> UNC \\wsl.localhost\<distro>\...
 *   - /mnt/wsl, /mnt/wslg and other multi-letter mounts do NOT get drive
 *     special-casing; they fall through to UNC.
 *   - reverse: Windows drive -> /mnt/<lowercase-drive>/
 *   - reverse: same-distro UNC (\\wsl.localhost or legacy \\wsl$) -> POSIX
 *   - cross-distro UNC throws
 *   - automount disabled -> /mnt access raises an actionable error; never
 *     fabricates a UNC.
 *
 * wslpath is NOT used here; it is a fallback for S5 operations only and never
 * runs on the normal hot path.
 */

import { posix as pathPosix } from "node:path";

export interface WslPathContext {
  distro: string;
  home: string;
  automountRoot: string;
  automountEnabled: boolean;
}

const WSL_LOCALHOST_HOST = "wsl.localhost";
const WSL_LEGACY_HOST = "wsl$";

interface ParsedUnc {
  host: typeof WSL_LOCALHOST_HOST | typeof WSL_LEGACY_HOST;
  distro: string;
  /** Backslash-prefixed remainder after the distro segment, e.g. "\\home\\u" or "". */
  rest: string;
}

/** Normalize an automount root to a POSIX absolute form without trailing slash (e.g. "/mnt"). */
function normalizeAutomountRoot(root: string): string {
  let r = root.trim();
  if (!r) return "/mnt";
  if (!r.startsWith("/")) r = "/" + r;
  r = r.replace(/\/+$/, "");
  return r;
}

/**
 * Match the leading `/<root>/<letter>(/...)?` automount drive prefix.
 * The first segment after the root must be exactly one ASCII letter; multi-letter
 * mounts (wsl, wslg, ...) do not match and fall through to UNC.
 */
function matchAutomountDrive(
  normalizedPath: string,
  automountRoot: string,
): { drive: string; rest: string } | null {
  const prefix = `${automountRoot}/`;
  if (!normalizedPath.startsWith(prefix)) return null;
  const remainder = normalizedPath.slice(prefix.length);
  const slashIdx = remainder.indexOf("/");
  const firstSeg = slashIdx < 0 ? remainder : remainder.slice(0, slashIdx);
  if (firstSeg.length !== 1 || !/[A-Za-z]/.test(firstSeg)) return null;
  const rest = slashIdx < 0 ? "" : remainder.slice(slashIdx + 1);
  return { drive: firstSeg, rest };
}

/** Parse a \\wsl.localhost\<distro>\... or legacy \\wsl$\<distro>\... UNC path. */
function parseWslUnc(input: string): ParsedUnc | null {
  const match = /^\\\\(wsl\.localhost|wsl\$)\\([^\\]+)(\\[\s\S]*)?$/.exec(input);
  if (!match) return null;
  const host = match[1] as ParsedUnc["host"];
  const distro = match[2]!;
  const rest = match[3] ?? "";
  return { host, distro, rest };
}

export class WslPathConverter {
  private readonly _distro: string;
  private readonly _home: string;
  private readonly _automountRoot: string;
  private readonly _automountEnabled: boolean;

  constructor(context: WslPathContext) {
    this._distro = context.distro;
    this._home = context.home;
    this._automountRoot = normalizeAutomountRoot(context.automountRoot);
    this._automountEnabled = context.automountEnabled;
  }

  get distro(): string {
    return this._distro;
  }

  get home(): string {
    return this._home;
  }

  get automountRoot(): string {
    return this._automountRoot;
  }

  get automountEnabled(): boolean {
    return this._automountEnabled;
  }

  /**
   * Convert an absolute POSIX path to a Windows-accessible path.
   * /<automountRoot>/<drive>/... maps to a Windows drive path; every other
   * absolute POSIX path maps to UNC. Throws when automount is disabled and the
   * path is under the automount root (no UNC fallback is fabricated).
   */
  linuxToWindows(linuxPath: string): string {
    if (!pathPosix.isAbsolute(linuxPath)) {
      throw new Error(
        `Cannot convert relative POSIX path "${linuxPath}" to Windows; expected an absolute path.`,
      );
    }
    const normalized = pathPosix.normalize(linuxPath);
    const drive = matchAutomountDrive(normalized, this._automountRoot);
    if (drive) {
      if (!this._automountEnabled) {
        throw new Error(
          `WSL automount is disabled; cannot access "${linuxPath}" under "${this._automountRoot}". ` +
            `Enable automount or use a path inside the distro (e.g. /home/...).`,
        );
      }
      const driveLetter = drive.drive.toUpperCase();
      if (!drive.rest) return `${driveLetter}:\\`;
      return `${driveLetter}:\\${drive.rest.split("/").join("\\")}`;
    }
    // Native ext4 path -> UNC. Strip the leading slash and join segments with backslashes.
    const relative = normalized.slice(1);
    if (!relative) return `\\\\${WSL_LOCALHOST_HOST}\\${this._distro}`;
    return `\\\\${WSL_LOCALHOST_HOST}\\${this._distro}\\${relative.split("/").join("\\")}`;
  }

  /**
   * Convert a Windows path (drive or UNC) to a POSIX path inside the active distro.
   * Same-distro UNC (\\wsl.localhost or legacy \\wsl$) strips the distro prefix;
   * cross-distro UNC throws. Drive paths require automount to be enabled.
   */
  windowsToLinux(windowsPath: string): string {
    const unc = parseWslUnc(windowsPath);
    if (unc) {
      if (unc.distro !== this._distro) {
        throw new Error(
          `Path "${windowsPath}" belongs to WSL distro "${unc.distro}", but the active distro is "${this._distro}". ` +
            `Cross-distro access is not supported.`,
        );
      }
      if (!unc.rest) return "/";
      const posix = unc.rest.replace(/^\\+/, "").replace(/\\/g, "/");
      return "/" + posix;
    }
    const driveMatch = /^([A-Za-z]):[\\/](.*)$/.exec(windowsPath);
    if (driveMatch) {
      if (!this._automountEnabled) {
        throw new Error(
          `WSL automount is disabled; cannot map Windows drive "${windowsPath}" to a POSIX path. ` +
            `Enable automount or use a path inside the distro.`,
        );
      }
      const driveLetter = driveMatch[1]!.toLowerCase();
      const rest = driveMatch[2]!;
      if (!rest) return `${this._automountRoot}/${driveLetter}`;
      const posixRest = rest.replace(/\\/g, "/");
      return `${this._automountRoot}/${driveLetter}/${posixRest}`.replace(/\/+$/, "");
    }
    throw new Error(
      `Cannot convert Windows path "${windowsPath}" to a POSIX path; ` +
        `expected a drive path (C:\\...) or UNC (\\\\${WSL_LOCALHOST_HOST}\\<distro>\\... or \\\\${WSL_LEGACY_HOST}\\<distro>\\...).`,
    );
  }

  /**
   * Reject Windows drive/UNC input in WSL file tools. Logical POSIX input passes.
   * Same-distro UNC is also rejected here: file tools consume logical paths only.
   */
  assertLogicalPath(path: string): void {
    if (/^[A-Za-z]:/.test(path) || path.startsWith("\\\\")) {
      throw new Error(
        `Windows path "${path}" is not allowed in WSL mode; use a POSIX path such as /home/<user>/... or /mnt/<drive>/...`,
      );
    }
  }

  /**
   * Reject UNC paths that reference a different distro. Same-distro UNC and
   * non-UNC paths pass.
   */
  assertSameDistro(path: string): void {
    const unc = parseWslUnc(path);
    if (unc && unc.distro !== this._distro) {
      throw new Error(
        `Path "${path}" belongs to WSL distro "${unc.distro}", but the active distro is "${this._distro}". ` +
          `Cross-distro access is not supported.`,
      );
    }
  }

  /**
   * Return a model-visible logical path. POSIX input is returned unchanged;
   * Windows drive/UNC input is converted via windowsToLinux.
   */
  displayPath(path: string): string {
    if (path.startsWith("/")) return path;
    return this.windowsToLinux(path);
  }
}
