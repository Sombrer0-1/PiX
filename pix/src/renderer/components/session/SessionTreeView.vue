<script setup lang="ts">
/**
 * SessionTreeView - Visualize session branch tree
 *
 * Shows the session's tree structure with entry types and labels.
 * Clicking an entry navigates to that branch.
 *
 * Team mode: the tree belongs to the host runtime session, which is not a
 * discussion participant any more (dev plan §9). In team mode this view only
 * says so — the discussion is the roundtable timeline, not this tree.
 */
import { ref, onMounted, watch } from "vue";
import SessionTreeItem from "./SessionTreeItem.vue";
import { useWorkspaceRpc } from "../../composables/useWorkspaceRpc";
import { useTeamStore } from "../../stores/team-store";
import type { TreeEntry } from "@/types/rpc";

const rpc = useWorkspaceRpc();
const teamStore = useTeamStore();
const tree = ref<TreeEntry[]>([]);
const loading = ref(true);
const expandedNodes = ref<Set<string>>(new Set());

async function loadTree(): Promise<void> {
  const mode = teamStore.teamMode;
  loading.value = true;
  tree.value = [];
  expandedNodes.value = new Set();
  if (mode) {
    // 团队模式下不把 host 会话当讨论树，也不去读它的分支。
    loading.value = false;
    return;
  }
  try {
    const result = await rpc.getTree();
    if (teamStore.teamMode !== mode) return;
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
    if (teamStore.teamMode === mode) loading.value = false;
  }
}

onMounted(() => void loadTree());
watch(() => teamStore.teamMode, () => void loadTree());

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
    alert("已切换到所选分支节点，会话视图将重新加载。");
  } catch (err) {
    console.error("[SessionTreeView] Navigation failed:", err);
  }
}

</script>

<template>
  <div class="tree-view">
    <div v-if="teamStore.teamMode" class="tree-team-notice" data-test="tree-team-notice">
      <v-icon icon="mdi-forum-outline" size="16" />
      <div class="tree-team-notice-text">
        <strong>这里是宿主运行时会话，不是讨论树。</strong>
        <span>团队模式下讨论在圆桌时间线里：结论、分歧与投递状态都在那边，分支树只属于单人会话。</span>
      </div>
    </div>
    <div v-else-if="loading" class="tree-loading">正在加载分支树...</div>
    <div v-else-if="tree.length === 0" class="tree-empty">暂无会话分支树。</div>
    <div v-else class="tree-content">
      <template v-for="root in tree" :key="root.id">
        <SessionTreeItem
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

<style scoped>
.tree-view {
  height: 100%;
  overflow-y: auto;
  max-width: var(--pix-content-max-width);
  margin: 0 auto;
}

.tree-loading,
.tree-empty {
  padding: var(--pix-space-xl);
  text-align: center;
  color: var(--pix-text-muted);
  font-size: var(--pix-text-sm);
}

/* 团队模式：说明这里是宿主运行时会话，不是讨论树（安静蓝反馈、白玻璃）。 */
.tree-team-notice {
  display: flex;
  align-items: flex-start;
  gap: var(--pix-space-sm);
  margin: var(--pix-space-md);
  padding: var(--pix-space-md) var(--pix-space-lg);
  border: 1px solid var(--pix-border-light);
  border-radius: var(--pix-radius-xl);
  background: rgba(255, 255, 255, 0.94);
  box-shadow: var(--pix-shadow-xs);
  color: var(--pix-accent);
}

.tree-team-notice-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.tree-team-notice-text strong {
  color: var(--pix-text-primary);
  font-size: var(--pix-text-sm);
  font-weight: var(--pix-weight-semibold);
}

.tree-team-notice-text span {
  color: var(--pix-text-secondary);
  font-size: var(--pix-text-xs);
  line-height: var(--pix-leading-base);
}

.tree-content {
  padding: var(--pix-space-md);
  background: rgba(255, 255, 255, 0.94);
  border: 1px solid var(--pix-border-light);
  border-radius: var(--pix-radius-xl);
  box-shadow: var(--pix-shadow-xs);
}

</style>
