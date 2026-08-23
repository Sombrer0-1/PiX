<script setup lang="ts">
/**
 * TaskTranscriptView - 工作记录 tab:磁盘回放 + 直播增量 + 贴底跟随 (PiX 1.5 P3)
 *
 * 只读复用的 SessionView/MessageBlock/ToolExecutionBlock 渲染链由 display-blocks
 * 组装器驱动。TaskDetailPanel 以 :key="`${task.taskId}:${itemIndex}`" 渲染本组件,
 * taskId/itemIndex 变更即整体重挂载,杜绝旧任务 blocks/游标残留(无 Vue 复用路径);
 * watch/unwatch 由父组件 TaskDetailPanel 持有,本组件不发送。
 *
 * 挂载:读 store.transcripts[taskId](无则 loadTranscriptPage)→ 组装器 loadEntries
 * (先 clear 再全量重折叠)→ 消费 liveEvents 中 seq > consumedSeq 且 itemIndex
 * 匹配的事件(推进 consumedSeq)→ applyEvent。直播接缝不重复由组装器两条去重规则
 * 保证(同一消息经磁盘+直播两路到达只折叠一次)。
 *
 * 全量重放重建(以磁盘为真相):终态(task.status 转终态)或 liveDropped 或未消费
 * 事件被环形淘汰(seq <= 最旧保留 seq)时 loadTranscriptPage 后整体重折叠。
 */
import { computed, nextTick, onMounted, reactive, ref, watch } from "vue";
import { useAgentTaskStore } from "../../stores/agent-task-store";
import SessionView from "../session/SessionView.vue";
import { createDisplayBlockAssembler } from "../../utils/display-blocks";
import type { AgentTaskInfo, AgentTaskStatus } from "@shared/agent-task-types.js";
import type { DisplayBlock } from "@/types/session";

const TERMINAL_STATUSES: ReadonlySet<AgentTaskStatus> = new Set(["completed", "failed", "cancelled"]);

const props = defineProps<{
  task: AgentTaskInfo;
  /** 初始 item(chain 任务由 TaskDetailPanel 透传;之后由 item 子 tab 切换)。 */
  itemIndex?: number;
}>();

const emit = defineEmits<{ itemChange: [itemIndex: number] }>();

const store = useAgentTaskStore();

/** 组装器就地突变该 reactive 数组,SessionView 随块变化重渲染。 */
const blocks = reactive<DisplayBlock[]>([]);
const assembler = createDisplayBlockAssembler({ blocks });

const scrollRef = ref<HTMLElement | null>(null);
/** 贴底跟随:距底 < 48px 时保持粘底,回放/直播推进后自动滚到底。 */
const follow = ref(true);

/** 当前 item(挂载期间固定;切换 item 由面板改 prop → :key 重挂载)。 */
const activeItemIndex = computed(() => props.itemIndex ?? 0);

const transcriptState = computed(() => store.transcripts[props.task.taskId]);
const activeItem = computed(() => transcriptState.value?.byItem[activeItemIndex.value]);
const loading = computed(() => activeItem.value?.loading === true && (activeItem.value?.entries.length ?? 0) === 0);
const hasBlocks = computed(() => blocks.length > 0);

/** chain 多 item(itemSummaries.length > 1)时顶部 item 子 tab。 */
const itemTabs = computed(() =>
  props.task.itemSummaries.length > 1 ? props.task.itemSummaries.slice().sort((a, b) => a.index - b.index) : [],
);

// ==========================================================================
// 回放 + 直播消费
// ==========================================================================

/** 整体重折叠:先 clear 再按全量 entries 折叠(loadEntries 幂等)。 */
function refold(): void {
  assembler.loadEntries(activeItem.value?.entries ?? []);
}

/**
 * 消费 liveEvents 中 seq > consumedSeq 且 itemIndex 匹配的事件(推进
 * consumedSeq)→ applyEvent。非匹配 item 的事件保留,待该 item 视图消费。
 * 消费后检查环形淘汰(seq <= 最旧保留 seq)→ 全量重放重建。
 */
function consumeLiveEvents(): void {
  const state = transcriptState.value;
  if (!state) return;
  for (const entry of state.liveEvents) {
    if (entry.seq <= state.consumedSeq) continue;
    if (entry.itemIndex !== activeItemIndex.value) continue;
    assembler.applyEvent(entry.event);
    state.consumedSeq = entry.seq;
  }
}

