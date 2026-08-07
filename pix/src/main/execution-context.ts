/**
 * Project execution context: resolves a serializable ProjectLocation into the
 * dual cwd + execution backend used to start an AgentSession.
 *
 * Per wsl_plan.md §4.3:
 *   - Windows context: backend/override undefined, isWsl=false, logicalCwd ===
 *     physicalCwd.
 *   - WSL context: validate distro (explicit, version 2), `test -d` the logical
 *     cwd, and verify the physical directory BEFORE creating the backend. The
 *     default distro is never substituted; the caller-supplied distro name is
 *     used verbatim.
 *   - createProjectExecutionContext statically imports createWslExecutionBackend
 *     (S6 hard-depends on S5).
 *
 * The optional `hooks` argument mirrors the WslRuntimeHooks /
 * WslExecutionBackendHooks pattern: it is an internal injection point for
 * tests, not part of the public contract, and omitted in production.
 */

import { existsSync, statSync } from "node:fs";
import { posix as pathPosix, win32 as pathWin32 } from "node:path";
import type {
  ExecutionBackend,
  RuntimeEnvironmentContext,
} from "@earendil-works/pi-coding-agent";
import type {
  ProjectLocation,
  ProjectLocationInput,
} from "../shared/project-location.js";
import { WslPathConverter } from "./wsl/wsl-paths.js";
import {
  WslDistroResolver,
  type WslAutomountConfig,
} from "./wsl/wsl-distro.js";
import { createWslExecutionBackend } from "./wsl/wsl-execution-backend.js";

export interface ProjectExecutionContext {
  readonly location: ProjectLocation;
  readonly logicalCwd: string;
  readonly physicalCwd: string;
  readonly executionBackend?: ExecutionBackend;
  readonly runtimeEnvironmentOverride?: Partial<RuntimeEnvironmentContext>;
  /** Explicit marker for MCP allowStdio decisions; not inferred from backend existence. */
  readonly isWsl: boolean;
}

/**
 * Internal injection points for testing. Not part of the public contract; the
 * second argument of createProjectExecutionContext is optional and omitted in
 * production. Mirrors the WslExecutionBackendHooks pattern.
 */
export interface ProjectExecutionContextHooks {
  /** Override the WSL distro resolver (default: new WslDistroResolver()). */
  resolver?: WslDistroResolver;
  /** Override the backend factory (default: createWslExecutionBackend). */
  createBackend?: typeof createWslExecutionBackend;
  /**
   * Skip backend creation and the physical-directory/`test -d` probes that
   * require a real distro; returns a context with executionBackend undefined.
   * For unit tests that only assert location resolution and the isWsl marker.
   */
  skipBackend?: boolean;
}

/**
 * Resolve a ProjectLocationInput into a serializable ProjectLocation.
 *
 * Windows input MUST supply an absolute physicalPath (logicalPath, when given,
 * must equal it). WSL input MUST supply an explicit distro and an absolute POSIX
 * logicalPath; the physicalPath is derived via the WslPathConverter when absent,
 * and when both are present they must round-trip equal. Relative logical paths,
 * cross-distro UNC, and Windows drive/UNC inputs are rejected.
 *
 * Throws on invalid input or when the distro is missing/not version 2. Never
 * falls back to the default distro.
 */
