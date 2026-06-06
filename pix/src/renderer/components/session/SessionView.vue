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
const markdownRenderer = new marked.Renderer();
markdownRenderer.html = (html: string) => escapeHtml(html);

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
    const result = marked.parse(text, { async: false, renderer: markdownRenderer });
    if (typeof result !== "string") return text;
    return enhanceCodeBlocks(stripTrailingWhitespace(result));
  } catch {
    return escapeHtml(text);
  }
}

/**
 * Strip trailing <br> tags and empty trailing <p> blocks that marked
 * generates from trailing newlines in the source text.  Without this,
 * short AI responses appear with an unwanted blank line underneath.
 */
function stripTrailingWhitespace(html: string): string {
  return html
    .replace(/(<br\s*\/?>)+\s*<\/p>/gi, "</p>")
    .replace(/<p>\s*(<br\s*\/?>|\s|&nbsp;)*<\/p>\s*$/gi, "");
}

const codeCopyIcon =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
const codeCheckIcon =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"></polyline></svg>';

function enhanceCodeBlocks(html: string): string {
  return html
    .replace(/<pre><code([^>]*)>/g, `<div class="code-block"><button class="code-copy-btn" type="button" data-copy-code="true" title="复制代码" aria-label="复制代码">${codeCopyIcon}</button><pre><code$1>`)
    .replace(/<\/code><\/pre>/g, "</code></pre></div>");
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

function compactWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function truncate(text: string, maxLength: number): string {
  const chars = Array.from(text);
  if (chars.length <= maxLength) return text;
  return `${chars.slice(0, maxLength).join("")}...`;
}

function argsText(args: unknown): string {
  if (args === null || args === undefined) return "";
  if (typeof args === "string") return args;
  return JSON.stringify(args, null, 2);
}

function argsSummary(args: unknown): string {
  if (!args || typeof args !== "object") return truncate(compactWhitespace(argsText(args)), 90);

  const value = args as Record<string, unknown>;
  const preferredKeys = ["command", "cmd", "path", "file", "query", "pattern"];
  const key = preferredKeys.find((name) => typeof value[name] === "string") ??
    Object.keys(value).find((name) => typeof value[name] === "string");

  if (key) {
    return truncate(compactWhitespace(String(value[key])), 110);
  }

  return truncate(compactWhitespace(JSON.stringify(value)), 110);
}

interface DiffSummary {
  added: number;
  removed: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function getStringValue(value: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const item = value[key];
    if (typeof item === "string") return item;
  }
  return undefined;
}

function countContentLines(text: string | undefined): number {
  if (!text) return 0;
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!normalized) return 0;
  const trimmedEnd = normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
  return trimmedEnd ? trimmedEnd.split("\n").length : 0;
}

function countUnifiedDiff(text: string): DiffSummary {
  let added = 0;
  let removed = 0;
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  return { added, removed };
}

function hasDiff(diff: DiffSummary): boolean {
  return diff.added > 0 || diff.removed > 0;
}

function diffSummaryFromArgs(toolName: string, args: unknown): DiffSummary {
  if (!isRecord(args)) return { added: 0, removed: 0 };

  const lowerToolName = toolName.toLowerCase();
  if (lowerToolName.includes("write")) {
    const content = getStringValue(args, ["content", "contents", "text", "data"]);
    return { added: countContentLines(content), removed: 0 };
  }

  if (lowerToolName.includes("edit")) {
    // Current format: { path, edits: [{ oldText, newText }] }
    if (Array.isArray(args.edits)) {
      let added = 0;
      let removed = 0;
      for (const edit of args.edits) {
        if (isRecord(edit)) {
          if (typeof edit.oldText === "string") removed += countContentLines(edit.oldText);
          if (typeof edit.newText === "string") added += countContentLines(edit.newText);
        }
      }
      if (added || removed) return { added, removed };
    }
    // Legacy format: { old_string/new_string or oldText/newText at top level }
    const oldText = getStringValue(args, ["old_string", "oldString", "old_text", "oldText", "from"]);
    const newText = getStringValue(args, ["new_string", "newString", "new_text", "newText", "to"]);
    if (oldText !== undefined || newText !== undefined) {
      return {
        added: countContentLines(newText),
        removed: countContentLines(oldText),
      };
    }
  }

  return { added: 0, removed: 0 };
}

