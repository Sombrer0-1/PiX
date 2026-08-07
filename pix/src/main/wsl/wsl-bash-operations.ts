/**
 * WSL bash operations adapter.
 *
 * Adapts the SDK's BashOperations.exec contract to WslRuntime.spawnBash per
 * wsl_plan.md §4.6. Each command runs as an independent
 * `wsl.exe -d <distro> --cd <logicalCwd> -e bash -c <command>` invocation via
 * the runtime's setsid wrapper; the command is passed as an independent argv
 * ($1), never string-concatenated with cwd/distro/shell fragments.
 *
 * The bash tool always supplies a Windows-side env (getShellEnv(), containing
 * PATH/USERPROFILE and drive paths). The runtime's env overlay only accepts
 * explicit POSIX-safe key=value pairs and rejects PATH/HOME/USERPROFILE plus
 * drive/UNC values (§4.6). Forwarding the Windows env would therefore throw on
 * every command. WSL bash instead uses the distro's non-login default
 * environment (bash -c, not -lc), which is the intended semantics; the env
 * overlay remains available for explicit POSIX-safe callers.
 *
 * The BashOperations `timeout` is in seconds (matching createLocalBashOperations,
 * which multiplies by 1000); the runtime's spawnBash treats timeout as
 * milliseconds, so the adapter converts. On abort the runtime resolves with
 * exitCode null; the adapter re-throws "aborted" so the bash tool surfaces the
 * same "Command aborted" status as the local backend. On pure timeout (not
 * abort) the runtime sets a timedOut flag; the adapter throws
 * "timeout:<seconds>" so the bash tool renders "Command timed out", matching
 * createLocalBashOperations. Abort takes precedence over timeout.
 */

import type { BashOperations } from "@earendil-works/pi-coding-agent";
import type { WslRuntime } from "./wsl-runtime.js";

const DEFAULT_TIMEOUT_SECONDS = 120;

export function createWslBashOperations(options: {
  runtime: WslRuntime;
  logicalCwd: string;
}): BashOperations {
  const { runtime, logicalCwd } = options;
  return {
    exec: async (command, cwd, opts) => {
      const timeoutSeconds = opts.timeout ?? DEFAULT_TIMEOUT_SECONDS;
      const timeoutMs = timeoutSeconds > 0 ? timeoutSeconds * 1000 : undefined;
      const result = await runtime.spawnBash(command, cwd || logicalCwd, {
        onData: opts.onData,
        signal: opts.signal,
        timeout: timeoutMs,
      });
      if (opts.signal?.aborted) {
        throw new Error("aborted");
      }
      if (result.timedOut) {
        throw new Error("timeout:" + timeoutSeconds);
      }
      return result;
    },
  };
}
