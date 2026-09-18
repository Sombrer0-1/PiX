<script setup lang="ts">
/**
 * JsonToolDetails - generic fallback renderer (Stage D, SDD §2.8).
 *
 * Args render as a key/value table (strings inline, other values single-line
 * truncated JSON); the result renders as normalized text, or as a
 * highlight.js JSON block when the raw result is itself an object. Purely
 * presentational: no store / IPC access.
 */
import { computed } from "vue";
import hljs from "highlight.js/lib/common";
import type { ToolWorkItem } from "@/types/session";
import { extractToolResultText, isRecord } from "./result";

const props = defineProps<{
  tool: ToolWorkItem;
}>();

interface ArgRow {
  key: string;
  value: string;
}

const VALUE_MAX_CHARS = 200;

function truncate(text: string, maxLength: number): string {
  const chars = Array.from(text);
  if (chars.length <= maxLength) return text;
  return `${chars.slice(0, maxLength).join("")}...`;
}

const argRows = computed<ArgRow[]>(() => {
  const args = props.tool.args;
  if (!isRecord(args)) return [];
  return Object.entries(args).map(([key, value]) => ({
    key,
    value: typeof value === "string" ? truncate(value, VALUE_MAX_CHARS) : truncate(JSON.stringify(value) ?? "undefined", VALUE_MAX_CHARS),
  }));
});

const argsIsPlainString = computed(() => typeof props.tool.args === "string");

const resultText = computed(() => extractToolResultText(props.tool.result));

/**
 * Structured results (records without a ToolResult content wrapper) highlight
 * as JSON instead of plain text. A live {content, details} wrapper must NOT
 * hit this path: it renders as its normalized text so live and replay produce
 * the same view (SDD §2.2).
 */
const resultIsObject = computed(
  () => isRecord(props.tool.result) && !("content" in props.tool.result),
);

const highlightedJson = computed(() =>
  resultIsObject.value
    ? hljs.highlight(JSON.stringify(props.tool.result, null, 2), { language: "json" }).value
    : "",
);

const argsString = computed(() =>
  typeof props.tool.args === "string" ? props.tool.args : JSON.stringify(props.tool.args, null, 2),
);
</script>

<template>
  <div class="td-json">
    <div v-if="argRows.length > 0" class="td-kv-table">
      <div v-for="row in argRows" :key="row.key" class="td-kv-row">
        <span class="td-kv-key">{{ row.key }}</span>
        <span class="td-kv-value">{{ row.value }}</span>
      </div>
    </div>
    <pre v-else-if="argsIsPlainString" class="td-pre">{{ argsString }}</pre>

    <pre
      v-if="resultText"
      class="td-pre td-hljs"
    ><code v-if="resultIsObject" v-html="highlightedJson"></code><template v-else>{{ resultText }}</template></pre>
  </div>
</template>

<style scoped>
.td-json {
  min-width: 0;
  font-size: var(--pix-text-xs);
}

.td-kv-table {
  border: 1px solid var(--pix-border-light);
  border-radius: var(--pix-radius-md);
  overflow: hidden;
  margin-top: var(--pix-space-sm);
}

.td-kv-row {
  display: flex;
  align-items: flex-start;
  gap: var(--pix-space-sm);
  padding: 3px var(--pix-space-sm);
  min-width: 0;
}

.td-kv-row + .td-kv-row {
  border-top: 1px solid var(--pix-border-light);
}

.td-kv-key {
  flex: 0 0 auto;
  max-width: 40%;
  font-family: var(--pix-font-mono);
  font-size: var(--pix-text-xs);
  color: var(--pix-text-secondary);
  text-align: right;
  overflow-wrap: anywhere;
}

.td-kv-value {
  flex: 1;
  min-width: 0;
  font-family: var(--pix-font-mono);
  font-size: var(--pix-text-xs);
  color: var(--pix-text-primary);
  overflow-wrap: anywhere;
}

.td-pre {
  font-family: var(--pix-font-mono);
  font-size: var(--pix-text-xs);
  line-height: var(--pix-leading-tight);
  background: var(--pix-bg-code);
  border: 1px solid var(--pix-border-light);
  border-radius: var(--pix-radius-md);
  padding: var(--pix-space-sm) var(--pix-space-md);
  margin-top: var(--pix-space-sm);
  overflow-x: auto;
  max-height: 200px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--pix-text-primary);
  min-width: 0;
}

/* Minimal highlight.js palette (no theme import: keep the renderer bundle lean). */
.td-hljs :deep(.hljs-attr),
.td-hljs :deep(.hljs-attribute),
.td-hljs :deep(.hljs-variable),
.td-hljs :deep(.hljs-template-variable) {
  color: #6254f3;
}

.td-hljs :deep(.hljs-string),
.td-hljs :deep(.hljs-regexp) {
  color: #047857;
}

.td-hljs :deep(.hljs-number),
.td-hljs :deep(.hljs-literal) {
  color: #b45309;
}

.td-hljs :deep(.hljs-keyword),
.td-hljs :deep(.hljs-selector-tag),
.td-hljs :deep(.hljs-built_in) {
  color: #dc2626;
}

.td-hljs :deep(.hljs-comment),
.td-hljs :deep(.hljs-quote) {
  color: var(--pix-text-muted);
}
</style>