function diffSummaryFromResult(result: unknown): DiffSummary {
  // Tool details carry the authoritative post-execution diff. This matters for
  // write-overwrite calls, where args only show the new content and cannot know
  // how many old lines were removed.
  if (isRecord(result) && isRecord(result.details) && typeof result.details.diff === "string") {
    const fromDetails = countUnifiedDiff(result.details.diff);
    if (hasDiff(fromDetails)) return fromDetails;
  }

  // Fallback: parse unified diff from result text.
  const fromResultText = countUnifiedDiff(resultText(result));
  if (hasDiff(fromResultText)) return fromResultText;

  return { added: 0, removed: 0 };
}

function toolDiff(tool: ToolWorkItem): DiffSummary {
  if (tool.diff && hasDiff(tool.diff)) return tool.diff;

  const fromResult = diffSummaryFromResult(tool.result);
  if (hasDiff(fromResult)) return fromResult;

  const fromArgs = diffSummaryFromArgs(tool.toolName || "", tool.args);
  if (hasDiff(fromArgs)) return fromArgs;

  return { added: 0, removed: 0 };
}

function workDiff(tools: ToolWorkItem[]): DiffSummary {
  return tools.reduce<DiffSummary>(
    (total, tool) => {
      const diff = toolDiff(tool);
      total.added += diff.added;
      total.removed += diff.removed;
      return total;
    },
    { added: 0, removed: 0 }
  );
}

function resultPreview(result: unknown): string {
  return truncate(compactWhitespace(resultText(result)), 120);
}

const props = defineProps<{
  blocks: DisplayBlock[];
}>();

const expandedWorkStatus = ref<Set<string>>(new Set());
const expandedTools = ref<Set<string>>(new Set());

function toolKey(blockId: string, toolCallId: string): string {
  return `${blockId}:${toolCallId}`;
}

function toggleExpand(blockId: string): void {
  const next = new Set(expandedWorkStatus.value);
  if (next.has(blockId)) next.delete(blockId);
  else next.add(blockId);
  expandedWorkStatus.value = next;
}

function toggleTool(blockId: string, toolCallId: string): void {
  const key = toolKey(blockId, toolCallId);
  const next = new Set(expandedTools.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  expandedTools.value = next;
}

function isToolExpanded(blockId: string, toolCallId: string): boolean {
  return expandedTools.value.has(toolKey(blockId, toolCallId));
}

async function writeClipboardText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall back to a temporary textarea below.
  }

  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    textarea.style.pointerEvents = "none";
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    document.body.removeChild(textarea);
    return copied;
  } catch (err) {
    console.error("[SessionView] Copy failed:", err);
    return false;
  }
}

async function handleSessionClick(event: MouseEvent): Promise<void> {
  const target = event.target as HTMLElement | null;
  const button = target?.closest<HTMLButtonElement>("[data-copy-code='true']");
  if (!button) return;

  const wrapper = button.closest(".code-block");
  const code = wrapper?.querySelector("code");
  const text = code?.textContent ?? "";
  if (!text) return;

  const copied = await writeClipboardText(text);
  if (!copied) return;
  button.classList.add("copied");
  button.setAttribute("title", "已复制");
  button.setAttribute("aria-label", "已复制");
  button.innerHTML = codeCheckIcon;
  window.setTimeout(() => {
    button.classList.remove("copied");
    button.setAttribute("title", "复制代码");
    button.setAttribute("aria-label", "复制代码");
    button.innerHTML = codeCopyIcon;
  }, 1200);
}
</script>

