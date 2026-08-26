/**
 * Pure markdown rendering of workflow artifacts for child injection.
 * Worker runtime and the host spawner share this function (`./artifact-render.js`);
 * it must never touch `node:fs` or AgentTask.
 */

import type { WorkflowArtifactPayload } from "./child-types.js";

/**
 * Render named artifact payloads as a markdown document. Structure is locked:
 * a top heading, then one `### name` section per payload with a json fence.
 */
export function renderWorkflowArtifacts(artifacts: ReadonlyArray<WorkflowArtifactPayload>): string {
  const sections = artifacts.map(
    (artifact) => `### ${artifact.name}\n\`\`\`json\n${JSON.stringify(artifact.value)}\n\`\`\``,
  );
  return `## Workflow artifacts\n${sections.join("\n")}`;
}
