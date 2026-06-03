<script setup lang="ts">
/**
 * LeftPanel - 会话导航侧栏
 */
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import { useRpc } from "../../composables/useRpc";
import { useProjectStore } from "../../stores/project-store";
import { useSessionStore } from "../../stores/session-store";
import type { AgentMessage } from "@/types/rpc";
import type { SessionInfo } from "@/types/session";

const router = useRouter();
const rpc = useRpc();
const projectStore = useProjectStore();
const sessionStore = useSessionStore();

const searchQuery = ref("");
const pinnedIds = ref<Set<string>>(new Set());
const deletingSession = ref<string | null>(null);
const showDeleteDialog = ref(false);
const confirmDeleteSession = ref<SessionInfo | null>(null);

const projectPath = computed(() => projectStore.currentProject?.path || "");

const filteredSessions = computed(() => {
  let sessions = [...projectStore.sessions];
  sessions.sort((a, b) => {
    const aPinned = pinnedIds.value.has(a.id);
    const bPinned = pinnedIds.value.has(b.id);
    if (aPinned && !bPinned) return -1;
    if (!aPinned && bPinned) return 1;
    return 0;
  });
  if (!searchQuery.value) return sessions;
  const query = searchQuery.value.toLowerCase();
  return sessions.filter((s) => {
    const name = s.name || s.id;
    return name.toLowerCase().includes(query) ||
      s.firstMessage.toLowerCase().includes(query) ||
      s.path.toLowerCase().includes(query);
  });
});

async function newSession(): Promise<void> {
  const result = await rpc.newSession();
  if (result && !result.cancelled) {
    sessionStore.clearSession();
    projectStore.setCurrentSession(null);
    await rpc.refreshState();
    await projectStore.listSessions();
  }
}

async function handleSelectSession(session: SessionInfo): Promise<void> {
  projectStore.setCurrentSession(session);
  const result = await rpc.switchSession(session.path);
  if (!result || result.cancelled) return;
  const messages = await rpc.getMessages();
  if (messages) {
    sessionStore.loadMessages(messages as AgentMessage[]);
  }
  await rpc.refreshState();
}

function togglePin(sessionId: string): void {
  const next = new Set(pinnedIds.value);
  if (next.has(sessionId)) next.delete(sessionId);
  else next.add(sessionId);
  pinnedIds.value = next;
}

function requestDelete(session: SessionInfo): void {
  confirmDeleteSession.value = session;
  showDeleteDialog.value = true;
}

async function executeDelete(): Promise<void> {
  const session = confirmDeleteSession.value;
  if (!session) return;
  deletingSession.value = session.id;
  try {
    const result = await window.pixApi.deleteSession(session.path);
    if (result.success) {
      if (projectStore.currentSession?.id === session.id) {
        projectStore.setCurrentSession(null);
        sessionStore.clearSession();
      }
      await projectStore.listSessions();
    }
  } catch (err) {
    console.error("[LeftPanel] 删除会话失败:", err);
  } finally {
    deletingSession.value = null;
    confirmDeleteSession.value = null;
    showDeleteDialog.value = false;
  }
}

function goHome(): void { router.push("/"); }
function goSettings(): void { router.push("/settings"); }
</script>