<template>
  <div class="session-view" @click="handleSessionClick">
    <template v-for="block in blocks" :key="block.id">
      <!-- Turn separator -->
      <div
        v-if="block.type === 'turn-separator'"
        class="turn-separator"
        aria-hidden="true"
      ></div>

      <!-- User Message -->
      <MessageBlock
        v-else-if="block.type === 'user-message'"
        :text="block.text"
        :attachments="block.attachments || []"
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

      <!-- Thinking indicator - waits for the first assistant text or tool call -->
      <div
        v-else-if="block.type === 'thinking'"
        class="thinking-block"
      >
        <span class="thinking-spinner" aria-hidden="true"></span>
        <span>AI 正在思考...</span>
      </div>

      <!-- Vision preprocessing indicator -->
      <div
        v-else-if="block.type === 'vision-status'"
        class="vision-status-block"
        :class="block.status"
      >
        <span class="vision-status-icon" aria-hidden="true">
          <span v-if="block.status === 'running'" class="thinking-spinner"></span>
          <span v-else class="vision-dot"></span>
        </span>
        <span v-if="block.status === 'running'">
          眼睛模型正在看图 · {{ block.imageCount }} 张
        </span>
        <span v-else-if="block.status === 'success'">
          眼睛模型已看图 · {{ block.imageCount }} 张
        </span>
        <span v-else>
          眼睛模型看图失败，已按原流程继续
        </span>
      </div>

      <!-- Work Status - aggregated tool executions -->
      <div
        v-else-if="block.type === 'work-status'"
        class="work-status-block"
        :class="{ streaming: block.isStreaming, expanded: expandedWorkStatus.has(block.id) }"
      >
        <button class="ws-header" @click="block.tools.length > 0 && toggleExpand(block.id)">
          <span class="ws-icon">
            <span v-if="block.isStreaming" class="spinner"></span>
            <span v-else class="ws-dot done"></span>
          </span>
          <span class="ws-summary">
            <template v-if="block.isStreaming">已运行 {{ block.tools.length }} 条命令...</template>
            <template v-else>已运行 {{ block.tools.length }} 条命令</template>
          </span>
          <span class="ws-tool-names">{{ toolSummary(block.tools) }}</span>
          <span v-if="hasDiff(workDiff(block.tools))" class="ws-diff">
            <span class="diff-added">+{{ workDiff(block.tools).added }}</span>
            <span class="diff-removed">-{{ workDiff(block.tools).removed }}</span>
          </span>
          <span v-if="block.tools.length > 0" class="ws-toggle">{{ expandedWorkStatus.has(block.id) ? '收起' : '展开' }}</span>
        </button>

        <div v-if="expandedWorkStatus.has(block.id) && block.tools.length > 0" class="ws-body">
          <div v-for="tool in block.tools" :key="tool.toolCallId" class="ws-tool-item" :class="{ error: tool.isError }">
            <button class="ws-tool-header" @click="toggleTool(block.id, tool.toolCallId)">
              <span class="ws-tool-dot" :class="tool.isError ? 'err' : 'ok'"></span>
              <span class="ws-tool-name">{{ tool.toolName || 'task' }}</span>
              <span v-if="tool.args" class="ws-tool-preview">{{ argsSummary(tool.args) }}</span>
              <span v-else-if="tool.result !== null" class="ws-tool-preview">{{ resultPreview(tool.result) }}</span>
              <span v-if="hasDiff(toolDiff(tool))" class="ws-tool-diff">
                <span class="diff-added">+{{ toolDiff(tool).added }}</span>
                <span class="diff-removed">-{{ toolDiff(tool).removed }}</span>
              </span>
              <span class="ws-tool-toggle">{{ isToolExpanded(block.id, tool.toolCallId) ? '收起' : '展开' }}</span>
            </button>
            <div v-if="isToolExpanded(block.id, tool.toolCallId)" class="ws-tool-details">
              <details v-if="tool.args" class="ws-tool-section">
                <summary class="ws-tool-label">参数</summary>
                <pre class="ws-tool-code">{{ argsText(tool.args) }}</pre>
              </details>
              <details v-if="tool.result !== null" class="ws-tool-section">
                <summary class="ws-tool-label">结果</summary>
                <pre class="ws-tool-code">{{ resultText(tool.result) }}</pre>
              </details>
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

      <div v-else-if="block.type === 'note'" class="notice-block">
        <span>{{ block.text }}</span>
      </div>

      <!-- Status Indicator -->
      <div v-else-if="block.type === 'status'" class="notice-block" :class="block.status">
        <span v-if="block.status === 'error'">错误</span>
        <span v-else-if="block.status === 'compacting'">正在压缩上下文</span>
      </div>
    </template>
  </div>
