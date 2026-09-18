<script setup lang="ts">
/**
 * ToolCallDetails - dispatcher container for expanded tool call bodies
 * (Stage D, SDD §2.3).
 *
 * Replaces the old native <details> 参数/结果 blocks: each tool gets its own
 * rich view (SDD §2.1 table, exact name first then substring) with built-in
 * oversize collapsing. isError wraps everything in a red error frame with an
 * 「执行失败」 label row; a null result shows an inline running spinner.
 * `agent` / `workflow` / `ralph` never reach here (SessionView routes them
 * to SubagentToolView / WorkflowRunPanel above). Purely presentational.
 */
import { computed } from "vue";
import type { Component } from "vue";
import type { ToolWorkItem } from "@/types/session";
import EditToolDetails from "./EditToolDetails.vue";
import WriteToolDetails from "./WriteToolDetails.vue";
import BashToolDetails from "./BashToolDetails.vue";
import ReadFileToolDetails from "./ReadFileToolDetails.vue";
import SearchToolDetails from "./SearchToolDetails.vue";
import JsonToolDetails from "./JsonToolDetails.vue";
import { isRecord } from "./result";

const props = defineProps<{
  tool: ToolWorkItem;
}>();

function hasCommandArg(args: unknown): boolean {
  return (
    isRecord(args) &&
    (typeof args.command === "string" || typeof args.cmd === "string" || typeof args.script === "string")
  );
}

const viewComponent = computed<Component>(() => {
  const name = (props.tool.toolName || "").trim();
  const lower = name.toLowerCase();
  // Exact names first, then substring fallbacks — both in SDD §2.1 table order.
  switch (name) {
    case "edit":
      return EditToolDetails;
    case "write":
      return WriteToolDetails;
    case "bash":
      return BashToolDetails;
    case "read":
      return ReadFileToolDetails;
    case "grep":
    case "glob":
    case "find":
    case "ls":
      return SearchToolDetails;
  }
  if (lower.includes("edit")) return EditToolDetails;
  if (lower.includes("write")) return WriteToolDetails;
  // §2.1: the bash substring set (bash/command/run_) additionally requires a
  // command-like arg; otherwise the view would be empty — fall through.
  if ((lower.includes("bash") || lower.includes("command") || lower.includes("run_")) && hasCommandArg(props.tool.args)) {
    return BashToolDetails;
  }
  if (lower.includes("search") || lower.includes("grep") || lower.includes("glob")) return SearchToolDetails;
  return JsonToolDetails;
});

const isRunning = computed(() => props.tool.result === null || props.tool.result === undefined);
</script>

<template>
  <div class="td-root" :class="{ 'td-error': tool.isError }">
    <div v-if="tool.isError" class="td-error-label">执行失败</div>
    <div v-if="isRunning" class="td-running" role="status">
      <span class="td-spinner" aria-hidden="true"></span>
      <span>运行中...</span>
    </div>
    <component v-else :is="viewComponent" :tool="tool" />
  </div>
</template>

<style scoped>
.td-root {
  min-width: 0;
  padding-top: var(--pix-space-xs);
}

.td-root.td-error {
  border: 1px solid var(--pix-error-light);
  border-radius: var(--pix-radius-md);
  background: var(--pix-error-bg);
  padding: var(--pix-space-xs) var(--pix-space-sm);
}

.td-error-label {
  font-size: var(--pix-text-xs);
  font-weight: var(--pix-weight-semibold);
  color: var(--pix-error);
  padding: 2px 0;
}

.td-running {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 2px 0;
  font-size: var(--pix-text-xs);
  color: var(--pix-text-secondary);
}

.td-spinner {
  display: inline-block;
  width: 12px;
  height: 12px;
  border: 2px solid var(--pix-border-light);
  border-top-color: var(--pix-accent);
  border-radius: 50%;
  animation: td-spin 0.6s linear infinite;
}

@keyframes td-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

@media (prefers-reduced-motion: reduce) {
  .td-spinner {
    animation: none;
  }
}
</style>