/** 未消费事件被环形淘汰:liveEvents[0].seq 与 consumedSeq 间出现空洞。 */
function hasEvictionGap(): boolean {
  const state = transcriptState.value;
  if (!state || state.liveEvents.length === 0) return false;
  return state.liveEvents[0].seq > state.consumedSeq + 1;
}

let rebuilding = false;

/** 全量重放重建:loadTranscriptPage 后整体重折叠(以磁盘为真相)。 */
async function rebuild(): Promise<void> {
  if (rebuilding) return;
  rebuilding = true;
  try {
    await store.loadTranscriptPage(props.task.taskId, activeItemIndex.value);
    refold();
    consumeLiveEvents();
    scheduleScroll();
  } finally {
    rebuilding = false;
  }
}

async function mountTranscript(): Promise<void> {
  const state = transcriptState.value;
  if (!state || !state.byItem[activeItemIndex.value]) {
    await store.loadTranscriptPage(props.task.taskId, activeItemIndex.value);
  }
  refold();
  consumeLiveEvents();
  scheduleScroll();
}

// ==========================================================================
// 贴底跟随
// ==========================================================================

function onScroll(): void {
  const el = scrollRef.value;
  if (!el) return;
  follow.value = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
}

function scheduleScroll(): void {
  void nextTick(() => {
    const el = scrollRef.value;
    if (el && follow.value) {
      el.scrollTop = el.scrollHeight;
    }
  });
}

// ==========================================================================
// 生命周期与响应式触发
// ==========================================================================

function switchItem(index: number): void {
  if (index !== activeItemIndex.value) {
    emit("itemChange", index);
  }
}

onMounted(() => {
  void mountTranscript();
});

// 新增直播事件(store 每次替换 liveEvents 数组)→ 增量消费。
watch(
  () => transcriptState.value?.liveEvents,
  () => {
    consumeLiveEvents();
    if (hasEvictionGap()) {
      void rebuild();
    }
    scheduleScroll();
  },
);

// 环形溢出丢事件(liveDropped 置位)→ 全量重放重建。
watch(
  () => transcriptState.value?.liveDropped,
  (dropped) => {
    if (dropped) {
      void rebuild();
    }
  },
);

// 终态:service 在终态 task_state 前已 flush + 清 watcher;磁盘为真相,全量重放。
watch(
  () => props.task.status,
  (status) => {
    if (TERMINAL_STATUSES.has(status)) {
      void rebuild();
    }
  },
);
</script>

<template>
  <div class="task-transcript" data-test="task-transcript-view">
    <div v-if="itemTabs.length > 0" class="task-transcript-items" role="tablist" aria-label="任务条目">
      <button
        v-for="summary in itemTabs"
        :key="summary.index"
        type="button"
        class="task-transcript-item-tab"
        :class="{ active: summary.index === activeItemIndex }"
        role="tab"
        :aria-selected="summary.index === activeItemIndex"
        :data-test="`task-transcript-item-tab-${summary.index}`"
        @click="switchItem(summary.index)"
      >
        {{ summary.agentName }}
      </button>
    </div>
    <div ref="scrollRef" class="task-transcript-scroll" data-test="task-transcript-scroll" @scroll="onScroll">
      <SessionView v-if="hasBlocks" :blocks="blocks" />
      <div v-else-if="loading" class="task-transcript-empty" data-test="task-transcript-loading">加载中...</div>
      <div v-else class="task-transcript-empty" data-test="task-transcript-empty">该 item 无记录</div>
    </div>
  </div>
</template>

<style scoped>
.task-transcript {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  min-width: 0;
}

.task-transcript-items {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 0 var(--pix-space-md) var(--pix-space-xs);
  border-bottom: 1px solid var(--pix-border-light);
  flex-shrink: 0;
}

.task-transcript-item-tab {
  padding: 4px 10px 6px;
  font-size: var(--pix-text-sm);
  font-family: var(--pix-font-ui);
  color: var(--pix-text-secondary);
  border-bottom: 2px solid transparent;
  cursor: pointer;
  transition: color var(--pix-transition-fast), border-color var(--pix-transition-fast);
}

.task-transcript-item-tab:hover {
  color: var(--pix-text-primary);
}

.task-transcript-item-tab.active {
  color: var(--pix-accent);
  border-bottom-color: var(--pix-accent);
  font-weight: var(--pix-weight-medium);
}

.task-transcript-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--pix-space-md);
}

.task-transcript-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 120px;
  font-size: var(--pix-text-xs);
  color: var(--pix-text-muted);
}
</style>