</template>

<style scoped>
.session-view {
  max-width: var(--pix-content-max-width);
  margin: 0 auto;
  font-size: var(--pix-text-base);
  color: #000000;
}

.turn-separator {
  width: min(360px, 52%);
  height: 1px;
  margin: var(--pix-space-xl) auto var(--pix-space-lg);
  background: linear-gradient(90deg, transparent, var(--pix-border), transparent);
}

/* ── Agent message block ── */
.agent-block {
  margin-bottom: var(--pix-space-lg);
  animation: block-in 0.18s ease-out;
}

.agent-content {
  font-size: var(--pix-text-base);
  line-height: var(--pix-leading-relaxed);
  color: #000000;
  max-width: 100%;
}

.agent-content :deep(p) { margin-bottom: var(--pix-space-sm); }
.agent-content :deep(p:last-child) { margin-bottom: 0; }
.agent-content :deep(ul), .agent-content :deep(ol) { margin: var(--pix-space-sm) 0; padding-left: var(--pix-space-xl); }
.agent-content :deep(li) { margin-bottom: var(--pix-space-xs); }
.agent-content :deep(h1), .agent-content :deep(h2), .agent-content :deep(h3), .agent-content :deep(h4) { margin: var(--pix-space-lg) 0 var(--pix-space-sm); font-weight: var(--pix-weight-semibold); line-height: var(--pix-leading-tight); }
.agent-content :deep(h1) { font-size: var(--pix-text-xl); }
.agent-content :deep(h2) { font-size: var(--pix-text-lg); }
.agent-content :deep(h3) { font-size: var(--pix-text-md); }
.agent-content :deep(h4) { font-size: var(--pix-text-base); }
.agent-content :deep(blockquote) { border-left: 3px solid var(--pix-border); padding-left: var(--pix-space-md); color: var(--pix-text-secondary); margin: var(--pix-space-md) 0; }
.agent-content :deep(table) { border-collapse: collapse; margin: var(--pix-space-md) 0; font-size: var(--pix-text-sm); width: 100%; }
.agent-content :deep(th), .agent-content :deep(td) { border: 1px solid var(--pix-border-light); padding: var(--pix-space-xs) var(--pix-space-md); text-align: left; }
.agent-content :deep(th) { background: var(--pix-bg-code); font-weight: var(--pix-weight-semibold); }
.agent-content :deep(hr) { border: none; border-top: 1px solid var(--pix-border-light); margin: var(--pix-space-lg) 0; }
.agent-content :deep(strong) { font-weight: var(--pix-weight-semibold); }
.agent-content :deep(a) { color: var(--pix-accent); }
.agent-content :deep(code) {
  font-size: 0.94em;
}
.agent-content :deep(.code-block) {
  position: relative;
  margin: var(--pix-space-md) 0;
}
.agent-content :deep(.code-block pre) {
  margin: 0;
  padding: var(--pix-space-lg);
  padding-top: 38px;
  background: #f7f8fc;
  border-color: var(--pix-border-light);
  color: #000000;
  font-size: var(--pix-text-sm);
  line-height: 1.65;
}
.agent-content :deep(.code-block code) {
  font-size: inherit;
  color: inherit;
}
.agent-content :deep(.code-copy-btn) {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: var(--pix-radius-md);
  background: #ffffff;
  border: 1px solid var(--pix-border);
  color: var(--pix-text-secondary);
  box-shadow: var(--pix-shadow-xs);
}
.agent-content :deep(.code-copy-btn:hover) {
  color: var(--pix-text-primary);
  background: var(--pix-accent-light);
}
.agent-content :deep(.code-copy-btn.copied) {
  color: var(--pix-success);
  border-color: #bbf7d0;
}

