<script setup lang="ts">
/**
 * BashToolDetails - command + output renderer (Stage D, SDD §2.5).
 *
 * The command block ($ prefix, click-to-copy whole block) sits above the
 * output pre (normalized result text, max-height 240px). No exitCode chip:
 * non-zero exits arrive as isError + error text, never a details field.
 * Purely presentational.
 */
import { computed } from "vue";
import type { ToolWorkItem } from "@/types/session";
import { copyTextToClipboard, extractToolResultText, getStringValue, isRecord } from "./result";

const props = defineProps<{
  tool: ToolWorkItem;
}>();

const command = computed(() =>
  isRecord(props.tool.args) ? getStringValue(props.tool.args, ["command", "cmd", "script"]) ?? "" : "",
);

const output = computed(() => extractToolResultText(props.tool.result));

function copyCommand(): void {
  if (command.value) void copyTextToClipboard(command.value);
}
</script>

<template>
  <div class="td-bash">
    <pre v-if="command" class="td-bash-command" title="点击复制命令" @click="copyCommand"><span class="td-bash-prompt">$ </span>{{ command }}</pre>
    <pre v-if="output" class="td-bash-output">{{ output }}</pre>
  </div>
</template>

<style scoped>
.td-bash {
  min-width: 0;
}

.td-bash-command {
  font-family: var(--pix-font-mono);
  font-size: var(--pix-text-xs);
  line-height: var(--pix-leading-tight);
  background: var(--pix-bg-code);
  border: 1px solid var(--pix-border-light);
  border-radius: var(--pix-radius-md);
  padding: var(--pix-space-sm) var(--pix-space-md);
  margin-top: var(--pix-space-sm);
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--pix-text-primary);
  cursor: pointer;
  min-width: 0;
}

.td-bash-command:hover {
  border-color: rgba(98, 84, 243, 0.22);
}

.td-bash-prompt {
  color: var(--pix-accent);
  font-weight: var(--pix-weight-semibold);
  user-select: none;
}

.td-bash-output {
  font-family: var(--pix-font-mono);
  font-size: var(--pix-text-xs);
  line-height: var(--pix-leading-tight);
  background: rgba(255, 255, 255, 0.86);
  border: 1px solid var(--pix-border-light);
  border-radius: var(--pix-radius-md);
  padding: var(--pix-space-sm) var(--pix-space-md);
  margin-top: var(--pix-space-sm);
  overflow: auto;
  max-height: 240px;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--pix-text-primary);
  min-width: 0;
}
</style>
