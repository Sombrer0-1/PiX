<script setup lang="ts">
/**
 * TodoCard - 任务清单卡片（R3，SDD §3.3）。
 *
 * 右栏只读镜像卡：清单真源在主进程 TodoController，模型经 todo_write 全量
 * 写入，卡片只展示（无任何修改入口）。头部 = 标题 + n/m 进度 + 折叠按钮；
 * 折叠时整卡收为头部一行。空清单由父级 v-if 隐藏；全部完成后 controller
 * 自动清空（CC 同款），镜像端保留 clearedCount 摘要，卡片渲染常驻的
 * "全部完成"汇总行（不自动消失）。
 *
 * 纯展示组件（与 PlanCard 同款）：订阅由 CenterPanel.onMounted 的
 * todoStore.subscribeToEvents() 全局持有。卡片自身 v-if 在空清单下卸载，
 * 若订阅归卡片所有，卸载会退订唯一监听、之后的 todo_state 全部丢失。
 */
import { computed, ref } from "vue";
import { useTodoStore } from "../../stores/todo-store";
import type { TodoItem } from "@shared/todo-types.js";

const todoStore = useTodoStore();

/** 折叠态（false = 展开列表行）。 */
const collapsed = ref(false);

const total = computed(() => todoStore.items.length);
const completed = computed(() => todoStore.completedCount);

/** 完成收尾摘要态：清单已被"全部 completed → 自动清空"收掉。 */
const showCompletedSummary = computed(
	() => todoStore.items.length === 0 && todoStore.clearedCount !== null,
);

/** 头部进度：常态 completed/total；收尾摘要态 N/N（N = 清空前条数）。 */
const progressText = computed(() => {
	if (showCompletedSummary.value) {
		const cleared = todoStore.clearedCount ?? 0;
		return `${cleared}/${cleared}`;
	}
	return `${completed.value}/${total.value}`;
});

/** 行状态图标（SDD §3.3：completed 勾、in_progress 播放、pending 空心圆）。 */
const STATUS_ICON: Record<TodoItem["status"], string> = {
	completed: "mdi-check",
	in_progress: "mdi-play",
	pending: "mdi-checkbox-blank-circle-outline",
};

/** 行文案：进行中行显示 activeForm ?? content（进行时动态文案），其余显示 content。 */
function rowText(item: TodoItem): string {
	return item.status === "in_progress" ? (item.activeForm ?? item.content) : item.content;
}
</script>

<template>
  <div class="info-card todo-card" data-test="todo-card">
    <div class="card-title-row">
      <span class="card-title">任务清单</span>
      <div class="todo-header-right">
        <span class="todo-progress" data-test="todo-progress">{{ progressText }}</span>
        <button
          class="todo-collapse-btn"
          type="button"
          :title="collapsed ? '展开任务清单' : '收起任务清单'"
          :aria-label="collapsed ? '展开任务清单' : '收起任务清单'"
          data-test="todo-collapse-btn"
          @click="collapsed = !collapsed"
        >
          <v-icon :icon="collapsed ? 'mdi-chevron-down' : 'mdi-chevron-up'" size="16" aria-hidden="true" />
        </button>
      </div>
    </div>

    <!-- 折叠时收为头部一行；展开时渲染条目行（全量替换，条目无稳定 id，index 即键）。 -->
    <div v-if="!collapsed" class="todo-list">
      <div
        v-for="(item, index) in todoStore.items"
        :key="index"
        class="todo-row"
        :class="item.status"
        :title="item.content"
      >
        <v-icon :icon="STATUS_ICON[item.status]" size="14" aria-hidden="true" />
        <span class="todo-text">{{ rowText(item) }}</span>
      </div>
      <!-- 完成收尾摘要行：清单自动清空后的常驻提示，下一次写入即消失。 -->
      <div v-if="showCompletedSummary" class="todo-row summary" data-test="todo-completed-summary">
        <v-icon icon="mdi-check-circle" size="14" aria-hidden="true" />
        <span class="todo-text">全部完成</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 卡片壳/标题沿用 RightPanel 的 .info-card / .card-title 语言（组件内复制语义，
   与 GitWorkdirCard 同款，不改 RightPanel 既有样式类）。 */
.info-card {
  background: white; border: 1px solid var(--pix-border-card); border-radius: 10px; padding: 14px; flex-shrink: 0;
}

.info-card:hover {
  border-color: #bfc8db;
}

.card-title-row {
  display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 12px;
}

.card-title {
  font-size: 15px; font-weight: 600; color: var(--pix-text-primary);
}

.todo-header-right {
  display: flex;
  align-items: center;
  gap: 4px;
}

.todo-progress {
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  color: var(--pix-text-muted);
}

.todo-collapse-btn {
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--pix-radius-md);
  color: var(--pix-text-secondary);
  cursor: pointer;
  transition: color var(--pix-transition-fast), background var(--pix-transition-fast);
}

.todo-collapse-btn:hover {
  color: var(--pix-text-primary);
  background: var(--pix-accent-light);
}

/* ── 条目行 ── */
.todo-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 280px;
  overflow-y: auto;
}

.todo-row {
  display: flex;
  align-items: baseline;
  gap: 7px;
  min-height: 24px;
  padding: 2px 0;
  font-size: 13px;
  color: var(--pix-text-primary);
}

/* v-icon 与首行文本基线对齐（行内 flex 图标默认居中会偏离小字号基线）。 */
.todo-row :deep(.v-icon) {
  flex-shrink: 0;
  translate: 0 1px;
}

.todo-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  line-height: var(--pix-leading-base);
}

/* completed：弱化 + 划线。 */
.todo-row.completed {
  color: var(--pix-text-muted);
}

.todo-row.completed .todo-text {
  text-decoration: line-through;
}

/* in_progress：高亮（accent），进行时文案。 */
.todo-row.in_progress {
  color: var(--pix-accent);
}

.todo-row.in_progress .todo-text {
  font-weight: var(--pix-weight-medium);
}

/* pending：次级色。 */
.todo-row.pending .todo-text {
  color: var(--pix-text-secondary);
}

/* 完成收尾摘要行：成功色。 */
.todo-row.summary {
  color: var(--pix-success);
}

.todo-row.summary .todo-text {
  font-weight: var(--pix-weight-medium);
}
</style>