<template>
  <div class="left-panel">
    <!-- 项目头部 -->
    <div class="panel-header">
      <div class="project-name" :title="projectPath">{{ projectStore.currentProject?.name || "未打开项目" }}</div>
      <div class="project-path" :title="projectPath">{{ projectPath }}</div>
    </div>

    <!-- 操作按钮 -->
    <div class="panel-actions">
      <v-btn variant="tonal" color="primary" block :disabled="!rpc.isConnected.value" @click="newSession">
        + 新建会话
      </v-btn>
    </div>

    <!-- 搜索 -->
    <div class="panel-search">
      <v-text-field v-model="searchQuery" density="compact" variant="outlined" placeholder="搜索会话..." hide-details clearable />
    </div>

    <!-- 会话列表 -->
    <div class="session-list">
      <v-list density="default" bg-color="transparent">
        <v-list-item
          v-for="session in filteredSessions"
          :key="session.id"
          :active="projectStore.currentSession?.id === session.id"
          @click="handleSelectSession(session)"
          class="session-list-item"
          min-height="40"
        >
          <template #title>
            <div class="session-title-row">
              <v-icon v-if="pinnedIds.has(session.id)" size="small" color="primary" class="pin-icon">mdi-pin</v-icon>
              <span class="session-title-text">{{ session.name || session.id.slice(0, 8) }}</span>
            </div>
          </template>
          <template #append>
            <div class="session-actions">
              <span class="msg-count">{{ session.messageCount }} 条</span>
              <span class="hover-actions">
                <v-btn variant="text" size="small"
                  :icon="pinnedIds.has(session.id) ? 'mdi-pin-off' : 'mdi-pin'"
                  :color="pinnedIds.has(session.id) ? 'primary' : undefined"
                  @click.stop="togglePin(session.id)"
                  :title="pinnedIds.has(session.id) ? '取消置顶' : '置顶'" />
                <v-btn variant="text" size="small" icon="mdi-delete" color="error"
                  @click.stop="requestDelete(session)" title="删除会话" />
              </span>
            </div>
          </template>
        </v-list-item>
      </v-list>
      <div v-if="filteredSessions.length === 0" class="empty-hint">
        {{ searchQuery ? '无匹配结果' : '暂无会话' }}
      </div>
    </div>

    <!-- 底部导航 -->
    <div class="panel-footer">
      <v-btn variant="text" icon="mdi-cog" @click="goSettings" title="设置" />
      <v-btn variant="text" icon="mdi-home" @click="goHome" title="主页" />
    </div>

    <!-- 删除确认对话框 -->
    <v-dialog v-model="showDeleteDialog" max-width="400">
      <v-card>
        <v-card-title>确认删除</v-card-title>
        <v-card-text>
          确定要删除会话「{{ confirmDeleteSession?.name || confirmDeleteSession?.id?.slice(0, 8) }}」吗？此操作不可撤销。
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="showDeleteDialog = false">取消</v-btn>
          <v-btn color="error" variant="tonal" :loading="!!deletingSession" @click="executeDelete">删除</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>

<style scoped>
.left-panel { display: flex; flex-direction: column; height: 100%; }
.panel-header { padding: var(--pix-space-md) var(--pix-space-lg); flex-shrink: 0; }
.project-name { font-weight: 600; font-size: var(--pix-text-md); color: var(--pix-text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.project-path { font-size: var(--pix-text-xs); color: var(--pix-text-muted); font-family: var(--pix-font-mono); margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.panel-actions { padding: var(--pix-space-sm) var(--pix-space-lg); flex-shrink: 0; }
.panel-search { padding: var(--pix-space-sm) var(--pix-space-lg); flex-shrink: 0; }
.session-list { flex: 1; overflow-y: auto; }
.session-list-item { cursor: pointer; }
.session-title-row { display: flex; align-items: center; gap: 4px; }
.session-title-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pin-icon { flex-shrink: 0; }
.msg-count { font-size: var(--pix-text-xs); color: var(--pix-text-muted); flex-shrink: 0; }
.session-actions { display: flex; align-items: center; gap: 2px; }
.hover-actions { display: none; align-items: center; gap: 0; }
.session-list-item:hover .hover-actions { display: flex; }
.session-list-item:hover .msg-count { display: none; }
.empty-hint { font-size: var(--pix-text-sm); color: var(--pix-text-muted); padding: var(--pix-space-xl) var(--pix-space-lg); text-align: center; }
.panel-footer { display: flex; justify-content: space-around; padding: var(--pix-space-xs) var(--pix-space-sm); border-top: 1px solid var(--pix-border-light); flex-shrink: 0; }
</style>
