<script setup lang="ts">
/**
 * TeamTimeline - 群聊时间线：用户与席位混排。
 *
 * One chronological record for the whole table: the user speaks as a
 * participant (蓝), every seat speaks from its own colour, and system notices
 * sit on their own line. There is no leader row and no "负责人" addressing —
 * targets are 全员 / @某席 / 私密（正文只在席位收件箱）.
 *
 * Two record rules the group chat must show (AC-8 / FR-2 / FR-6):
 * - 投递三态: every record is 已记录, plus one chip per seat that is 待注入 or
 *   已注入, so the user can tell "落盘成功" from "模型已看到".
 * - 长会话折叠: only the newest `overflowCap` records render; the older prefix
 *   collapses behind 「整理中 N 条」 with an expand affordance. Nothing is
 *   dropped — expanding re-renders the hidden prefix.
 */
import { computed, nextTick, onMounted, ref, watch } from "vue";
import {
  TIMELINE_OVERFLOW_CAP,
  deliveryRows,
  deliveryStateIcon,
  deliveryStateLabel,
  deliveryStateTone,
  formatClock,
  interruptLabel,
  isUserItem,
  overflowWindow,
  seatColor,
  seatLabel,
  timelineTypeIcon,
  timelineTypeLabel,
} from "./roundtable-display";
import { useTeamStore } from "../../stores/team-store";
import type { DeliveryState, SeatInfo, TimelineItem } from "@shared/team-types.js";

const props = withDefaults(defineProps<{
  /** Ordered timeline records the chat renders. */
  items: TimelineItem[];
  /** Seat roster for names/colours (falls back to the store). */
  seats?: Record<string, SeatInfo>;
  compact?: boolean;
  /** Force-expand and highlight one record (结论上浮 / 跳转). */
  highlightId?: string | null;
  /** Long-session collapse threshold. */
  overflowCap?: number;
}>(), {
  seats: undefined,
  compact: false,
  highlightId: null,
  overflowCap: TIMELINE_OVERFLOW_CAP,
});

const teamStore = useTeamStore();

const scrollContainer = ref<HTMLElement | null>(null);
const shouldAutoScroll = ref(true);
const expanded = ref(false);

const roster = computed<Record<string, SeatInfo>>(() => props.seats ?? teamStore.seats);

const window_ = computed(() => overflowWindow(props.items, props.overflowCap));

/** A located record must be visible even if it sits in the hidden prefix. */
const forceExpanded = computed(() => {
  const id = props.highlightId;
  return id !== null && window_.value.hidden.some((item) => item.id === id);
});

const showAll = computed(() => expanded.value || forceExpanded.value);

const renderedItems = computed(() =>
  showAll.value ? [...window_.value.hidden, ...window_.value.visible] : window_.value.visible,
);

function fromName(item: TimelineItem): string {
  return seatLabel(item.fromId, roster.value);
}

function fromColor(item: TimelineItem): string {
  return seatColor(item.fromId, roster.value);
}

/**
 * 目标标签（AC-20）：只有 `private_stub` 是「对外不可见」的那一类记录，公开 @单席
 * 只是定向可见。判据必须落在 type 上 —— 用 `type === "user" && toId !== "*"` 会把
 * 每一句公开 @ 标成「私密」，而真私密记录反而退回普通 `→ 席名`（方向相反）。
 */
function targetText(item: TimelineItem): string {
  if (item.type === "private_stub") return `私密 → ${seatLabel(item.toId, roster.value)}`;
  if (item.toId === "*") return "全员";
  if (item.type === "user") return `@ → ${seatLabel(item.toId, roster.value)}`;
  return `→ ${seatLabel(item.toId, roster.value)}`;
}

/** Recorded is implied by being on the timeline; per-seat chips add 待注入/已注入. */
function deliveryChips(item: TimelineItem): Array<{ seatId: string; state: DeliveryState }> {
  return deliveryRows(item).filter((row) => row.state !== "recorded");
}

interface RefInfo {
  label: string;
  title: string;
}

/** 引用跳转: replyTo / basedOn show the referenced record when it is in view. */
function refInfo(id: string | undefined, prefix: string): RefInfo | null {
  if (id === undefined) return null;
  const target = props.items.find((item) => item.id === id);
  if (target === undefined) return { label: `${prefix} ${id.slice(0, 6)}`, title: id };
  return { label: `${prefix} #${target.seq} ${seatLabel(target.fromId, roster.value)}`, title: target.summary || target.text };
}

const visibleCount = computed(() => renderedItems.value.length);

