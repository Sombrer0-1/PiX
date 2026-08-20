/**
 * Main-only workspace identity for agent tasks (design plan section 4.4/4.7).
 *
 * `workspaceIdOf` derives a stable per-project id from the project's physical
 * path, using exactly the same hashing as team-persistence.ts
 * (`createHash("sha1").update(path).digest("hex")`): UTF-8 string input,
 * lowercase hex output. Node crypto stays in the main layer so shared leaves
 * never depend on it.
 */

import { createHash } from "crypto";

/**
 * Stable workspace id for the given physical project path. Identical to the
 * team-state directory hash in team-persistence.ts, so agent-task storage
 * (`<agentDir>/agent-tasks/<workspaceId>/`) can share the id namespace.
 */
export function workspaceIdOf(physicalPath: string): string {
  return createHash("sha1").update(physicalPath).digest("hex");
}
