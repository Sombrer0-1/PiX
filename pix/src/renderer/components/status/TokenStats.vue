<script setup lang="ts">
/**
 * TokenStats - Token usage display
 *
 * Shows token counts and cost from pi's SessionStats.
 */
import { computed } from "vue";
import { useRpc } from "../../composables/useRpc";

const rpc = useRpc();

const stats = computed(() => rpc.sessionStats.value);
const contextUsage = computed(() => stats.value?.contextUsage);
const contextPercent = computed(() => contextUsage.value?.percent ?? null);
const contextRingStyle = computed(() => {
  const percent = contextPercent.value;
  const safePercent = percent === null ? 0 : Math.max(0, Math.min(100, percent));
  return {
    background: `conic-gradient(var(--token-ring-color) ${safePercent}%, #eef0f6 0)`,
  };
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
        <div class="context-ring" :style="contextRingStyle">
          <div class="context-ring-inner">
            <span class="context-percent">{{ formatPercent(stats.contextUsage.percent) }}</span>
          </div>
        </div>
        <div class="context-total">
          <span>{{ formatContextTokens(stats.contextUsage.tokens) }}</span>
          <span class="context-divider">/</span>
          <span>{{ formatNumber(stats.contextUsage.contextWindow) }}</span>
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
        <div class="stat-item total">
          <div class="stat-label">总计</div>
          <div class="stat-value">{{ formatNumber(stats.tokens.total) }}</div>
        </div>
        <div class="stat-item cost">
          <div class="stat-label">费用</div>
          <div class="stat-value">{{ formatCost(stats.cost) }}</div>
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
  --token-ring-color: var(--pix-accent);
}

.stats-content {
  display: flex;
  flex-direction: column;
  gap: var(--pix-space-md);
}

.context-usage {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 14px;
  padding-bottom: var(--pix-space-md);
  border-bottom: 1px solid var(--pix-border-light);
}

.context-ring {
  width: 92px;
  height: 92px;
  border-radius: 50%;
  padding: 10px;
  transition: background var(--pix-transition-base);
}

.context-ring-inner {
  width: 100%;
  height: 100%;
  border-radius: 50%;
  background: var(--pix-bg-card);
  box-shadow: inset 0 0 0 1px var(--pix-border-subtle);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}

.context-percent {
  color: #000000;
  font-family: var(--pix-font-mono);
  font-size: var(--pix-text-lg);
  font-weight: var(--pix-weight-semibold);
  line-height: 1.2;
}

.context-total {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 1px;
  min-width: 48px;
  font-family: var(--pix-font-mono);
  font-size: var(--pix-text-sm);
  font-weight: var(--pix-weight-semibold);
  line-height: 1.2;
  color: var(--pix-text-secondary);
}

.context-divider {
  color: var(--pix-text-muted);
  font-size: 10px;
  line-height: 1;
}

.context-usage.warning {
  --token-ring-color: var(--pix-warning);
}

.context-usage.danger {
  --token-ring-color: var(--pix-error);
}

.stats-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 7px var(--pix-space-md);
}

.stat-item {
  padding: 2px 0;
}

.stat-item.total,
.stat-item.cost {
  grid-column: span 2;
  border-top: 1px solid var(--pix-border-light);
  padding-top: var(--pix-space-sm);
  margin-top: var(--pix-space-xs);
}

.stat-label {
  font-size: var(--pix-text-xs);
  color: var(--pix-text-muted);
  margin-bottom: 1px;
}

.stat-value {
  font-family: var(--pix-font-mono);
  font-size: var(--pix-text-sm);
  font-weight: var(--pix-weight-medium);
  color: var(--pix-text-primary);
}

.total .stat-value {
  font-weight: var(--pix-weight-semibold);
}

.cost .stat-value {
  color: var(--pix-accent);
}

.no-stats {
  color: var(--pix-text-secondary);
  font-size: var(--pix-text-xs);
  text-align: center;
  padding: var(--pix-space-sm) 0;
}
</style>
