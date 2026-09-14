<script setup lang="ts">
/**
 * CostStrip - cost facts + discussion health (FR-10 / AC-22 / PRD §11.12).
 *
 * Two readouts on one strip:
 * - 消耗事实: per-seat and total utterances / tokens / cost / duration. Facts
 *   only — the strip never refuses a speech, locks a seat or stops the table
 *   (a hard stop is a user setting, not a cost reaction).
 * - 讨论体检: the three health numbers from `metrics.health` — 发言分布
 *   (speakShare), 证据密度 (evidenceDensity), 打断率 (interruptRate). They are
 *   display-only: nothing here rewrites the discussion.
 *
 * Health is part of the fixed contract (`RoundtableMetricsSnapshot.health`), so
 * the strip renders the three numbers even before any usage is measured.
 */
import { computed } from "vue";
import { emptyMetrics, useTeamStore } from "../../stores/team-store";
import { formatCost, formatDuration, formatShare, formatTokens, healthReadout, seatColor, seatLabel } from "./roundtable-display";

const teamStore = useTeamStore();

const snapshot = computed(() => teamStore.metrics ?? emptyMetrics());

const totals = computed(() => snapshot.value.totals);

const health = computed(() => healthReadout(snapshot.value));

/** Per-seat rows in roster order; seats without usage still show as 0. */
const seatRows = computed(() =>
  teamStore.seatList.map((seat) => {
    const usage = snapshot.value.perSeat[seat.seatId];
    return {
      seatId: seat.seatId,
      name: seat.name,
      color: seat.color,
      // 已退出席位仍在 perSeat 里（F4-3：分子分母同 population），但它的数字停在
      // 退出那一刻——不标注的话读起来就是「这席什么都没干」。
      exited: seat.status === "exited",
      utterances: usage?.utterances ?? 0,
      tokens: (usage?.tokensIn ?? 0) + (usage?.tokensOut ?? 0),
      cost: usage?.cost ?? 0,
      durationMs: usage?.durationMs ?? 0,
    };
  }),
);

/** Share rows for seats that never spoke would be noise; keep the spoken ones. */
const shareRows = computed(() =>
  health.value.speakShare.map((entry) => ({
    seatId: entry.seatId,
    name: seatLabel(entry.seatId, teamStore.seats),
    color: seatColor(entry.seatId, teamStore.seats),
    share: entry.share,
  })),
);
</script>