.agent-content.streaming :deep(p:last-child::after) {
  content: '';
  display: inline-block;
  width: 6px;
  height: 14px;
  background: var(--pix-accent);
  margin-left: 2px;
  vertical-align: text-bottom;
  animation: cursor-blink 1s step-end infinite;
}

@keyframes cursor-blink {
  50% { opacity: 0; }
}

/* ── Thinking indicator ── */
.thinking-block {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  margin: 0 0 var(--pix-space-lg);
  padding: 6px 11px;
  border: 1px solid var(--pix-border-light);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.94);
  color: var(--pix-accent);
  font-size: var(--pix-text-xs);
  font-weight: var(--pix-weight-medium);
  animation: block-in 0.16s ease-out;
}

.thinking-spinner {
  width: 12px;
  height: 12px;
  border: 2px solid var(--pix-border-light);
  border-top-color: var(--pix-accent);
  border-radius: 50%;
  animation: pix-spin 0.7s linear infinite;
}

/* ── Work Status Block ── */
.vision-status-block {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  width: fit-content;
  max-width: 100%;
  margin: 0 0 var(--pix-space-md);
  padding: 6px 11px;
  border: 1px solid var(--pix-border-light);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.94);
  color: var(--pix-text-secondary);
  font-size: var(--pix-text-xs);
  font-weight: var(--pix-weight-medium);
  animation: block-in 0.16s ease-out;
}

.vision-status-block.running {
  color: var(--pix-accent);
  border-color: rgba(98, 84, 243, 0.22);
}

.vision-status-block.success {
  color: var(--pix-success);
  border-color: var(--pix-success-light);
}

.vision-status-block.error {
  color: var(--pix-error);
  border-color: var(--pix-error-light);
}

.vision-status-icon {
  width: 12px;
  height: 12px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.vision-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: currentColor;
}

.work-status-block {
  width: fit-content;
  max-width: 100%;
  margin-bottom: var(--pix-space-md);
  border: 1px solid var(--pix-border-light);
  border-radius: var(--pix-radius-lg);
  overflow: hidden;
  background: rgba(255, 255, 255, 0.95);
  box-shadow: var(--pix-shadow-xs);
  animation: block-in 0.16s ease-out;
  transition:
    border-color var(--pix-transition-fast),
    transform var(--pix-transition-fast),
    opacity var(--pix-transition-fast);
}

.work-status-block.expanded {
  width: min(760px, 100%);
  box-shadow: var(--pix-shadow-sm);
}

.work-status-block + .agent-block {
  margin-top: 0;
}

.work-status-block.streaming {
  border-color: var(--pix-border);
}

.ws-header {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 32px;
  padding: 6px 11px;
  text-align: left;
  font-size: var(--pix-text-xs);
  background: rgba(255, 255, 255, 0.96);
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
  width: 14px;
  display: flex;
  align-items: center;
}

.ws-dot.done {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--pix-success);
}

.ws-summary {
  font-weight: var(--pix-weight-medium);
  white-space: nowrap;
  font-size: var(--pix-text-xs);
}

.work-status-block.streaming .ws-summary {
  color: var(--pix-accent);
}

.ws-tool-names {
  font-family: var(--pix-font-mono);
  font-size: var(--pix-text-xs);
  color: var(--pix-text-secondary);
  flex: 0 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
  max-width: 360px;
}

