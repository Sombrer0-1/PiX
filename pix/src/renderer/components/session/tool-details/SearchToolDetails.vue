<script setup lang="ts">
/**
 * SearchToolDetails - hit-list renderer for grep/glob/find/ls style tools
 * (Stage D, SDD §2.7). The pattern/query/glob argument renders as a mono
 * chip; each non-empty result line is one hit (mono, truncated ellipsis).
 * More than 50 lines collapse to a "N 条命中" count with an expand button.
 * Purely presentational.
 */
import { computed, ref } from "vue";
import type { ToolWorkItem } from "@/types/session";
import { copyTextToClipboard, extractToolResultText, getStringValue, isRecord, splitLines } from "./result";

const props = defineProps<{
  tool: ToolWorkItem;
}>();

const HIT_COLLAPSE_THRESHOLD = 50;

const argsRecord = computed(() => (isRecord(props.tool.args) ? props.tool.args : null));

const pattern = computed(() =>
  argsRecord.value ? getStringValue(argsRecord.value, ["pattern", "query", "glob"]) ?? "" : "",
);

const hits = computed(() => splitLines(extractToolResultText(props.tool.result)).filter((line) => line.trim() !== ""));

const expanded = ref(false);

const collapsed = computed(() => hits.value.length > HIT_COLLAPSE_THRESHOLD && !expanded.value);

function copyPattern(): void {
  if (pattern.value) void copyTextToClipboard(pattern.value);
}
</script>

<template>
  <div class="td-search">
    <button v-if="pattern" type="button" class="td-chip td-pattern-chip" title="点击复制" @click="copyPattern">
      {{ pattern }}
    </button>
    <div v-if="collapsed" class="td-hits-summary">
      <span>{{ hits.length }} 条命中</span>
      <button type="button" class="td-expand" @click="expanded = true">展开</button>
    </div>
    <template v-else-if="hits.length > 0">
      <div class="td-hits">
        <div v-for="(hit, index) in hits" :key="index" class="td-hit" :title="hit">{{ hit }}</div>
      </div>
      <button v-if="hits.length > HIT_COLLAPSE_THRESHOLD" type="button" class="td-expand" @click="expanded = false">
        收起
      </button>
    </template>
  </div>
</template>

<style scoped>
.td-search {
  min-width: 0;
}

.td-chip {
  font-family: var(--pix-font-mono);
  font-size: var(--pix-text-xs);
  color: var(--pix-text-secondary);
  background: var(--pix-bg-code);
  border: 1px solid var(--pix-border-light);
  border-radius: 999px;
  padding: 1px 8px;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}

.td-chip:hover {
  color: var(--pix-accent);
  border-color: rgba(98, 84, 243, 0.22);
}

.td-hits-summary {
  display: flex;
  align-items: center;
  gap: var(--pix-space-sm);
  margin-top: var(--pix-space-sm);
  font-size: var(--pix-text-xs);
  color: var(--pix-text-secondary);
}

.td-hits {
  margin-top: var(--pix-space-sm);
  border: 1px solid var(--pix-border-light);
  border-radius: var(--pix-radius-md);
  overflow: hidden;
  max-height: 240px;
  overflow-y: auto;
}

.td-hit {
  font-family: var(--pix-font-mono);
  font-size: var(--pix-text-xs);
  line-height: 20px;
  padding: 1px var(--pix-space-sm);
  color: var(--pix-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.td-hit + .td-hit {
  border-top: 1px solid var(--pix-border-light);
}

.td-expand {
  font-size: var(--pix-text-xs);
  font-weight: var(--pix-weight-medium);
  color: var(--pix-accent);
  background: none;
  border: none;
  cursor: pointer;
  padding: 2px 0;
}

.td-hits-summary .td-expand {
  padding: 0;
}

.td-expand:hover {
  text-decoration: underline;
}
</style>
