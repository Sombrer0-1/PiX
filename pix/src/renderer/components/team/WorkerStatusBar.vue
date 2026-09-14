<script setup lang="ts">
/**
 * WorkerStatusBar - the peer seat strip.
 *
 * Every seat is a peer: one chip per seat with its colour, display name,
 * status dot and current activity, plus the roundtable name and the unhandled
 * attention count. Clicking a chip focuses that seat (the workbench shows its
 * detail card); clicking it again clears the focus. There is no leader entry -
 * the user speaks from the composer, not from a chair.
 *
 * The file keeps its original name because CenterPanel (S7) imports this path;
 * only the contents are the roundtable seat strip.
 */
import { computed } from "vue";
import { useTeamStore } from "../../stores/team-store";
import { seatStatusDot, seatStatusLabel } from "./roundtable-display";

const teamStore = useTeamStore();

const seatChips = computed(() =>
  teamStore.seatList.map((seat) => ({
    seatId: seat.seatId,
    name: seat.name,
    slug: seat.slug,
    status: seat.status,
    perspective: seat.perspective,
    activity: seat.currentActivity ?? "",
    error: seat.error,
    isFocused: teamStore.focusedSeatId === seat.seatId,
    color: seat.color,
    dotColor: seatStatusDot(seat.status),
    statusLabel: seatStatusLabel(seat.status),
  })),
);

const speakingCount = computed(() => seatChips.value.filter((chip) => chip.status === "speaking" || chip.status === "exploring").length);
const waitingCount = computed(() => seatChips.value.filter((chip) => chip.status === "waiting_turn").length);

function handleSeatClick(seatId: string): void {
  if (teamStore.focusedSeatId === seatId) {
    teamStore.clearFocus();
    return;
  }
  teamStore.focusSeat(seatId);
}
</script>

<template>
  <div class="seat-status-bar" data-test="seat-status-bar">
    <div class="ssb-summary">
      <span class="ssb-summary-icon">
        <v-icon icon="mdi-account-group-outline" size="16" />
      </span>
      <span class="ssb-summary-copy">
        <strong>{{ teamStore.teamName || "圆桌" }}</strong>
        <span>{{ speakingCount }} 席在推进 / {{ seatChips.length }} 席</span>
      </span>
    </div>

    <div class="ssb-seats">
      <button
        v-for="chip in seatChips"
        :key="chip.seatId"
        class="ssb-chip"
        :class="{ focused: chip.isFocused, running: chip.status === 'speaking' || chip.status === 'exploring', exited: chip.status === 'exited' }"
        type="button"
        :data-test="`seat-chip-${chip.slug}`"
        :title="chip.activity || chip.perspective || chip.statusLabel"
        @click="handleSeatClick(chip.seatId)"
      >
        <span class="ssb-chip-dot" :style="{ backgroundColor: chip.dotColor }"></span>
        <span class="ssb-chip-name" :style="{ color: chip.color }">{{ chip.name }}</span>
        <span class="ssb-chip-status">{{ chip.statusLabel }}</span>
      </button>
    </div>

    <span
      v-if="waitingCount > 0 || teamStore.unackedAttention.length > 0"
      class="ssb-attention"
      :title="`${waitingCount} 席等待发言 · ${teamStore.unackedAttention.length} 条待处理注意力`"
    >
      <template v-if="waitingCount > 0">
        <v-icon icon="mdi-timer-sand" size="13" />
        {{ waitingCount }}
      </template>
      <template v-if="teamStore.unackedAttention.length > 0">
        <v-icon icon="mdi-bell-outline" size="13" />
        {{ teamStore.unackedAttention.length }}
      </template>
    </span>
  </div>
</template>

<style scoped>
.seat-status-bar {
  display: grid;
  grid-template-columns: minmax(150px, auto) minmax(0, 1fr) auto;
  align-items: center;
  min-height: 52px;
  padding: 6px var(--pix-space-md);
  background: #ffffff;
  border-bottom: 1px solid var(--pix-border-subtle);
  flex-shrink: 0;
  gap: var(--pix-space-sm);
}

.ssb-summary {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.ssb-summary-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  flex-shrink: 0;
  border-radius: var(--pix-radius-md);
  background: var(--pix-accent-light);
  color: var(--pix-accent);
}

.ssb-summary-copy {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.ssb-summary-copy strong,
.ssb-summary-copy span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ssb-summary-copy strong {
  color: var(--pix-text-primary);
  font-size: var(--pix-text-xs);
  font-weight: var(--pix-weight-semibold);
}

.ssb-summary-copy span {
  color: var(--pix-text-muted);
  font-size: 10px;
}

.ssb-seats {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  overflow-x: auto;
  padding: 2px;
  scrollbar-width: thin;
}

.ssb-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-height: 30px;
  padding: 4px 9px;
  border-radius: var(--pix-radius-md);
  background: var(--pix-bg-card);
  border: 1px solid var(--pix-border-subtle);
  cursor: pointer;
  transition: border-color var(--pix-transition-fast), background var(--pix-transition-fast), box-shadow var(--pix-transition-fast);
  font-family: var(--pix-font-ui);
  font-size: var(--pix-text-xs);
}

.ssb-chip:hover {
  border-color: var(--pix-border);
  background: var(--pix-bg-hover);
}

.ssb-chip.focused {
  border-color: var(--pix-accent);
  background: var(--pix-accent-light);
  box-shadow: 0 0 0 1px var(--pix-accent-soft);
}

.ssb-chip.running {
  border-color: var(--pix-success-light);
}

.ssb-chip.exited {
  opacity: 0.55;
}

.ssb-chip-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}

.ssb-chip.running .ssb-chip-dot {
  animation: ssb-pulse 1.5s ease-in-out infinite;
}

@keyframes ssb-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}

.ssb-chip-name {
  font-weight: var(--pix-weight-medium);
}

.ssb-chip-status {
  font-size: 10px;
  color: var(--pix-text-muted);
  white-space: nowrap;
}

.ssb-attention {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 26px;
  padding: 3px 8px;
  border-radius: var(--pix-radius-md);
  background: var(--pix-warning-bg);
  color: var(--pix-warning);
  font-size: 10px;
  font-weight: var(--pix-weight-semibold);
  white-space: nowrap;
}

@media (max-width: 1100px) {
  .seat-status-bar {
    grid-template-columns: minmax(0, 1fr) auto;
  }

  .ssb-summary {
    display: none;
  }
}
</style>
