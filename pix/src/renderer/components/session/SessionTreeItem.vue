<script setup lang="ts">
import { computed } from "vue";
import type { TreeEntry } from "@/types/rpc";

const props = defineProps<{ node: TreeEntry; expanded: Set<string>; depth: number }>();
const emit = defineEmits<{ toggle: [id: string]; navigate: [id: string] }>();
const hasChildren = computed(() => (props.node.children?.length ?? 0) > 0);
const isExpanded = computed(() => props.expanded.has(props.node.id));
const label = computed(() => {
  if (props.node.label) return props.node.label;
  if (props.node.messagePreview) {
    const preview = props.node.messagePreview.slice(0, 60);
    return props.node.messagePreview.length > 60 ? preview + "..." : preview;
  }
  switch (props.node.type) {
    case "message": return "消息";
    case "model_change": return "模型变更";
    case "thinking_level_change": return "思考级别变更";
    case "compaction": return "上下文压缩";
    case "branch_summary": return "分支摘要";
    case "custom": return "自定义事件";
    case "custom_message": return "自定义消息";
    case "label": return "标签";
    default: return props.node.type;
  }
});
const icon = computed(() => {
  switch (props.node.type) {
    case "message": return "mdi-message-outline";
    case "model_change": return "mdi-wrench-outline";
    case "thinking_level_change": return "mdi-brain";
    case "compaction": return "mdi-package-variant";
    case "branch_summary": return "mdi-clipboard-text-outline";
    case "custom": return "mdi-cog-outline";
    case "custom_message": return "mdi-email-outline";
    case "label": return "mdi-tag-outline";
    default: return "mdi-circle-small";
  }
});
const time = computed(() => {
  const date = new Date(props.node.timestamp);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
});
</script>

<template>
  <div class="tree-item">
    <div class="tree-row" :style="{ paddingLeft: `${depth * 20}px` }" @click="emit('navigate', node.id)">
      <button
        v-if="hasChildren"
        class="tree-toggle"
        :aria-expanded="isExpanded"
        :aria-label="`${isExpanded ? '收起' : '展开'}${label}`"
        @click.stop="emit('toggle', node.id)"
      >
        {{ isExpanded ? '▾' : '▸' }}
      </button>
      <span v-else class="tree-toggle-placeholder"></span>
      <span class="tree-icon"><v-icon :icon="icon" size="14" /></span>
      <span class="tree-label">{{ label }}</span>
      <span class="tree-time">{{ time }}</span>
    </div>
    <template v-if="isExpanded && hasChildren">
      <SessionTreeItem
        v-for="child in node.children"
        :key="child.id"
        :node="child"
        :expanded="expanded"
        :depth="depth + 1"
        @toggle="emit('toggle', $event)"
        @navigate="emit('navigate', $event)"
      />
    </template>
  </div>
</template>

<style scoped>
.tree-item {
  user-select: none;
}

.tree-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 8px;
  border-radius: var(--pix-radius-lg);
  cursor: pointer;
  font-size: var(--pix-text-sm);
  transition: background var(--pix-transition-fast);
}

.tree-row:hover {
  background: var(--pix-bg-hover);
}

.tree-toggle {
  width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  color: var(--pix-text-muted);
  flex-shrink: 0;
  border-radius: var(--pix-radius-sm);
}

.tree-toggle:hover {
  background: var(--pix-bg-active);
  color: var(--pix-accent);
}

.tree-toggle-placeholder {
  width: 20px;
  flex-shrink: 0;
}

.tree-icon {
  flex-shrink: 0;
  width: 22px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--pix-radius-md);
  background: var(--pix-bg-code);
  font-size: 12px;
}

.tree-label {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--pix-text-primary);
}

.tree-time {
  flex-shrink: 0;
  font-size: 10px;
  color: var(--pix-text-muted);
  font-family: var(--pix-font-mono);
}
</style>