<template>
  <div class="cost-strip" data-test="cost-strip">
    <div class="cost-totals">
      <div class="cost-total">
        <span class="cost-total-label">累计发言</span>
        <strong data-test="cost-total-utterances">{{ totals.utterances }}</strong>
      </div>
      <div class="cost-total">
        <span class="cost-total-label">Token</span>
        <strong data-test="cost-total-tokens">{{ formatTokens(totals.tokens) }}</strong>
      </div>
      <div class="cost-total">
        <span class="cost-total-label">成本</span>
        <strong data-test="cost-total-cost">{{ formatCost(totals.cost) }}</strong>
      </div>
      <div class="cost-total">
        <span class="cost-total-label">时长</span>
        <strong data-test="cost-total-duration">{{ formatDuration(totals.durationMs) }}</strong>
      </div>
    </div>

    <!-- 讨论体检：发言分布 / 证据密度 / 打断率 -->
    <div class="cost-health">
      <div class="health-block health-block--share">
        <span class="health-label">发言分布</span>
        <div class="health-share-bar" data-test="health-speak-share">
          <span
            v-for="row in shareRows"
            :key="row.seatId"
            class="health-share-segment"
            :style="{ width: `${Math.max(2, Math.round(row.share * 100))}%`, backgroundColor: row.color }"
            :title="`${row.name} ${formatShare(row.share)}`"
          ></span>
          <span v-if="shareRows.length === 0" class="health-share-empty">暂无发言</span>
        </div>
        <div class="health-share-legend">
          <span
            v-for="row in shareRows"
            :key="row.seatId"
            class="health-share-item"
            data-test="health-speak-share-item"
          >
            <span class="health-dot" :style="{ backgroundColor: row.color }"></span>
            {{ row.name }} {{ formatShare(row.share) }}
          </span>
        </div>
      </div>

      <div class="health-block">
        <span class="health-label">证据密度</span>
        <strong class="health-value" data-test="health-evidence-density">
          {{ formatShare(health.evidenceDensity) }}
        </strong>
      </div>

      <div class="health-block">
        <span class="health-label">打断率</span>
        <strong class="health-value" data-test="health-interrupt-rate">
          {{ formatShare(health.interruptRate) }}
        </strong>
      </div>
    </div>

    <div v-if="seatRows.length > 0" class="cost-seats">
      <div
        v-for="row in seatRows"
        :key="row.seatId"
        class="cost-seat-row"
        data-test="cost-seat-row"
        :title="row.seatId"
      >
        <span class="cost-seat-name" :style="{ color: row.color }">
          {{ row.name }}
          <span v-if="row.exited" class="cost-seat-exited" data-test="cost-seat-exited">已退出</span>
        </span>
        <span class="cost-seat-cell">{{ row.utterances }} 条</span>
        <span class="cost-seat-cell">{{ formatTokens(row.tokens) }} token</span>
        <span class="cost-seat-cell">{{ formatCost(row.cost) }}</span>
        <span class="cost-seat-cell">{{ formatDuration(row.durationMs) }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.cost-strip {
  display: flex;
  align-items: center;
  gap: var(--pix-space-md);
  flex-wrap: wrap;
  padding: 6px var(--pix-space-md);
  border-bottom: 1px solid var(--pix-border-subtle);
  background: rgba(255, 255, 255, 0.9);
  flex-shrink: 0;
}

.cost-totals {
  display: flex;
  align-items: center;
  gap: var(--pix-space-md);
}

.cost-total {
  display: flex;
  flex-direction: column;
  min-width: 52px;
}

.cost-total-label {
  color: var(--pix-text-muted);
  font-size: 9px;
}

.cost-total strong {
  color: var(--pix-text-primary);
  font-size: var(--pix-text-xs);
  font-weight: var(--pix-weight-semibold);
  font-variant-numeric: tabular-nums;
}

.cost-health {
  display: flex;
  align-items: center;
  gap: var(--pix-space-md);
  min-width: 0;
}

.health-block {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.health-block--share {
  min-width: 160px;
}

.health-label {
  color: var(--pix-text-muted);
  font-size: 9px;
}

.health-value {
  color: var(--pix-text-primary);
  font-size: var(--pix-text-xs);
  font-weight: var(--pix-weight-semibold);
  font-variant-numeric: tabular-nums;
}

.health-share-bar {
  display: flex;
  align-items: center;
  height: 6px;
  border-radius: 3px;
  background: var(--pix-bg-hover);
  overflow: hidden;
}

.health-share-segment {
  height: 100%;
}

.health-share-empty {
  padding-left: 6px;
  color: var(--pix-text-muted);
  font-size: 9px;
  line-height: 6px;
}

.health-share-legend {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.health-share-item {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  color: var(--pix-text-secondary);
  font-size: 9px;
  white-space: nowrap;
}

.health-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
}

.cost-seats {
  display: flex;
  align-items: center;
  gap: var(--pix-space-sm);
  margin-left: auto;
  /* 视口恰好 1400 时也要看得见每席消耗（FR-10）：装不下就换行，行内横向滚动兜底，
     不用 media query 把它整块藏起来。 */
  flex-wrap: wrap;
  min-width: 0;
  overflow-x: auto;
  scrollbar-width: thin;
}

.cost-seat-row {
  display: grid;
  grid-template-columns: auto auto auto auto auto;
  align-items: center;
  gap: 6px;
  padding: 3px 7px;
  border: 1px solid var(--pix-border-subtle);
  border-radius: var(--pix-radius-md);
  background: #ffffff;
  white-space: nowrap;
}

.cost-seat-name {
  font-size: 10px;
  font-weight: var(--pix-weight-semibold);
}

.cost-seat-exited {
  margin-left: 4px;
  padding: 0 4px;
  border-radius: 3px;
  background: var(--pix-bg-hover);
  color: var(--pix-text-muted);
  font-size: 9px;
  font-weight: var(--pix-weight-normal);
}

.cost-seat-cell {
  color: var(--pix-text-secondary);
  font-size: 9px;
  font-variant-numeric: tabular-nums;
}
</style>