.ws-diff,
.ws-tool-diff {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex-shrink: 0;
  padding: 1px 7px;
  border: 1px solid var(--pix-border-light);
  border-radius: 999px;
  background: var(--pix-bg-content);
  font-family: var(--pix-font-mono);
  font-size: 11px;
  font-weight: var(--pix-weight-semibold);
  line-height: 16px;
}

.diff-added {
  color: #047857;
  font-variant-numeric: tabular-nums;
}

.diff-removed {
  color: #dc2626;
  font-variant-numeric: tabular-nums;
}

.ws-toggle {
  font-size: var(--pix-text-xs);
  color: var(--pix-text-secondary);
  flex-shrink: 0;
  font-weight: var(--pix-weight-medium);
}

.ws-body {
  border-top: 1px solid var(--pix-border-light);
  padding: var(--pix-space-sm);
  background: #fbfcff;
}

.ws-tool-item {
  border: 1px solid var(--pix-border-light);
  border-radius: var(--pix-radius-md);
  overflow: hidden;
  margin-bottom: var(--pix-space-xs);
  background: var(--pix-bg-content);
  animation: tool-row-in 0.18s ease-out;
}

.ws-tool-item:last-child {
  margin-bottom: 0;
}

.ws-tool-item.error {
  border-color: var(--pix-error-light);
  background: var(--pix-error-bg);
}

.ws-tool-header {
  display: flex;
  align-items: center;
  gap: var(--pix-space-sm);
  width: 100%;
  min-height: 34px;
  padding: 6px 10px;
  text-align: left;
  color: var(--pix-text-primary);
}

.ws-tool-header:hover {
  background: var(--pix-bg-hover);
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
  font-weight: var(--pix-weight-semibold);
  color: var(--pix-accent);
  flex-shrink: 0;
}

.ws-tool-preview {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--pix-text-xs);
  color: var(--pix-text-secondary);
}

.ws-tool-toggle {
  flex-shrink: 0;
  font-size: var(--pix-text-xs);
  color: var(--pix-text-secondary);
  font-weight: var(--pix-weight-medium);
}

.ws-tool-details {
  padding: 0 10px 10px;
  border-top: 1px solid var(--pix-border-light);
  background: rgba(255, 255, 255, 0.86);
}

.ws-tool-section {
  margin-top: var(--pix-space-sm);
}

.ws-tool-label {
  font-size: var(--pix-text-xs);
  font-weight: var(--pix-weight-semibold);
  color: var(--pix-text-secondary);
  text-transform: uppercase;
  letter-spacing: 0;
  margin-bottom: var(--pix-space-xs);
  cursor: pointer;
  user-select: none;
}

.ws-tool-code {
  font-family: var(--pix-font-mono);
  font-size: var(--pix-text-xs);
  line-height: var(--pix-leading-tight);
  background: var(--pix-bg-code);
  border: 1px solid var(--pix-border-light);
  border-radius: var(--pix-radius-md);
  padding: var(--pix-space-sm) var(--pix-space-md);
  overflow-x: auto;
  max-height: 200px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--pix-text-primary);
}

/* ── Spinner ── */
.spinner {
  display: inline-block;
  width: 12px;
  height: 12px;
  border: 2px solid var(--pix-border-light);
  border-top-color: var(--pix-accent);
  border-radius: 50%;
  animation: pix-spin 0.6s linear infinite;
}

@keyframes pix-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

@keyframes block-in {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@keyframes tool-row-in {
  from {
    opacity: 0;
    transform: translateY(3px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

/* ── Notice blocks ── */
.notice-block {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--pix-space-xs);
  padding: var(--pix-space-sm) 0;
  margin-bottom: var(--pix-space-lg);
  font-size: var(--pix-text-xs);
  color: var(--pix-text-muted);
  font-weight: var(--pix-weight-medium);
}

.notice-error { color: var(--pix-error); }
.notice-block.running { color: var(--pix-accent); }
.notice-block.error { color: var(--pix-error); }
</style>
