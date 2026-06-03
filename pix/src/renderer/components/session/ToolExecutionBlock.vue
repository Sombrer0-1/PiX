<script setup lang="ts">
/**
 * ToolExecutionBlock - Foldable tool execution display
 *
 * Shows tool name, arguments, and result in a collapsible card.
 * Green border for success, red for errors.
 */
import { ref, computed } from "vue";

const props = defineProps<{
  toolName: string;
  args: unknown;
  result: unknown;
  isError: boolean;
  isStreaming: boolean;
  timestamp: number;
}>();

const expanded = ref(false);

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

const resultText = computed(() => {
  if (props.result === null || props.result === undefined) {
    return props.isStreaming ? "Running..." : "No result";
  }

  if (typeof props.result === "string") {
    return props.result;
  }

  if (typeof props.result === "object" && props.result !== null) {
    const r = props.result as Record<string, unknown>;
    // Prettier display for common tool result fields
    if (typeof r.output === "string") {
      return r.output;
    }
    if (typeof r.content === "string") {
      return r.content;
    }
    return JSON.stringify(props.result, null, 2);
  }

  return String(props.result);
});

const argsSummary = computed(() => {
  if (!props.args || typeof props.args !== "object") {
    return "";
  }

  const a = props.args as Record<string, unknown>;
  const keys = Object.keys(a);
  if (keys.length === 0) return "";

  // Show first arg that's a string (usually the file path or command)
  const stringArgs = keys.filter((k) => typeof a[k] === "string");
  if (stringArgs.length === 1) {
    const val = a[stringArgs[0]] as string;
    return val.length > 80 ? val.slice(0, 80) + "..." : val;
  }

  // Show first key-value pair
  const first = stringArgs[0] || keys[0];
  const val = String(a[first]);
  return `${first}: ${val.length > 60 ? val.slice(0, 60) + "..." : val}`;
});

const mcpServer = computed(() => {
  const match = props.toolName.match(/^mcp__([^_]+(?:_[^_]+)*?)__/);
  return match ? match[1] : null;
});

function toggleExpand(): void {
  expanded.value = !expanded.value;
}
</script>

<template>
  <div class="tool-block" :class="{ error: isError, streaming: isStreaming }">
    <button class="tool-header" @click="toggleExpand">
      <span class="tool-icon">
        <span v-if="isStreaming" class="spinner"></span>
        <span v-else-if="isError" class="status-mark error-mark" aria-label="Failed"></span>
        <span v-else class="status-mark success-mark" aria-label="Succeeded"></span>
      </span>
      <span class="tool-name">{{ toolName }}</span>
      <span v-if="mcpServer" class="mcp-chip" :title="'MCP server: ' + mcpServer">MCP:{{ mcpServer }}</span>
      <span v-if="argsSummary" class="tool-args">{{ argsSummary }}</span>
      <span class="tool-time">{{ formatTime(timestamp) }}</span>
      <span class="tool-toggle">{{ expanded ? 'v' : '>' }}</span>
    </button>

    <div v-if="expanded" class="tool-body">
      <!-- Arguments -->
      <div v-if="args" class="tool-section">
        <div class="tool-section-label">Arguments</div>
        <pre class="tool-code">{{ JSON.stringify(args, null, 2) }}</pre>
      </div>

      <!-- Result -->
      <div class="tool-section">
        <div class="tool-section-label">Result</div>
        <pre class="tool-code">{{ resultText }}</pre>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tool-block {
  margin-bottom: var(--pix-space-md);
  border: 1px solid var(--pix-border-light);
  border-radius: var(--pix-radius-md);
  overflow: hidden;
}

.tool-block.error {
  border-color: #e8d0d0;
  background: var(--pix-error-bg);
}

.tool-block.streaming {
  border-color: var(--pix-border-focus);
}

.tool-header {
  display: flex;
  align-items: center;
  gap: var(--pix-space-sm);
  width: 100%;
  padding: var(--pix-space-sm) var(--pix-space-md);
  text-align: left;
  font-size: var(--pix-text-sm);
  background: var(--pix-bg-code);
  transition: background var(--pix-transition-fast);
}

.tool-header:hover {
  background: var(--pix-bg-hover);
}

.tool-icon {
  font-size: 10px;
  width: 14px;
  text-align: center;
  flex-shrink: 0;
}

.status-mark {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.success-mark {
  background: var(--pix-success);
}

.error-mark {
  background: var(--pix-error);
}

.tool-block.error .tool-icon {
  color: var(--pix-error);
}

.tool-block:not(.error) .tool-icon {
  color: var(--pix-success);
}

.tool-name {
  font-family: var(--pix-font-mono);
  font-size: var(--pix-text-xs);
  font-weight: 600;
  color: var(--pix-accent);
}

.mcp-chip {
  display: inline-block;
  font-size: 9px;
  font-weight: 600;
  font-family: var(--pix-font-mono);
  padding: 1px 5px;
  border-radius: 3px;
  background: rgba(0, 150, 136, 0.12);
  color: #00897b;
  white-space: nowrap;
  flex-shrink: 0;
}

.tool-args {
  font-family: var(--pix-font-mono);
  font-size: var(--pix-text-xs);
  color: var(--pix-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
}

.tool-time {
  font-size: var(--pix-text-xs);
  color: var(--pix-text-muted);
  font-family: var(--pix-font-mono);
}

.tool-toggle {
  font-size: 8px;
  color: var(--pix-text-muted);
  flex-shrink: 0;
}

.tool-body {
  padding: var(--pix-space-md);
  border-top: 1px solid var(--pix-border-light);
  background: var(--pix-bg-content);
}

.tool-section {
  margin-bottom: var(--pix-space-md);
}

.tool-section:last-child {
  margin-bottom: 0;
}

.tool-section-label {
  font-size: var(--pix-text-xs);
  font-weight: 600;
  color: var(--pix-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: var(--pix-space-xs);
}

.tool-code {
  font-family: var(--pix-font-mono);
  font-size: var(--pix-text-xs);
  line-height: var(--pix-leading-tight);
  background: var(--pix-bg-code);
  border: 1px solid var(--pix-border-light);
  border-radius: var(--pix-radius-sm);
  padding: var(--pix-space-sm) var(--pix-space-md);
  overflow-x: auto;
  max-height: 300px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--pix-text-primary);
}
</style>