watch(
  () => renderedItems.value.length,
  async () => {
    if (!shouldAutoScroll.value) return;
    await nextTick();
    scrollToBottom();
  },
);

onMounted(async () => {
  if (renderedItems.value.length > 0) {
    await nextTick();
    scrollToBottom();
  }
});

function scrollToBottom(): void {
  const el = scrollContainer.value;
  if (el) el.scrollTop = el.scrollHeight;
}

function handleScroll(): void {
  const el = scrollContainer.value;
  if (!el) return;
  const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
  shouldAutoScroll.value = distance <= 48;
}

function collapse(): void {
  expanded.value = false;
}
</script>

<template>
  <div class="team-timeline" :class="{ 'team-timeline--compact': compact }" data-test="team-timeline">
    <div v-if="!compact" class="tt-header">
      <v-icon icon="mdi-forum-outline" size="15" />
      <span>圆桌群聊</span>
      <span class="tt-header-count" data-test="timeline-count">{{ items.length }}</span>
    </div>

    <div ref="scrollContainer" class="tt-body" @scroll="handleScroll">
      <div v-if="items.length === 0" class="tt-empty">还没有发言。用下面的输入框说第一句。</div>

      <template v-else>
        <!-- 整理中 N 条：默认收起较早的记录，展开后原文一条不少 -->
        <div v-if="!showAll && window_.collapsed > 0" class="tt-overflow">
          <button
            type="button"
            class="tt-overflow-btn"
            data-test="timeline-overflow-toggle"
            @click="expanded = true"
          >
            <v-icon icon="mdi-autorenew" size="12" />
            整理中 {{ window_.collapsed }} 条 · 展开
          </button>
        </div>
        <div v-if="showAll && window_.collapsed > 0" class="tt-overflow">
          <button type="button" class="tt-overflow-btn" data-test="timeline-collapse-toggle" @click="collapse">
            <v-icon icon="mdi-chevron-up" size="12" />
            收起较早的 {{ window_.collapsed }} 条
          </button>
        </div>

        <p class="tt-render-note" data-test="timeline-render-note">
          当前渲染 {{ visibleCount }} / {{ items.length }} 条
        </p>

        <article
          v-for="item in renderedItems"
          :key="item.id"
          class="tt-item"
          :class="{
            'tt-item--user': isUserItem(item),
            'tt-item--system': item.type === 'system',
            'tt-item--private': item.type === 'private_stub',
            'tt-item--highlight': highlightId === item.id,
          }"
          :data-test="`timeline-item-${item.id}`"
        >
          <!-- 系统提示（用户 id + system 类型）居中显示，不是发言。
               原文优先：开场公告、退出协商说法、硬停止告知都是多行文本，summary
               只是首行摘要，用它渲染会让时间线（记录面）丢掉正文。 -->
          <div v-if="item.type === 'system'" class="tt-system">
            <v-icon icon="mdi-information-outline" size="12" />
            <span class="tt-system-text">{{ item.text || item.summary }}</span>
            <span class="tt-system-time">{{ formatClock(item.ts) }}</span>
          </div>

          <template v-else>
            <div class="tt-meta">
              <span class="tt-dot" :style="{ backgroundColor: fromColor(item) }"></span>
              <span class="tt-from" :style="{ color: fromColor(item) }" data-test="timeline-from">
                {{ fromName(item) }}
              </span>
              <span class="tt-target">{{ targetText(item) }}</span>
              <span class="tt-type">
                <v-icon :icon="timelineTypeIcon(item.type)" size="11" />
                {{ timelineTypeLabel(item.type) }}
              </span>
              <span v-if="item.interrupt && item.interrupt !== 'L0'" class="tt-interrupt">
                {{ interruptLabel(item.interrupt) }}
              </span>
              <span v-if="item.threadId" class="tt-thread" :title="`线程 ${item.threadId}`">
                <v-icon icon="mdi-source-branch" size="11" />
                {{ item.threadId.slice(0, 10) }}
              </span>
              <span class="tt-time">{{ formatClock(item.ts) }}</span>
            </div>

            <div v-if="item.type === 'private_stub'" class="tt-private-note">
              <v-icon icon="mdi-lock-outline" size="12" />
              私密消息：正文只在该席位的收件箱里，时间线仅留痕迹。
            </div>
            <div v-else-if="item.knowledgeCard" class="tt-card">
              <div class="tt-card-claim">{{ item.knowledgeCard.claim }}</div>
              <div class="tt-card-meta">
                <span>{{ item.knowledgeCard.claimKind === "evidenced" ? "有依据" : "观点" }}</span>
                <span>置信度 {{ item.knowledgeCard.confidence }}</span>
              </div>
              <ul v-if="item.knowledgeCard.evidence.length > 0" class="tt-card-evidence">
                <li v-for="(evidence, index) in item.knowledgeCard.evidence" :key="index">
                  <span class="tt-evidence-kind">{{ evidence.kind }}</span>
                  <span class="tt-evidence-ref">{{ evidence.ref }}</span>
                  <span v-if="evidence.excerpt" class="tt-evidence-excerpt">{{ evidence.excerpt }}</span>
                </li>
              </ul>
              <div v-if="item.knowledgeCard.uncertainty" class="tt-card-uncertainty">
                不确定：{{ item.knowledgeCard.uncertainty }}
              </div>
            </div>
            <div v-else class="tt-text" data-test="timeline-text">{{ item.text }}</div>

            <div v-if="item.attachments && item.attachments.length > 0" class="tt-attachments">
              <span v-for="attachment in item.attachments" :key="attachment.path" class="tt-attachment">
                <v-icon icon="mdi-paperclip" size="11" />
                {{ attachment.name || attachment.path }}
              </span>
            </div>

            <div class="tt-foot">
              <span class="tt-delivery-chip tt-delivery-chip--recorded" data-test="delivery-recorded">
                <v-icon icon="mdi-content-save-outline" size="11" />
                已记录
              </span>
              <span
                v-for="chip in deliveryChips(item)"
                :key="chip.seatId"
                class="tt-delivery-chip"
                :class="`tt-delivery-chip--${deliveryStateTone(chip.state)}`"
                :data-test="`delivery-${chip.state}`"
                :title="`${seatLabel(chip.seatId, roster)}：${deliveryStateLabel(chip.state)}`"
              >
                <v-icon :icon="deliveryStateIcon(chip.state)" size="11" />
                {{ seatLabel(chip.seatId, roster) }}·{{ deliveryStateLabel(chip.state) }}
              </span>

              <span v-if="refInfo(item.replyToId, '回复')" class="tt-ref">
                {{ refInfo(item.replyToId, "回复")?.label }}
              </span>
              <span v-if="refInfo(item.basedOnId, '基于')" class="tt-ref">
                {{ refInfo(item.basedOnId, "基于")?.label }}
              </span>
            </div>
          </template>
        </article>
      </template>
    </div>

    <div v-if="!shouldAutoScroll && items.length > 0" class="tt-scroll-btn">
      <v-btn
        size="x-small"
        variant="flat"
        icon="mdi-chevron-down"
        color="primary"
        @click="shouldAutoScroll = true; scrollToBottom()"
      />
    </div>
  </div>
