<script setup lang="ts">
/**
 * LeftPanel - 会话导航侧栏
 */
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import { useRpc } from "../../composables/useRpc";
import { useProjectStore } from "../../stores/project-store";
import { useSessionStore } from "../../stores/session-store";
import { deriveSessionTitle, formatSessionTime } from "@/utils/session-title";
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
const deleteSessionTitle = computed(() => deriveSessionTitle(confirmDeleteSession.value));

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
    const title = deriveSessionTitle(s);
    return title.toLowerCase().includes(query) ||
      s.firstMessage.toLowerCase().includes(query) ||
      s.path.toLowerCase().includes(query);
  });
});

async function newSession(): Promise<void> {
  const result = await rpc.newSession();
  if (result && !result.cancelled) {
    sessionStore.clearSession();
    await projectStore.listSessions();
    projectStore.syncCurrentSession(
      rpc.sessionState.value?.sessionFile,
      rpc.sessionState.value?.sessionId
    );
  }
}

async function handleSelectSession(session: SessionInfo): Promise<void> {
  const result = await rpc.switchSession(session.path);
  if (!result || result.cancelled) return;
  projectStore.setCurrentSession(session);
  const messages = await rpc.getMessages();
  if (messages) {
    sessionStore.loadMessages(messages as AgentMessage[]);
  }
  await projectStore.listSessions();
  projectStore.syncCurrentSession(
    rpc.sessionState.value?.sessionFile,
    rpc.sessionState.value?.sessionId
  );
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
  const wasCurrentSession = projectStore.currentSession?.id === session.id;
  try {
    const result = await window.pixApi.deleteSession(session.path);
    if (result.success) {
      await projectStore.listSessions();
      if (wasCurrentSession) {
        const replacement = projectStore.sessions[0] ?? null;
        if (replacement) {
          await handleSelectSession(replacement);
        } else {
          const newResult = await rpc.newSession();
          if (newResult && !newResult.cancelled) {
            sessionStore.clearSession();
            await projectStore.listSessions();
            projectStore.syncCurrentSession(
              rpc.sessionState.value?.sessionFile,
              rpc.sessionState.value?.sessionId
            );
          } else {
            projectStore.setCurrentSession(null);
            sessionStore.clearSession();
          }
        }
      } else {
        projectStore.syncCurrentSession(
          rpc.sessionState.value?.sessionFile,
          rpc.sessionState.value?.sessionId
        );
      }
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
    <!-- Project header -->
    <div class="panel-header">
      <div class="project-name-row">
        <div class="project-icon">
          {{ (projectStore.currentProject?.name || "P")[0] }}
        </div>
        <div class="project-name" :title="projectStore.currentProject?.name">
          {{ projectStore.currentProject?.name || "未打开项目" }}
        </div>
      </div>
      <div class="project-path" :title="projectPath">{{ projectPath }}</div>
    </div>

    <!-- New session button -->
    <div class="panel-actions">
      <button
        class="new-session-btn"
        :disabled="!rpc.isConnected.value"
        @click="newSession"
      >
        <span class="btn-icon">+</span>
        <span>新建会话</span>
      </button>
    </div>

    <!-- Search -->
    <div class="panel-search">
      <div class="search-wrapper">
        <span class="search-icon">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        </span>
        <input
          v-model="searchQuery"
          type="text"
          class="search-input"
          placeholder="搜索会话..."
          spellcheck="false"
        />
        <button
          v-if="searchQuery"
          class="search-clear"
          @click="searchQuery = ''"
          title="清除"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
    </div>

    <!-- Session list -->
    <div class="session-list">
      <div
        v-for="session in filteredSessions"
        :key="session.id"
        class="session-item"
        :class="{ active: projectStore.currentSession?.id === session.id }"
        @click="handleSelectSession(session)"
      >
        <span v-if="pinnedIds.has(session.id)" class="pin-marker" title="已置顶">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M16,12V4H17V2H7V4H8V12L6,14V16H11.2V22H12.8V16H18V14L16,12Z"/></svg>
        </span>
        <div class="session-info">
          <span class="session-name" :title="deriveSessionTitle(session)">
            {{ deriveSessionTitle(session) }}
          </span>
        </div>
        <span class="session-time">{{ formatSessionTime(session.modified) }}</span>
        <span class="hover-actions">
          <button
            class="hover-btn"
            :class="{ 'pin-active': pinnedIds.has(session.id) }"
            @click.stop="togglePin(session.id)"
            :title="pinnedIds.has(session.id) ? '取消置顶' : '置顶'"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/></svg>
          </button>
          <button
            class="hover-btn danger"
            @click.stop="requestDelete(session)"
            title="删除会话"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>
        </span>
      </div>
      <div v-if="filteredSessions.length === 0" class="empty-hint">
        {{ searchQuery ? '无匹配结果' : '暂无会话' }}
      </div>
    </div>

    <!-- Footer -->
    <div class="panel-footer">
      <button class="footer-btn" @click="goSettings" title="设置">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
      </button>
      <button class="footer-btn" @click="goHome" title="主页">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
      </button>
    </div>

    <!-- Delete confirmation dialog -->
    <v-dialog v-model="showDeleteDialog" max-width="400">
      <v-card class="delete-dialog-card">
        <div class="delete-dialog-title">确认删除</div>
        <div class="delete-dialog-text">
          <span>确定要删除会话</span>
          <strong class="delete-session-name">「{{ deleteSessionTitle }}」</strong>
          <span>吗？此操作不可撤销。</span>
        </div>
        <v-card-actions class="delete-dialog-actions">
          <v-spacer />
          <v-btn variant="text" @click="showDeleteDialog = false">取消</v-btn>
          <v-btn color="error" variant="tonal" :loading="!!deletingSession" @click="executeDelete">删除</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>

<style scoped>
.left-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  user-select: none;
}

/* ── Project header ── */
.panel-header {
  padding: var(--pix-space-lg) var(--pix-space-lg) var(--pix-space-md);
  flex-shrink: 0;
}

.project-name-row {
  display: flex;
  align-items: center;
  gap: var(--pix-space-sm);
}

.project-icon {
  width: 28px;
  height: 28px;
  border-radius: var(--pix-radius-sm);
  background: var(--pix-accent-light);
  color: var(--pix-accent);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  font-size: var(--pix-text-sm);
  font-weight: var(--pix-weight-semibold);
}

.project-name {
  font-size: var(--pix-text-md);
  font-weight: var(--pix-weight-semibold);
  color: var(--pix-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  line-height: 1.3;
}

.project-path {
  font-size: var(--pix-text-xs);
  color: var(--pix-text-secondary);
  font-family: var(--pix-font-ui);
  margin-top: var(--pix-space-xs);
  margin-left: calc(28px + var(--pix-space-sm));
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ── New session button ── */
.panel-actions {
  padding: 0 var(--pix-space-lg) var(--pix-space-md);
  flex-shrink: 0;
}

.new-session-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--pix-space-sm);
  width: 100%;
  padding: var(--pix-space-sm) var(--pix-space-md);
  background: var(--pix-accent);
  color: var(--pix-text-inverse);
  border: none;
  border-radius: var(--pix-radius-md);
  font-size: var(--pix-text-sm);
  font-weight: var(--pix-weight-medium);
  font-family: var(--pix-font-ui);
  cursor: pointer;
  transition: background var(--pix-transition-fast), box-shadow var(--pix-transition-fast);
  box-shadow: var(--pix-shadow-xs);
}

.new-session-btn:hover {
  background: var(--pix-accent-hover);
  box-shadow: var(--pix-shadow-sm);
}

.new-session-btn:active {
  background: var(--pix-accent-hover);
  box-shadow: var(--pix-shadow-none);
  transform: translateY(1px);
}

.new-session-btn:disabled {
  background: var(--pix-border);
  color: var(--pix-text-secondary);
  cursor: not-allowed;
  box-shadow: none;
  transform: none;
}

.new-session-btn .btn-icon {
  font-size: var(--pix-text-lg);
  line-height: 1;
}

/* ── Search ── */
.panel-search {
  padding: 0 var(--pix-space-lg) var(--pix-space-md);
  flex-shrink: 0;
}

.search-wrapper {
  position: relative;
  display: flex;
  align-items: center;
}

.search-icon {
  position: absolute;
  left: 10px;
  color: var(--pix-text-secondary);
  font-size: var(--pix-text-base);
  pointer-events: none;
  line-height: 0;
}

.search-input {
  width: 100%;
  padding: 7px var(--pix-space-sm) 7px 30px;
  border: 1px solid var(--pix-border-light);
  border-radius: var(--pix-radius-md);
  font-size: var(--pix-text-sm);
  font-family: var(--pix-font-ui);
  background: var(--pix-bg-input);
  color: var(--pix-text-primary);
  transition: border-color var(--pix-transition-fast), box-shadow var(--pix-transition-fast);
}

.search-input::placeholder {
  color: var(--pix-text-muted);
}

.search-input:focus {
  outline: none;
  border-color: var(--pix-accent);
  box-shadow: 0 0 0 2px var(--pix-accent-light);
}

.search-clear {
  position: absolute;
  right: 4px;
  padding: 4px;
  color: var(--pix-text-secondary);
  cursor: pointer;
  display: flex;
  align-items: center;
  line-height: 0;
  border-radius: var(--pix-radius-xs);
  transition: color var(--pix-transition-fast), background var(--pix-transition-fast);
}

.search-clear:hover {
  color: var(--pix-text-primary);
  background: var(--pix-bg-hover);
}

/* ── Session list ── */
.session-list {
  flex: 1;
  overflow-y: auto;
  padding: 0 var(--pix-space-sm);
}

.session-item {
  display: flex;
  align-items: center;
  gap: var(--pix-space-sm);
  padding: var(--pix-space-sm) var(--pix-space-md);
  margin-bottom: 2px;
  border-radius: var(--pix-radius-md);
  cursor: pointer;
  transition: background var(--pix-transition-fast);
  min-height: 42px;
  position: relative;
}

.session-item:hover {
  background: var(--pix-bg-hover);
}

.session-item.active {
  background: var(--pix-accent-light);
}

.session-item.active:hover {
  background: var(--pix-accent-light-hover);
}

.session-info {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: var(--pix-space-sm);
}

.session-name {
  font-size: var(--pix-text-sm);
  font-weight: var(--pix-weight-normal);
  color: var(--pix-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
}

.session-item.active .session-name {
  font-weight: var(--pix-weight-medium);
  color: var(--pix-accent);
}

.session-time {
  font-size: var(--pix-text-xs);
  color: var(--pix-text-secondary);
  font-weight: var(--pix-weight-medium);
  flex-shrink: 0;
  min-width: 44px;
  text-align: center;
}

.session-item.active .session-time {
  color: var(--pix-accent);
}

.pin-marker {
  color: var(--pix-accent);
  font-size: var(--pix-text-xs);
  flex-shrink: 0;
  line-height: 0;
}

/* Hover actions */
.hover-actions {
  display: none;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
}

.session-item:hover .hover-actions {
  display: flex;
}

.session-item:hover .session-time {
  display: none;
}

.hover-btn {
  width: 26px;
  height: 26px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--pix-radius-xs);
  color: var(--pix-text-secondary);
  cursor: pointer;
  transition: color var(--pix-transition-fast), background var(--pix-transition-fast);
  font-size: var(--pix-text-sm);
}

.hover-btn:hover {
  color: var(--pix-text-primary);
  background: var(--pix-bg-active);
}

.hover-btn.pin-active {
  color: var(--pix-accent);
}

.hover-btn.danger:hover {
  color: var(--pix-error);
  background: var(--pix-error-bg);
}

/* Empty state */
.empty-hint {
  font-size: var(--pix-text-sm);
  color: var(--pix-text-secondary);
  padding: var(--pix-space-2xl) var(--pix-space-lg);
  text-align: center;
}

/* ── Footer ── */
.panel-footer {
  display: flex;
  justify-content: center;
  gap: var(--pix-space-xs);
  padding: var(--pix-space-sm) var(--pix-space-md);
  border-top: 1px solid var(--pix-border-light);
  flex-shrink: 0;
}

.footer-btn {
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--pix-radius-sm);
  color: var(--pix-text-secondary);
  cursor: pointer;
  transition: color var(--pix-transition-fast), background var(--pix-transition-fast);
  font-size: var(--pix-text-lg);
}

.footer-btn:hover {
  color: var(--pix-text-primary);
  background: var(--pix-bg-hover);
}

.delete-dialog-card {
  padding: var(--pix-space-lg);
}

.delete-dialog-title {
  color: var(--pix-text-primary);
  font-size: var(--pix-text-lg);
  font-weight: var(--pix-weight-semibold);
  line-height: 1.35;
  margin-bottom: var(--pix-space-md);
}

.delete-dialog-text {
  color: var(--pix-text-secondary);
  font-size: var(--pix-text-sm);
  line-height: var(--pix-leading-base);
  word-break: break-word;
}

.delete-session-name {
  color: var(--pix-text-primary);
  font-weight: var(--pix-weight-semibold);
}

.delete-dialog-actions {
  padding: var(--pix-space-lg) 0 0;
}
</style>
