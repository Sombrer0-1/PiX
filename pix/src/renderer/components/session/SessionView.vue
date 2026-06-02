<script setup lang="ts">
/**
 * SessionView - Document-stream session display
 *
 * Renders display blocks as a flowing document, not chat bubbles.
 */
import { computed } from "vue";
import type { DisplayBlock } from "@/types/session";
import MessageBlock from "./MessageBlock.vue";
import ToolExecutionBlock from "./ToolExecutionBlock.vue";
import ErrorBlock from "./ErrorBlock.vue";
import { marked } from "marked";

// Configure marked for safe rendering
marked.setOptions({
  breaks: true,
  gfm: true,
});

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderMarkdown(text: string): string {
  if (!text) return "&nbsp;";
  try {
    const result = marked.parse(escapeHtml(text), { async: false });
    return typeof result === "string" ? result : text;
  } catch {
    return escapeHtml(text);
  }
}

const props = defineProps<{
  blocks: DisplayBlock[];
}>();
</script>

<template>
  <div class="session-view">
    <template v-for="block in blocks" :key="block.id">
      <!-- User Message -->
      <MessageBlock
        v-if="block.type === 'user-message'"
        :text="block.text"
        :timestamp="block.timestamp"
      />

      <!-- Agent Message -->
      <div
        v-else-if="block.type === 'agent-message'"
        class="agent-block"
      >
        <div
          class="agent-content markdown-body"
          :class="{ streaming: block.isStreaming }"
          v-html="renderMarkdown(block.content)"
        ></div>
      </div>

      <!-- Tool Execution -->
      <ToolExecutionBlock
        v-else-if="block.type === 'tool-execution'"
        :tool-name="block.toolName"
        :args="block.args"
        :result="block.result"
        :is-error="block.isError"
        :is-streaming="block.isStreaming"
        :timestamp="block.timestamp"
      />

      <!-- Error -->
      <ErrorBlock
        v-else-if="block.type === 'error'"
        :message="block.message"
        :source="block.source"
      />

      <!-- Compaction Notice -->
      <div
        v-else-if="block.type === 'compaction'"
        class="compaction-notice"
      >
        <span v-if="block.aborted">Compaction aborted</span>
        <span v-else-if="block.result">Context compacted ({{ block.reason }})</span>
        <span v-else>Compacting context...</span>
      </div>

      <!-- Retry Notice -->
      <div
        v-else-if="block.type === 'retry'"
        class="retry-notice"
        :class="{ 'retry-failed': !block.success }"
      >
        <span v-if="block.success">Retry succeeded (attempt {{ block.attempt }})</span>
        <span v-else-if="block.delayMs !== undefined">Retrying... (attempt {{ block.attempt }}/{{ block.maxAttempts }})</span>
        <span v-else>Retry failed after {{ block.attempt }} attempt(s)</span>
      </div>

      <!-- Status Indicator -->
      <div
        v-else-if="block.type === 'status'"
        class="status-notice"
        :class="block.status"
      >
        <span v-if="block.status === 'running'">Agent started</span>
        <span v-else-if="block.status === 'idle'">Agent finished</span>
        <span v-else-if="block.status === 'error'">Error</span>
        <span v-else-if="block.status === 'compacting'">Compacting</span>
      </div>
    </template>
  </div>
</template>

<style scoped>
.session-view {
  max-width: var(--pix-content-max-width);
  margin: 0 auto;
}

/* Agent message block */
.agent-block {
  margin-bottom: var(--pix-space-xl);
  padding-left: var(--pix-space-md);
  border-left: 2px solid var(--pix-border-light);
}

.agent-content {
  font-size: var(--pix-text-md);
  line-height: var(--pix-leading-relaxed);
  color: var(--pix-text-primary);
}

.agent-content.streaming {
  /* Subtle indicator for streaming content */
}

.agent-content :deep(p) {
  margin-bottom: var(--pix-space-md);
}

.agent-content :deep(p:last-child) {
  margin-bottom: 0;
}

.agent-content :deep(ul),
.agent-content :deep(ol) {
  margin: var(--pix-space-sm) 0;
  padding-left: var(--pix-space-xl);
}

.agent-content :deep(li) {
  margin-bottom: var(--pix-space-xs);
}

.agent-content :deep(h1),
.agent-content :deep(h2),
.agent-content :deep(h3),
.agent-content :deep(h4) {
  margin: var(--pix-space-lg) 0 var(--pix-space-sm);
  font-weight: 600;
}

.agent-content :deep(h1) { font-size: var(--pix-text-lg); }
.agent-content :deep(h2) { font-size: var(--pix-text-md); }
.agent-content :deep(h3) { font-size: var(--pix-text-base); }

.agent-content :deep(blockquote) {
  border-left: 3px solid var(--pix-border);
  padding-left: var(--pix-space-md);
  color: var(--pix-text-secondary);
  margin: var(--pix-space-md) 0;
}

.agent-content :deep(table) {
  border-collapse: collapse;
  margin: var(--pix-space-md) 0;
  font-size: var(--pix-text-sm);
}

.agent-content :deep(th),
.agent-content :deep(td) {
  border: 1px solid var(--pix-border);
  padding: var(--pix-space-xs) var(--pix-space-md);
  text-align: left;
}

.agent-content :deep(th) {
  background: var(--pix-bg-code);
  font-weight: 600;
}

.agent-content :deep(hr) {
  border: none;
  border-top: 1px solid var(--pix-border-light);
  margin: var(--pix-space-lg) 0;
}

/* Status notices */
.compaction-notice,
.retry-notice,
.status-notice {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--pix-space-xs);
  padding: var(--pix-space-xs) 0;
  margin-bottom: var(--pix-space-md);
  font-size: var(--pix-text-xs);
  color: var(--pix-text-muted);
}

.retry-notice.retry-failed {
  color: var(--pix-error);
}

.status-notice.running {
  color: var(--pix-accent);
}

.status-notice.error {
  color: var(--pix-error);
}
</style>
