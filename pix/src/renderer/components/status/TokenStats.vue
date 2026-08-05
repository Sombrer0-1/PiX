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

// SVG ring geometry. r = 34 inside an 80x80 viewBox; the progress arc is drawn
// via stroke-dashoffset so it animates smoothly when the percent changes.
const RING_RADIUS = 34;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

const ringDashoffset = computed(() => {
  const percent = contextPercent.value;
  if (percent === null) return RING_CIRCUMFERENCE;
  const safe = Math.max(0, Math.min(100, percent));
  return RING_CIRCUMFERENCE * (1 - safe / 100);
});

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
        <div class="context-ring">
          <svg width="80" height="80" viewBox="0 0 80 80">
            <circle class="ring-track" cx="40" cy="40" :r="RING_RADIUS" fill="none" stroke-width="7" />
            <circle
              class="ring-progress"
              cx="40"
              cy="40"
              :r="RING_RADIUS"
              fill="none"
              stroke-width="7"
              stroke-linecap="round"
              :stroke-dasharray="RING_CIRCUMFERENCE"
              :stroke-dashoffset="ringDashoffset"
            />
          </svg>
          <div class="context-ring-label">
            <span class="context-percent">{{ formatPercent(stats.contextUsage.percent) }}</span>
          </div>
        </div>
        <div class="context-meta">
          <span class="context-meta-label">上下文占用</span>
          <span class="context-meta-value">
            {{ formatContextTokens(stats.contextUsage.tokens) }}
            <span class="context-meta-divider">/</span>
            {{ formatNumber(stats.contextUsage.contextWindow) }}
          </span>
        </div>
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

/* ── Context usage ring ── */
.context-usage {
  display: flex;
  align-items: center;
  gap: var(--pix-space-md);
  padding: var(--pix-space-md);
  background: var(--pix-bg-code);
  border: 1px solid var(--pix-border-subtle);
  border-radius: var(--pix-radius-lg);
}

.context-ring {
  position: relative;
  width: 80px;
  height: 80px;
  flex-shrink: 0;
}

.context-ring svg {
  transform: rotate(-90deg);
}

.ring-track {
  stroke: var(--pix-border);
}

.ring-progress {
  stroke: var(--pix-accent);
  transition: stroke-dashoffset var(--pix-transition-slow), stroke var(--pix-transition-base);
}

.context-ring-label {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}

.context-percent {
  font-size: var(--pix-text-md);
  font-weight: var(--pix-weight-semibold);
  color: var(--pix-text-primary);
  line-height: 1;
}

.context-meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.context-meta-label {
  font-size: var(--pix-text-xs);
  color: var(--pix-text-muted);
}

.context-meta-value {
  font-size: var(--pix-text-sm);
  font-weight: var(--pix-weight-semibold);
  color: var(--pix-text-primary);
  line-height: 1.3;
}

.context-meta-divider {
  color: var(--pix-text-muted);
  margin: 0 2px;
}

.context-usage.warning .ring-progress {
  stroke: var(--pix-warning);
}
.context-usage.warning .context-percent {
  color: var(--pix-warning);
}

.context-usage.danger .ring-progress {
  stroke: var(--pix-error);
}
.context-usage.danger .context-percent {
  color: var(--pix-error);
}

/* ── Token stats grid ── */
.stats-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--pix-space-xs);
}

.stat-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: var(--pix-space-sm) var(--pix-space-md);
  background: var(--pix-bg-code);
  border: 1px solid var(--pix-border-subtle);
  border-radius: var(--pix-radius-md);
}

.stat-label {
  font-size: var(--pix-text-xs);
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
  flex-direction: column;
  gap: var(--pix-space-xs);
  padding-top: var(--pix-space-sm);
  border-top: 1px solid var(--pix-border-light);
}

.summary-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
}

.summary-label {
  font-size: var(--pix-text-xs);
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
  font-size: var(--pix-text-xs);
  text-align: center;
  padding: var(--pix-space-sm) 0;
}
</style>
