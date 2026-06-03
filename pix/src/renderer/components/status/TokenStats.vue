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
</script>

<template>
  <div class="token-stats">
    <div v-if="stats" class="stats-grid">
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
    <div v-else class="no-stats">
      暂无 Token 数据。
    </div>
  </div>
</template>

<style scoped>
.token-stats {
  font-size: var(--pix-text-sm);
}

.stats-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--pix-space-xs) var(--pix-space-md);
}

.stat-item {
  padding: 1px 0;
}

.stat-item.total,
.stat-item.cost {
  grid-column: span 2;
  border-top: 1px solid var(--pix-border-light);
  padding-top: var(--pix-space-xs);
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
  font-weight: 500;
  color: var(--pix-text-primary);
}

.total .stat-value {
  font-weight: 600;
}

.cost .stat-value {
  color: var(--pix-accent);
}

.no-stats {
  color: var(--pix-text-muted);
  font-size: var(--pix-text-xs);
  text-align: center;
  padding: var(--pix-space-sm) 0;
}
</style>
