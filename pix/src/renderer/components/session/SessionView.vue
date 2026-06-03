<script setup lang="ts">
/**
 * SessionView - Document-stream session display
 *
 * Renders display blocks as a flowing document.
 * Tool calls are aggregated into collapsible work-status blocks.
 */
import { ref } from "vue";
import type { DisplayBlock, ToolWorkItem } from "@/types/session";
import MessageBlock from "./MessageBlock.vue";
import ErrorBlock from "./ErrorBlock.vue";
import { marked } from "marked";

marked.setOptions({ breaks: true, gfm: true });

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

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function toolSummary(tools: ToolWorkItem[]): string {
  if (tools.length === 0) return "";
  const names = [...new Set(tools.map((t) => t.toolName || "task"))];
  return names.join(", ");
}

function resultText(result: unknown): string {
  if (result === null || result === undefined) return "";
  if (typeof result === "string") return result;
  if (Array.isArray(result)) {
    return result
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("");
  }
  return JSON.stringify(result, null, 2);
}

const props = defineProps<{
  blocks: DisplayBlock[];
}>();

const expandedWorkStatus = ref<Set<string>>(new Set());

function toggleExpand(blockId: string): void {
  const next = new Set(expandedWorkStatus.value);
  if (next.has(blockId)) next.delete(blockId);
  else next.add(blockId);
  expandedWorkStatus.value = next;
}
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

      <!-- Work Status - aggregated tool executions -->
      <div
        v-else-if="block.type === 'work-status'"
        class="work-status-block"
        :class="{ streaming: block.isStreaming }"
      >
        <button class="ws-header" @click="toggleExpand(block.id)">
          <span class="ws-icon">
            <span v-if="block.isStreaming" class="spinner"></span>
            <span v-else class="ws-dot done"></span>
          </span>
          <span class="ws-summary">
            <template v-if="block.isStreaming && block.tools.length === 0">AI 正在思考...</template>
            <template v-else-if="block.isStreaming">已运行 {{ block.tools.length }} 条命令...</template>
            <template v-else>已运行 {{ block.tools.length }} 条命令</template>
          </span>
          <span class="ws-tool-names">{{ toolSummary(block.tools) }}</span>
          <span class="ws-toggle">{{ expandedWorkStatus.has(block.id) ? '收起' : '展开' }}</span>
        </button>

        <div v-if="expandedWorkStatus.has(block.id)" class="ws-body">
          <div v-for="tool in block.tools" :key="tool.toolCallId" class="ws-tool-item" :class="{ error: tool.isError }">
            <div class="ws-tool-header">
              <span class="ws-tool-dot" :class="tool.isError ? 'err' : 'ok'"></span>
              <span class="ws-tool-name">{{ tool.toolName || 'task' }}</span>
            </div>
            <div v-if="tool.args" class="ws-tool-section">
              <div class="ws-tool-label">参数</div>
              <pre class="ws-tool-code">{{ JSON.stringify(tool.args, null, 2) }}</pre>
            </div>
            <div v-if="tool.result !== null" class="ws-tool-section">
              <div class="ws-tool-label">结果</div>
              <pre class="ws-tool-code">{{ resultText(tool.result) }}</pre>
            </div>
          </div>
        </div>
      </div>

      <!-- Error -->
      <ErrorBlock
        v-else-if="block.type === 'error'"
        :message="block.message"
        :source="block.source"
      />

      <!-- Compaction Notice -->
      <div v-else-if="block.type === 'compaction'" class="notice-block">
        <span v-if="block.aborted">上下文压缩已取消</span>
        <span v-else-if="block.result">上下文已压缩 ({{ block.reason }})</span>
        <span v-else>正在压缩上下文...</span>
      </div>

      <!-- Retry Notice -->
      <div v-else-if="block.type === 'retry'" class="notice-block" :class="{ 'notice-error': !block.success }">
        <span v-if="block.success">重试成功 (第 {{ block.attempt }} 次)</span>
        <span v-else-if="block.delayMs !== undefined">正在重试... (第 {{ block.attempt }}/{{ block.maxAttempts }} 次)</span>
        <span v-else>重试失败，已尝试 {{ block.attempt }} 次</span>
      </div>

      <!-- Status Indicator -->
      <div v-else-if="block.type === 'status'" class="notice-block" :class="block.status">
        <span v-if="block.status === 'running'">AI 开始工作</span>
        <span v-else-if="block.status === 'idle'">AI 已完成</span>
        <span v-else-if="block.status === 'error'">错误</span>
        <span v-else-if="block.status === 'compacting'">正在压缩上下文</span>
      </div>
    </template>
  </div>
</template>

<style scoped>
.session-view {
  max-width: var(--pix-content-max-width);
  margin: 0 auto;
}

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

