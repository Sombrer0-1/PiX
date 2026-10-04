<script setup lang="ts">
/**
 * TokenStats - Token usage display
 *
 * Shows token counts and cost from pi's SessionStats.
 */
import { computed } from "vue";
import { useWorkspaceRpc } from "../../composables/useWorkspaceRpc";

const rpc = useWorkspaceRpc();

const stats = computed(() => rpc.sessionStats.value);
const contextUsage = computed(() => stats.value?.contextUsage);
const contextPercent = computed(() => contextUsage.value?.percent ?? null);

const contextWidth = computed(() => `${Math.max(0, Math.min(100, contextPercent.value ?? 0))}%`);

const contextClass = computed(() => {
  const percent = contextPercent.value ?? 0;
  if (percent >= 90) return "danger";
  if (percent >= 70) return "warning";
  return "normal";
});

function formatNumber(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

function formatCost(c: number): string {
  if (c === 0) return "$0.00";
  if (c < 0.01) return "<$0.01";
  return `$${c.toFixed(2)}`;
}

function formatContextTokens(n: number | null): string {
  if (n === null) return "未知";
  return formatNumber(n);
}

function formatPercent(n: number | null): string {
  if (n === null) return "?";
  return `${n.toFixed(1)}%`;
}
</script>

<template>
  <div class="token-stats">
    <div v-if="stats" class="stats-content">
      <div v-if="stats.contextUsage" class="context-usage" :class="contextClass">
        <div class="context-meta">
          <span class="context-meta-label">上下文占用</span>
          <span class="context-percent">{{ formatPercent(stats.contextUsage.percent) }}</span>
          <span class="context-meta-value">
            {{ formatContextTokens(stats.contextUsage.tokens) }}
            <span class="context-meta-divider">/</span>
            {{ formatNumber(stats.contextUsage.contextWindow) }}
          </span>
        </div>
        <div class="context-track" role="progressbar" aria-label="上下文占用" :aria-valuenow="stats.contextUsage.percent ?? undefined" aria-valuemin="0" aria-valuemax="100"><span :class="{ 'has-usage': (contextPercent ?? 0) > 0 }" :style="{ width: contextWidth }"></span></div>
      </div>

      <div class="stats-grid">
        <div class="stat-item">
          <div class="stat-label">输入</div>
          <div class="stat-value">{{ formatNumber(stats.tokens.input) }}</div>
        </div>
        <div class="stat-item">
          <div class="stat-label">输出</div>
          <div class="stat-value">{{ formatNumber(stats.tokens.output) }}</div>
        </div>
        <div class="stat-item">
          <div class="stat-label">缓存读取</div>
          <div class="stat-value">{{ formatNumber(stats.tokens.cacheRead) }}</div>
        </div>
        <div class="stat-item">
          <div class="stat-label">缓存写入</div>
          <div class="stat-value">{{ formatNumber(stats.tokens.cacheWrite) }}</div>
        </div>
      </div>

      <div class="stats-summary">
        <div class="summary-row">
          <span class="summary-label">总计</span>
          <span class="summary-value">{{ formatNumber(stats.tokens.total) }}</span>
        </div>
        <div class="summary-row">
          <span class="summary-label">费用</span>
          <span class="summary-value cost">{{ formatCost(stats.cost) }}</span>
        </div>
      </div>
    </div>
    <div v-else class="no-stats">
      暂无 Token 数据。
    </div>
  </div>
</template>

<style scoped>
.token-stats {
  font-size: var(--pix-text-sm);
}

.stats-content {
  display: flex;
  flex-direction: column;
  gap: var(--pix-space-md);
}

.context-usage { padding-top: 5px; }
.context-meta { display: grid; grid-template-columns: 1fr auto; align-items: end; gap: 6px; }
.context-meta-label { grid-column: 1 / -1; font-size: 13px; color: var(--pix-text-secondary); }
.context-percent { font-size: 23px; font-weight: 600; line-height: 1.3; }
.context-meta-value { font-size: 12px; }
.context-meta-divider { color: var(--pix-text-muted); margin: 0 2px; }
.context-track { height: 4px; background: var(--pix-border); border-radius: 4px; overflow: hidden; margin-top: 10px; }
.context-track span { display: block; height: 100%; border-radius: inherit; background: var(--pix-accent); transition: width var(--pix-transition-base); }
.context-track span.has-usage { min-width: 8px; }
.context-usage.warning .context-percent { color: var(--pix-warning); }
.context-usage.warning .context-track span { background: var(--pix-warning); }
.context-usage.danger .context-percent { color: var(--pix-error); }
.context-usage.danger .context-track span { background: var(--pix-error); }

/* ── Token stats grid ── */
.stats-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--pix-space-xs);
}

.stat-item {
  display: flex; align-items: center; justify-content: space-between; gap: 6px; padding: 4px 0;
}

.stat-label {
  font-size: 13px;
  color: var(--pix-text-muted);
}

.stat-value {
  font-size: var(--pix-text-sm);
  font-weight: var(--pix-weight-semibold);
  color: var(--pix-text-primary);
  line-height: 1.3;
}

/* ── Summary (total + cost) ── */
.stats-summary {
  display: flex;
  justify-content: space-between;
  gap: 14px;
  padding-top: var(--pix-space-sm);
  border-top: 1px solid var(--pix-border-light);
}

.summary-row {
  display: flex;
  align-items: baseline;
  gap: 6px;
}

.summary-label {
  font-size: 13px;
  color: var(--pix-text-muted);
}

.summary-value {
  font-size: var(--pix-text-sm);
  font-weight: var(--pix-weight-semibold);
  color: var(--pix-text-primary);
}

.summary-value.cost {
  color: var(--pix-accent);
}

.no-stats {
  color: var(--pix-text-secondary);
  font-size: 13px;
  text-align: center;
  padding: var(--pix-space-sm) 0;
}
</style>
