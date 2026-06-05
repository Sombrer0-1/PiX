<script setup lang="ts">
/**
 * SessionTreeView - Visualize session branch tree
 *
 * Shows the session's tree structure with entry types and labels.
 * Clicking an entry navigates to that branch.
 */
import { ref, onMounted } from "vue";
import { useRpc } from "../../composables/useRpc";
import type { TreeEntry } from "@/types/rpc";

const rpc = useRpc();
const tree = ref<TreeEntry[]>([]);
const loading = ref(true);
const expandedNodes = ref<Set<string>>(new Set());

onMounted(async () => {
  try {
    const result = await rpc.getTree();
    if (result) {
      tree.value = result;
      // Auto-expand all nodes
      const allIds = new Set<string>();
      function collect(node: TreeEntry) {
        allIds.add(node.id);
        node.children?.forEach(collect);
      }
      result.forEach(collect);
      expandedNodes.value = allIds;
    }
  } catch (err) {
    console.error("[SessionTreeView] Failed to load tree:", err);
  } finally {
    loading.value = false;
  }
});

function toggleNode(id: string): void {
  const next = new Set(expandedNodes.value);
  if (next.has(id)) {
    next.delete(id);
  } else {
    next.add(id);
  }
  expandedNodes.value = next;
}

async function navigateTo(targetId: string): Promise<void> {
  try {
    await rpc.navigateTree(targetId);
    alert("Navigated to tree entry. The session view will reload.");
  } catch (err) {
    console.error("[SessionTreeView] Navigation failed:", err);
  }
}

function getEntryIcon(type: string): string {
  switch (type) {
    case "message": return "💬";
    case "model_change": return "🔧";
    case "thinking_level_change": return "🧠";
    case "compaction": return "📦";
    case "branch_summary": return "📋";
    case "custom": return "⚙️";
    case "custom_message": return "✉️";
    case "label": return "🏷️";
    default: return "•";
  }
}

function getEntryLabel(entry: TreeEntry): string {
  if (entry.label) return entry.label;
  if (entry.messagePreview) {
    const preview = entry.messagePreview.slice(0, 60);
    return entry.messagePreview.length > 60 ? preview + "..." : preview;
  }
  return entry.type;
}

function formatTime(ts: string): string {
  try {
    return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

function hasChildren(node: TreeEntry): boolean {
  return (node.children?.length ?? 0) > 0;
}

function isExpanded(node: TreeEntry): boolean {
  return expandedNodes.value.has(node.id);
}
</script>

<template>
  <div class="tree-view">
    <div v-if="loading" class="tree-loading">Loading tree...</div>
    <div v-else-if="tree.length === 0" class="tree-empty">No session tree available.</div>
    <div v-else class="tree-content">
      <template v-for="root in tree" :key="root.id">
        <TreeItem
          :node="root"
          :expanded="expandedNodes"
          :depth="0"
          @toggle="toggleNode"
          @navigate="navigateTo"
        />
      </template>
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent, type PropType } from "vue";
import type { TreeEntry } from "@/types/rpc";

/**
 * Recursive tree item component - defined inline to avoid circular import issues.
 */
const TreeItem = defineComponent({
  name: "TreeItem",
  props: {
    node: { type: Object as PropType<TreeEntry>, required: true },
    expanded: { type: Object as PropType<Set<string>>, required: true },
    depth: { type: Number, default: 0 },
  },
  emits: ["toggle", "navigate"],
  setup(props, { emit }) {
    const indent = `calc(${props.depth} * 20px)`;
    return {
      indent,
      hasChildren: () => (props.node.children?.length ?? 0) > 0,
      isExpanded: () => props.expanded.has(props.node.id),
      onToggle() { emit("toggle", props.node.id); },
      onNavigate() { emit("navigate", props.node.id); },
      getIcon: (t: string) => {
        switch (t) {
          case "message": return "💬";
          case "model_change": return "🔧";
          case "thinking_level_change": return "🧠";
          case "compaction": return "📦";
          case "branch_summary": return "📋";
          case "label": return "🏷️";
          default: return "•";
        }
      },
      getLabel: (entry: TreeEntry) => {
        if (entry.label) return entry.label;
        if (entry.messagePreview) {
          const preview = entry.messagePreview.slice(0, 60);
          return entry.messagePreview.length > 60 ? preview + "..." : preview;
        }
        return entry.type;
      },
      formatTime: (ts: string) => {
        try { return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
        catch { return ""; }
      },
    };
  },
  template: `
    <div class="tree-item">
      <div
        class="tree-row"
        :style="{ paddingLeft: indent }"
        @click="onNavigate"
      >
        <button
          v-if="hasChildren()"
          class="tree-toggle"
          @click.stop="onToggle"
        >
          {{ isExpanded() ? '▾' : '▸' }}
        </button>
        <span v-else class="tree-toggle-placeholder"></span>
        <span class="tree-icon">{{ getIcon(node.type) }}</span>
        <span class="tree-label">{{ getLabel(node) }}</span>
        <span class="tree-time">{{ formatTime(node.timestamp) }}</span>
      </div>
      <template v-if="isExpanded() && hasChildren()">
        <TreeItem
          v-for="child in node.children"
          :key="child.id"
          :node="child"
          :expanded="expanded"
          :depth="depth + 1"
          @toggle="(id: string) => $emit('toggle', id)"
          @navigate="(id: string) => $emit('navigate', id)"
        />
      </template>
    </div>
  `,
});

export { TreeItem };
</script>

<style scoped>
.tree-view {
  height: 100%;
  overflow-y: auto;
}

.tree-loading,
.tree-empty {
  padding: var(--pix-space-xl);
  text-align: center;
  color: var(--pix-text-muted);
  font-size: var(--pix-text-sm);
}

.tree-content {
  padding: var(--pix-space-md);
}

.tree-item {
  user-select: none;
}

.tree-row {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  border-radius: var(--pix-radius-sm);
  cursor: pointer;
  font-size: var(--pix-text-sm);
}

.tree-row:hover {
  background: var(--pix-bg-hover);
}

.tree-toggle {
  width: 16px;
  height: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  color: var(--pix-text-muted);
  flex-shrink: 0;
}

.tree-toggle-placeholder {
  width: 16px;
  flex-shrink: 0;
}

.tree-icon {
  flex-shrink: 0;
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