.agent-content :deep(p) { margin-bottom: var(--pix-space-md); }
.agent-content :deep(p:last-child) { margin-bottom: 0; }
.agent-content :deep(ul), .agent-content :deep(ol) { margin: var(--pix-space-sm) 0; padding-left: var(--pix-space-xl); }
.agent-content :deep(li) { margin-bottom: var(--pix-space-xs); }
.agent-content :deep(h1), .agent-content :deep(h2), .agent-content :deep(h3), .agent-content :deep(h4) { margin: var(--pix-space-lg) 0 var(--pix-space-sm); font-weight: 600; }
.agent-content :deep(h1) { font-size: var(--pix-text-lg); }
.agent-content :deep(h2) { font-size: var(--pix-text-md); }
.agent-content :deep(h3) { font-size: var(--pix-text-base); }
.agent-content :deep(blockquote) { border-left: 3px solid var(--pix-border); padding-left: var(--pix-space-md); color: var(--pix-text-secondary); margin: var(--pix-space-md) 0; }
.agent-content :deep(table) { border-collapse: collapse; margin: var(--pix-space-md) 0; font-size: var(--pix-text-sm); }
.agent-content :deep(th), .agent-content :deep(td) { border: 1px solid var(--pix-border); padding: var(--pix-space-xs) var(--pix-space-md); text-align: left; }
.agent-content :deep(th) { background: var(--pix-bg-code); font-weight: 600; }
.agent-content :deep(hr) { border: none; border-top: 1px solid var(--pix-border-light); margin: var(--pix-space-lg) 0; }

/* Work Status Block */
.work-status-block {
  margin-bottom: var(--pix-space-md);
  border: 1px solid var(--pix-border);
  border-radius: var(--pix-radius-md);
  overflow: hidden;
  background: var(--pix-bg-content);
}

/* No extra gap between work-status and following agent reply */
.work-status-block + .agent-block {
  margin-top: 0;
}

.work-status-block.streaming {
  border-color: var(--pix-accent);
  box-shadow: 0 0 0 1px var(--pix-accent-light);
}

.ws-header {
  display: flex;
  align-items: center;
  gap: var(--pix-space-sm);
  width: 100%;
  padding: var(--pix-space-md);
  text-align: left;
  font-size: var(--pix-text-sm);
  background: var(--pix-bg-code);
  cursor: pointer;
  border: none;
  color: var(--pix-text-primary);
  font-family: var(--pix-font-ui);
  transition: background var(--pix-transition-fast);
}

.ws-header:hover {
  background: var(--pix-bg-hover);
}

.ws-icon {
  flex-shrink: 0;
  width: 16px;
  display: flex;
  align-items: center;
}

.ws-dot.done {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--pix-success);
}

.ws-summary {
  font-weight: 600;
  white-space: nowrap;
}

.work-status-block.streaming .ws-summary {
  color: var(--pix-accent);
}

.ws-tool-names {
  font-family: var(--pix-font-mono);
  font-size: var(--pix-text-xs);
  color: var(--pix-text-muted);
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.ws-toggle {
  font-size: var(--pix-text-xs);
  color: var(--pix-text-muted);
  flex-shrink: 0;
}

.ws-body {
  border-top: 1px solid var(--pix-border-light);
  padding: var(--pix-space-md);
  background: var(--pix-bg-content);
}

.ws-tool-item {
  border: 1px solid var(--pix-border-light);
  border-radius: var(--pix-radius-sm);
  padding: var(--pix-space-sm) var(--pix-space-md);
  margin-bottom: var(--pix-space-sm);
}

.ws-tool-item:last-child {
  margin-bottom: 0;
}

.ws-tool-item.error {
  border-color: #e8d0d0;
  background: var(--pix-error-bg);
}

.ws-tool-header {
  display: flex;
  align-items: center;
  gap: var(--pix-space-sm);
  margin-bottom: var(--pix-space-sm);
}

.ws-tool-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}

.ws-tool-dot.ok { background: var(--pix-success); }
.ws-tool-dot.err { background: var(--pix-error); }

.ws-tool-name {
  font-family: var(--pix-font-mono);
  font-size: var(--pix-text-xs);
  font-weight: 600;
  color: var(--pix-accent);
}

.ws-tool-section {
  margin-top: var(--pix-space-sm);
}

.ws-tool-label {
  font-size: var(--pix-text-xs);
  font-weight: 600;
  color: var(--pix-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: var(--pix-space-xs);
}

.ws-tool-code {
  font-family: var(--pix-font-mono);
  font-size: var(--pix-text-xs);
  line-height: var(--pix-leading-tight);
  background: var(--pix-bg-code);
  border: 1px solid var(--pix-border-light);
  border-radius: var(--pix-radius-sm);
  padding: var(--pix-space-sm) var(--pix-space-md);
  overflow-x: auto;
  max-height: 200px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--pix-text-primary);
}

/* Spinner */
.spinner {
  display: inline-block;
  width: 14px;
  height: 14px;
  border: 2px solid var(--pix-border);
  border-top-color: var(--pix-accent);
  border-radius: 50%;
  animation: pix-spin 0.6s linear infinite;
}

@keyframes pix-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

/* Notices */
.notice-block {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--pix-space-xs);
  padding: var(--pix-space-xs) 0;
  margin-bottom: var(--pix-space-md);
  font-size: var(--pix-text-xs);
  color: var(--pix-text-muted);
}

.notice-error { color: var(--pix-error); }
.notice-block.running { color: var(--pix-accent); }
.notice-block.error { color: var(--pix-error); }
</style>