</template>

<style scoped>
.team-timeline {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  position: relative;
  background: var(--pix-bg-card);
}

.team-timeline--compact {
  background: transparent;
}

.tt-header {
  display: flex;
  align-items: center;
  gap: var(--pix-space-xs);
  padding: var(--pix-space-xs) var(--pix-space-sm);
  border-bottom: 1px solid var(--pix-border-subtle);
  color: var(--pix-text-secondary);
  font-size: var(--pix-text-xs);
  font-weight: var(--pix-weight-semibold);
  flex-shrink: 0;
}

.tt-header-count {
  margin-left: auto;
  padding: 1px 6px;
  border-radius: var(--pix-radius-xs);
  background: var(--pix-accent-light);
  color: var(--pix-accent);
  font-size: 11px;
}

.tt-body {
  flex: 1;
  overflow-y: auto;
  padding: var(--pix-space-sm);
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.tt-empty {
  padding: var(--pix-space-lg) 0;
  color: var(--pix-text-muted);
  font-size: var(--pix-text-xs);
  text-align: center;
}

.tt-overflow {
  display: flex;
  justify-content: center;
}

.tt-overflow-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-height: 24px;
  padding: 2px 10px;
  border: 1px dashed var(--pix-border);
  border-radius: 12px;
  background: var(--pix-bg-hover);
  color: var(--pix-text-secondary);
  font-size: 10px;
  cursor: pointer;
}

.tt-overflow-btn:hover {
  border-color: var(--pix-accent);
  color: var(--pix-accent);
}

.tt-render-note {
  margin: 0;
  color: var(--pix-text-muted);
  font-size: 9px;
  text-align: center;
}

