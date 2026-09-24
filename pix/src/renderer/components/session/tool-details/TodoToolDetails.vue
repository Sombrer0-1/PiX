<script setup lang="ts">
/**
 * TodoToolDetails - todo_write 清单渲染器（R3，参考 CC TodoWrite 的呈现语义）。
 *
 * todo_write 每次提交完整清单（全量替换），args.todos 即本次写入后的全量
 * 状态，直播与回放都从这里取数（replay 不保留 result.details，清单渲染
 * 不依赖结果）。呈现语言与 CC 一致：completed 划线弱化、in_progress 高亮
 * 且显示 activeForm 进行时文案、pending 次级色；全部完成时附"清单已收尾"
 * 说明（controller 对全完成清单自动清空，CC 同款）。纯展示组件。
 */
import { computed } from "vue";
import type { ToolWorkItem } from "@/types/session";
import { isTodoItem, type TodoItem } from "@shared/todo-types.js";

const props = defineProps<{
  tool: ToolWorkItem;
}>();

/** 防御性解析 args.todos：结构守卫逐条过滤，形状不符按空清单渲染。 */
const todos = computed<TodoItem[]>(() => {
  const args = props.tool.args;
  if (typeof args !== "object" || args === null || !Array.isArray((args as { todos?: unknown }).todos)) {
    return [];
  }
  return (args as { todos: unknown[] }).todos.filter(isTodoItem);
});

const completedCount = computed(() => todos.value.filter((item) => item.status === "completed").length);
const allCompleted = computed(() => todos.value.length > 0 && completedCount.value === todos.value.length);

/** 行文案：进行中行显示 activeForm ?? content（CC spinner 同款进行时文案），其余显示 content。 */
function rowText(item: TodoItem): string {
  return item.status === "in_progress" ? (item.activeForm ?? item.content) : item.content;
}
</script>

<template>
  <div class="td-todo">
    <!-- 空清单：显式清空（或全完成被 controller 收尾后模型补发的空写入）。 -->
    <div v-if="todos.length === 0" class="td-todo-empty">清单已清空</div>
    <template v-else>
      <div class="td-todo-stat">
        <span>{{ completedCount }}/{{ todos.length }} 完成</span>
        <span v-if="allCompleted" class="td-todo-done-hint">全部完成，清单已收尾</span>
      </div>
      <div class="td-todo-scroll">
        <div
          v-for="(item, index) in todos"
          :key="index"
          class="td-todo-row"
          :class="item.status"
          :title="item.content"
        >
          <span class="td-todo-mark" aria-hidden="true">{{ item.status === "completed" ? "✓" : item.status === "in_progress" ? "▶" : "○" }}</span>
          <span class="td-todo-text">{{ rowText(item) }}</span>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.td-todo {
  min-width: 0;
}

.td-todo-empty {
  font-size: var(--pix-text-xs);
  color: var(--pix-text-muted);
  padding: 2px 0;
}

.td-todo-stat {
  display: flex;
  align-items: baseline;
  gap: var(--pix-space-sm);
  font-size: var(--pix-text-xs);
  color: var(--pix-text-muted);
  font-variant-numeric: tabular-nums;
  padding: 2px 0;
}

.td-todo-done-hint {
  color: var(--pix-success);
  font-weight: var(--pix-weight-medium);
}

.td-todo-scroll {
  max-height: 260px;
  overflow-y: auto;
  border: 1px solid var(--pix-border-light);
  border-radius: var(--pix-radius-md);
  background: rgba(255, 255, 255, 0.86);
  padding: var(--pix-space-xs) var(--pix-space-sm);
  margin-top: var(--pix-space-xs);
}

.td-todo-row {
  display: flex;
  align-items: baseline;
  gap: 7px;
  min-height: 22px;
  padding: 1px 0;
  font-size: var(--pix-text-xs);
  color: var(--pix-text-primary);
}

.td-todo-mark {
  flex-shrink: 0;
  width: 14px;
  font-size: 10px;
  line-height: 1;
  text-align: center;
  translate: 0 1px;
  color: var(--pix-text-secondary);
}

.td-todo-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  line-height: var(--pix-leading-base);
}

/* completed：弱化 + 划线。 */
.td-todo-row.completed {
  color: var(--pix-text-muted);
}

.td-todo-row.completed .td-todo-mark {
  color: var(--pix-success);
}

.td-todo-row.completed .td-todo-text {
  text-decoration: line-through;
}

/* in_progress：高亮（accent）+ 进行时文案。 */
.td-todo-row.in_progress {
  color: var(--pix-accent);
}

.td-todo-row.in_progress .td-todo-mark {
  color: var(--pix-accent);
}

.td-todo-row.in_progress .td-todo-text {
  font-weight: var(--pix-weight-medium);
}

/* pending：次级色。 */
.td-todo-row.pending .td-todo-text {
  color: var(--pix-text-secondary);
}
</style>