export async function resolveProjectLocation(
  input: ProjectLocationInput,
  resolver?: WslDistroResolver,
): Promise<ProjectLocation> {
  const env = input.environment;

  if (env.kind === "windows") {
    const physicalPath = input.physicalPath ?? input.logicalPath;
    if (!physicalPath) {
      throw new Error(
        "Windows project requires an absolute physicalPath (or logicalPath).",
      );
    }
    if (!pathWin32.isAbsolute(physicalPath)) {
      throw new Error(
        `Windows project requires an absolute physical path; got "${physicalPath}".`,
      );
    }
    if (input.logicalPath && input.logicalPath !== physicalPath) {
      throw new Error(
        `Windows project logicalPath must equal physicalPath; got logical="${input.logicalPath}", physical="${physicalPath}".`,
      );
    }
    const name = input.name ?? pathWin32.basename(physicalPath);
    return { path: physicalPath, physicalPath, name, environment: env };
  }

  // WSL: explicit distro is mandatory; never substitute the default.
  if (!env.distro) {
    throw new Error(
      "WSL project requires an explicit distro; the default distro is never substituted.",
    );
  }
  if (!input.logicalPath) {
    throw new Error("WSL project requires an absolute POSIX logicalPath.");
  }
  if (!pathPosix.isAbsolute(input.logicalPath)) {
    throw new Error(
      `WSL project requires an absolute POSIX logical path; got "${input.logicalPath}".`,
    );
  }

  const r = resolver ?? new WslDistroResolver();
  // Validate distro exists and is version 2; requireDistro never reads the
  // default marker to substitute the name.
  await r.requireDistro(env.distro);
  const home = await r.getHome(env.distro);
  const automount: WslAutomountConfig = await r.getAutomountConfig(env.distro);

  const converter = new WslPathConverter({
    distro: env.distro,
    home,
    automountRoot: automount.root,
    automountEnabled: automount.enabled,
  });

  const logicalPath = input.logicalPath;
  const derivedPhysical = converter.linuxToWindows(logicalPath);
  if (input.physicalPath && input.physicalPath !== derivedPhysical) {
    throw new Error(
      `WSL project physicalPath "${input.physicalPath}" does not match the converted ` +
        `logical path "${derivedPhysical}" for distro "${env.distro}".`,
    );
  }
  const physicalPath = input.physicalPath ?? derivedPhysical;
  const name = input.name ?? pathPosix.basename(logicalPath);
  return { path: logicalPath, physicalPath, name, environment: env };
}

/**
 * Create a ProjectExecutionContext from a resolved ProjectLocation.
 *
 * For Windows, returns a context with no backend and isWsl=false. For WSL,
 * re-validates the distro, asserts the logical cwd exists (`test -d`) and the
 * physical directory exists on the host (UNC/drive), then creates the WSL
 * execution backend. The physical-directory check uses Windows fs on the
 * physicalPath only; it never calls win32 fs on a Linux logical path.
 */
export async function createProjectExecutionContext(
  location: ProjectLocation,
  hooks?: ProjectExecutionContextHooks,
): Promise<ProjectExecutionContext> {
  if (location.environment.kind === "windows") {
    return {
      location,
      logicalCwd: location.path,
      physicalCwd: location.physicalPath,
      isWsl: false,
    };
  }

  const distro = location.environment.distro;
  const resolver = hooks?.resolver ?? new WslDistroResolver();

  if (hooks?.skipBackend) {
    return {
      location,
      logicalCwd: location.path,
      physicalCwd: location.physicalPath,
      isWsl: true,
    };
  }

  // Re-validate distro + WSL2 before touching the filesystem.
  await resolver.requireDistro(distro);
  // `test -d` the logical cwd inside the distro.
  await resolver.assertDirectory(distro, location.path);
  // Physical directory must exist on the host (UNC or drive); never call win32
  // fs on a Linux logical path.
  if (!existsSync(location.physicalPath) || !statSync(location.physicalPath).isDirectory()) {
    throw new Error(
      `Physical project directory "${location.physicalPath}" does not exist or is not a directory.`,
    );
  }

  const home = await resolver.getHome(distro);
  const automount: WslAutomountConfig = await resolver.getAutomountConfig(distro);
  const createBackend = hooks?.createBackend ?? createWslExecutionBackend;
  const backend = await createBackend({
    distro,
    logicalCwd: location.path,
    physicalCwd: location.physicalPath,
    home,
    automount,
  });

  return {
    location,
    logicalCwd: location.path,
    physicalCwd: location.physicalPath,
    executionBackend: backend,
    runtimeEnvironmentOverride: backend.runtimeEnvironment,
    isWsl: true,
  };
}

/**
 * Dispose a ProjectExecutionContext. Idempotent and null-safe. Only the context
 * owner calls this; borrowed references (Team workers) must not.
 */
export async function disposeProjectExecutionContext(
  context: ProjectExecutionContext | null,
): Promise<void> {
  if (!context) return;
  await context.executionBackend?.dispose?.();
}