.tt-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 7px 9px;
  border: 1px solid var(--pix-border-subtle);
  border-left: 3px solid var(--pix-border);
  border-radius: var(--pix-radius-md);
  background: #ffffff;
}

.tt-item--user {
  border-left-color: #2563eb;
  background: rgba(37, 99, 235, 0.04);
}

.tt-item--system {
  border-left-color: transparent;
  border-style: dashed;
  background: transparent;
}

.tt-item--private {
  border-left-color: var(--pix-warning);
  background: var(--pix-warning-bg);
}

.tt-item--highlight {
  border-color: var(--pix-accent);
  box-shadow: 0 0 0 2px var(--pix-accent-light);
}

.tt-system {
  display: flex;
  align-items: baseline;
  gap: 6px;
  color: var(--pix-text-muted);
  font-size: 10px;
}

.tt-system-text {
  flex: 1;
  min-width: 0;
  white-space: pre-wrap;
  word-break: break-word;
}

.tt-system-time {
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}

.tt-meta {
  display: flex;
  align-items: center;
  gap: 5px;
  flex-wrap: wrap;
}

.tt-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}

.tt-from {
  font-size: 11px;
  font-weight: var(--pix-weight-semibold);
}

.tt-target,
.tt-type,
.tt-interrupt,
.tt-thread {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 0 5px;
  border-radius: 3px;
  font-size: 9px;
}

.tt-target {
  background: var(--pix-bg-hover);
  color: var(--pix-text-secondary);
}

.tt-type {
  color: var(--pix-text-muted);
}

.tt-interrupt {
  background: var(--pix-warning-bg);
  color: var(--pix-warning);
  font-weight: var(--pix-weight-semibold);
}

.tt-thread {
  background: var(--pix-accent-light);
  color: var(--pix-accent);
}

.tt-time {
  margin-left: auto;
  color: var(--pix-text-muted);
  font-size: 9px;
  font-variant-numeric: tabular-nums;
}

.tt-text {
  color: var(--pix-text-primary);
  font-size: var(--pix-text-xs);
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
}

.tt-private-note {
  display: flex;
  align-items: center;
  gap: 5px;
  color: var(--pix-warning);
  font-size: 11px;
}

.tt-card {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 6px 8px;
  border: 1px solid var(--pix-border-subtle);
  border-radius: var(--pix-radius-sm);
  background: var(--pix-bg-code);
}

.tt-card-claim {
  color: var(--pix-text-primary);
  font-size: var(--pix-text-xs);
  font-weight: var(--pix-weight-medium);
  line-height: 1.5;
}

.tt-card-meta {
  display: flex;
  gap: 8px;
  color: var(--pix-text-muted);
  font-size: 9px;
}

.tt-card-evidence {
  margin: 0;
  padding-left: 14px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.tt-card-evidence li {
  color: var(--pix-text-secondary);
  font-size: 10px;
  line-height: 1.45;
}

.tt-evidence-kind {
  margin-right: 4px;
  color: var(--pix-accent);
  font-weight: var(--pix-weight-semibold);
}

.tt-evidence-ref {
  font-family: var(--pix-font-mono);
}

.tt-evidence-excerpt {
  color: var(--pix-text-muted);
}

.tt-card-uncertainty {
  color: var(--pix-warning);
  font-size: 10px;
}

.tt-attachments {
  display: flex;
  gap: 5px;
  flex-wrap: wrap;
}

.tt-attachment {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 1px 6px;
  border: 1px solid var(--pix-border-subtle);
  border-radius: 9px;
  background: #ffffff;
  color: var(--pix-text-secondary);
  font-size: 9px;
}

.tt-foot {
  display: flex;
  align-items: center;
  gap: 5px;
  flex-wrap: wrap;
}

.tt-delivery-chip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 1px 6px;
  border-radius: 3px;
  font-size: 9px;
  font-weight: var(--pix-weight-medium);
}

.tt-delivery-chip--recorded {
  background: var(--pix-bg-hover);
  color: var(--pix-text-secondary);
}

.tt-delivery-chip--amber {
  background: var(--pix-warning-bg);
  color: var(--pix-warning);
}

.tt-delivery-chip--blue {
  background: var(--pix-accent-light);
  color: var(--pix-accent);
}

.tt-delivery-chip--grey {
  background: var(--pix-bg-hover);
  color: var(--pix-text-muted);
}

.tt-ref {
  color: var(--pix-text-muted);
  font-size: 9px;
}

.tt-scroll-btn {
  position: absolute;
  bottom: 10px;
  right: 10px;
  z-index: 1;
}
</style>
