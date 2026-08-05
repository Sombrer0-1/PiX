<script setup lang="ts">
/**
 * LeftPanel - project and session navigation.
 */
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import { useRpc } from "../../composables/useRpc";
import { useTeamLeaderRpc } from "../../composables/useTeamLeaderRpc";
import { useProjectStore } from "../../stores/project-store";
import { useSessionStore, useTeamLeaderSessionStore } from "../../stores/session-store";
import { useTeamStore } from "../../stores/team-store";
import { deriveSessionTitle, formatSessionTime } from "@/utils/session-title";
import type { AgentMessage } from "@/types/rpc";
import type { SessionInfo } from "@/types/session";

const router = useRouter();
const rpc = useRpc();
const teamLeaderRpc = useTeamLeaderRpc();
const projectStore = useProjectStore();
const sessionStore = useSessionStore();
const teamLeaderSessionStore = useTeamLeaderSessionStore();
const teamStore = useTeamStore();

const searchQuery = ref("");
const pinnedIds = ref<Set<string>>(new Set());
const deletingSession = ref<string | null>(null);
const showDeleteDialog = ref(false);
const confirmDeleteSession = ref<SessionInfo | null>(null);
const deleteError = ref<string | null>(null);
const showNewTeamDialog = ref(false);
const isCreatingTeamSession = ref(false);

const projectPath = computed(() => projectStore.currentProject?.path || "");
const deleteSessionTitle = computed(() => deriveSessionTitle(confirmDeleteSession.value));
const currentSessionId = computed(() => {
  if (teamStore.teamMode) {
    return projectStore.currentTeamSession?.id ?? teamLeaderRpc.sessionState.value?.sessionId ?? "";
  }
  return projectStore.currentSession?.id ?? rpc.sessionState.value?.sessionId ?? "";
});

const filteredSessions = computed(() => {
  const sessions = [...(teamStore.teamMode ? projectStore.teamSessions : projectStore.sessions)];
  sessions.sort((a, b) => {
    const aPinned = pinnedIds.value.has(a.id);
    const bPinned = pinnedIds.value.has(b.id);
    if (aPinned && !bPinned) return -1;
    if (!aPinned && bPinned) return 1;
    return b.modified - a.modified;
  });

  const query = searchQuery.value.trim().toLowerCase();
  if (!query) return sessions;

  return sessions.filter((session) => {
    const title = deriveSessionTitle(session).toLowerCase();
    return title.includes(query) ||
      session.firstMessage.toLowerCase().includes(query) ||
      session.path.toLowerCase().includes(query);
  });
});

function isCurrentTeamSession(session: SessionInfo): boolean {
  return teamStore.teamMode && currentSessionId.value === session.id;
}

async function refreshCurrentSession(): Promise<void> {
  await projectStore.listSessions();
  projectStore.syncCurrentSession(
    rpc.sessionState.value?.sessionFile,
    rpc.sessionState.value?.sessionId,
  );
}

async function refreshCurrentTeamSession(): Promise<void> {
  await projectStore.listTeamLeaderSessions();
  projectStore.syncCurrentTeamSession(
    teamLeaderRpc.sessionState.value?.sessionFile,
    teamLeaderRpc.sessionState.value?.sessionId,
  );
}

async function newSession(): Promise<void> {
  if (teamStore.teamMode) {
    const switched = await teamStore.toggleTeamMode(projectPath.value);
    if (!switched) return;
  }
  const result = await rpc.newSession();
  if (!result || result.cancelled) return;
  sessionStore.clearSession();
  await refreshCurrentSession();
}

async function newTeamSession(): Promise<void> {
  if (!teamStore.teamMode) {
    const switched = await teamStore.toggleTeamMode(projectPath.value);
    if (!switched) {
      // TeamDashboard only mounts once teamMode is true, so while still in
      // solo mode teamStore.lastError is invisible. Surface the failure here
      // so the button does not appear non-functional. Mirrors the alert used
      // by HomePage.startFreshWorkspace on toggle failure.
      alert(`启动团队失败：${teamStore.lastError || "未知错误"}`);
      return;
    }
  }

  // Team runtime startup may restore a snapshot before the renderer receives
  // its team event. Query the authoritative state before deciding whether to
  // create a fresh team.
  await teamStore.fetchTeamState();

  if (teamStore.isTeamActive) {
    showNewTeamDialog.value = true;
    return;
  }

  await createFreshTeamSession();
}

async function createFreshTeamSession(): Promise<void> {
  if (isCreatingTeamSession.value) return;
  isCreatingTeamSession.value = true;

  try {
    if (teamStore.isTeamActive) {
      const stopped = await teamStore.stopTeam();
      if (!stopped) return;
      await teamStore.fetchTeamState();
    }
    const result = await teamLeaderRpc.newSession();
    if (!result || result.cancelled) return;
    teamLeaderSessionStore.clearSession();
    await Promise.all([
      teamLeaderRpc.refreshState(),
      teamLeaderRpc.refreshCommands(),
      teamLeaderRpc.refreshModels(),
      teamLeaderRpc.refreshSessionStats(),
    ]);
    await refreshCurrentTeamSession();
    await teamStore.createTeam();
    showNewTeamDialog.value = false;
  } finally {
    isCreatingTeamSession.value = false;
  }
}

async function handleSelectSession(session: SessionInfo): Promise<void> {
  if (teamStore.teamMode) {
    const result = await teamLeaderRpc.switchSession(session.path);
    if (!result || result.cancelled) return;

    projectStore.setCurrentTeamSession(session);
    const messages = await teamLeaderRpc.getMessages();
    if (Array.isArray(messages)) {
      teamLeaderSessionStore.loadMessages(messages as AgentMessage[]);
    }
    await refreshCurrentTeamSession();
    return;
  }

  const result = await rpc.switchSession(session.path);
  if (!result || result.cancelled) return;

  projectStore.setCurrentSession(session);
  const messages = await rpc.getMessages();
  if (messages) {
    sessionStore.loadMessages(messages as AgentMessage[]);
  }
  await refreshCurrentSession();
}

function togglePin(sessionId: string): void {
  const next = new Set(pinnedIds.value);
  if (next.has(sessionId)) next.delete(sessionId);
  else next.add(sessionId);
  pinnedIds.value = next;
}

function requestDelete(session: SessionInfo): void {
  confirmDeleteSession.value = session;
  deleteError.value = null;
  showDeleteDialog.value = true;
}

async function executeDelete(): Promise<void> {
  const session = confirmDeleteSession.value;
  if (!session) return;

  const deletingTeamSession = teamStore.teamMode;
  deletingSession.value = session.id;
  deleteError.value = null;
  const wasCurrentSession = currentSessionId.value === session.id;

  try {
    const result = await window.pixApi.deleteSession(session.path);
    if (!result.success) {
      deleteError.value = result.error || "删除会话失败";
      return;
    }

    if (deletingTeamSession) {
      await projectStore.listTeamLeaderSessions();
    } else {
      await projectStore.listSessions();
    }

    if (teamStore.teamMode !== deletingTeamSession) return;

    if (wasCurrentSession) {
      const replacement = deletingTeamSession
        ? projectStore.teamSessions[0] ?? null
        : projectStore.sessions[0] ?? null;
      if (replacement) {
        await handleSelectSession(replacement);
      } else {
        const activeRpc = deletingTeamSession ? teamLeaderRpc : rpc;
        const activeSessionStore = deletingTeamSession ? teamLeaderSessionStore : sessionStore;
        const newResult = await activeRpc.newSession();
        if (newResult && !newResult.cancelled) {
          activeSessionStore.clearSession();
          if (deletingTeamSession) {
            await refreshCurrentTeamSession();
          } else {
            await refreshCurrentSession();
          }
        } else {
          if (deletingTeamSession) {
            projectStore.setCurrentTeamSession(null);
          } else {
            projectStore.setCurrentSession(null);
          }
          activeSessionStore.clearSession();
        }
      }
    } else if (deletingTeamSession) {
      await refreshCurrentTeamSession();
    } else {
      await refreshCurrentSession();
    }
  } catch (err) {
    console.error("[LeftPanel] Delete session failed:", err);
    deleteError.value = err instanceof Error ? err.message : String(err);
  } finally {
    deletingSession.value = null;
    if (!deleteError.value) {
      confirmDeleteSession.value = null;
      showDeleteDialog.value = false;
    }
  }
}

function goHome(): void { void router.push("/"); }
function goSettings(): void { void router.push("/settings"); }
</script>

<template>
  <div class="left-panel" :class="{ 'team-mode': teamStore.teamMode }">
    <div class="panel-header">
      <div class="project-name-row">
        <div class="project-icon">
          {{ (projectStore.currentProject?.name || "P")[0] }}
        </div>
        <div class="project-name" :title="projectStore.currentProject?.name">
          {{ projectStore.currentProject?.name || "未打开项目" }}
        </div>
        <span class="project-mode-label">{{ teamStore.teamMode ? "团队" : "单人" }}</span>
      </div>
      <div class="project-path" :title="projectPath">{{ projectPath }}</div>
    </div>

    <div class="panel-actions">
      <button
        class="new-session-btn"
        :disabled="!projectPath || (!teamStore.teamMode && !rpc.isConnected.value) || teamStore.isLoading || isCreatingTeamSession"
        @click="newSession"
      >
        <span class="btn-icon">+</span>
        <span>{{ teamStore.teamMode ? "新建单人会话" : "新建会话" }}</span>
      </button>
      <button
        class="new-team-session-btn"
        :disabled="!projectPath || teamStore.isLoading || isCreatingTeamSession"
        @click="newTeamSession"
      >
        <v-icon icon="mdi-account-group-outline" size="15" />
        <span>{{ isCreatingTeamSession ? "正在启动团队..." : "新建团队会话" }}</span>
      </button>
    </div>

    <div class="panel-search">
      <div class="search-wrapper">
        <span class="search-icon">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        </span>
        <input
          v-model="searchQuery"
          type="text"
          class="search-input"
          :placeholder="teamStore.teamMode ? '搜索团队会话...' : '搜索会话...'"
          spellcheck="false"
        />
        <button
          v-if="searchQuery"
          class="search-clear"
          title="清除搜索"
          aria-label="清除搜索"
          @click="searchQuery = ''"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
    </div>

    <div class="session-list">
      <div
        v-for="session in filteredSessions"
        :key="session.id"
        class="session-item"
        :class="{
          active: currentSessionId === session.id,
          'team-session': isCurrentTeamSession(session),
        }"
        @click="handleSelectSession(session)"
      >
        <span v-if="pinnedIds.has(session.id)" class="pin-marker" title="已置顶">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M16,12V4H17V2H7V4H8V12L6,14V16H11.2V22H12.8V16H18V14L16,12Z"/></svg>
        </span>
        <span v-if="isCurrentTeamSession(session)" class="team-marker" title="当前团队会话">
          <v-icon icon="mdi-account-group-outline" size="12" />
        </span>
        <div class="session-info">
          <span class="session-name" :title="deriveSessionTitle(session)">
            {{ deriveSessionTitle(session) }}
          </span>
          <span v-if="isCurrentTeamSession(session)" class="session-kind">团队</span>
        </div>
        <span class="session-time">{{ formatSessionTime(session.modified) }}</span>
        <span class="hover-actions">
          <button
            class="hover-btn"
            :class="{ 'pin-active': pinnedIds.has(session.id) }"
            :title="pinnedIds.has(session.id) ? '取消置顶' : '置顶'"
            @click.stop="togglePin(session.id)"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/></svg>
          </button>
          <button
            class="hover-btn danger"
            title="删除会话"
            @click.stop="requestDelete(session)"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>
        </span>
      </div>
      <div v-if="filteredSessions.length === 0" class="empty-hint">
        {{ searchQuery ? "没有匹配的会话" : "暂无会话" }}
      </div>
    </div>

    <div class="panel-footer">
      <button class="footer-btn" title="设置" aria-label="设置" @click="goSettings">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
      </button>
      <button class="footer-btn" title="首页" aria-label="首页" @click="goHome">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
      </button>
    </div>

    <v-dialog v-model="showNewTeamDialog" max-width="420" :persistent="isCreatingTeamSession">
      <v-card class="delete-dialog-card">
        <div class="delete-dialog-title">新建团队会话</div>
        <div class="delete-dialog-text">
          当前团队 <strong class="delete-session-name">{{ teamStore.teamName }}</strong> 将停止并解散，已完成的工作会保留在项目中。
        </div>
        <v-card-actions class="delete-dialog-actions">
          <v-spacer />
          <v-btn variant="text" :disabled="isCreatingTeamSession" @click="showNewTeamDialog = false">取消</v-btn>
          <v-btn color="error" variant="tonal" :loading="isCreatingTeamSession" @click="createFreshTeamSession">
            停止并新建
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <v-dialog v-model="showDeleteDialog" max-width="400">
      <v-card class="delete-dialog-card">
        <div class="delete-dialog-title">删除会话</div>
        <div class="delete-dialog-text">
          确定删除 <strong class="delete-session-name">{{ deleteSessionTitle }}</strong>？此操作无法撤销。
        </div>
        <div v-if="deleteError" class="delete-dialog-error">{{ deleteError }}</div>
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
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.96), rgba(252, 252, 255, 0.9));
}

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
  width: 38px;
  height: 38px;
  border-radius: 11px;
  background: linear-gradient(135deg, #7567f5 0%, #5142df 100%);
  color: var(--pix-text-inverse);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  font-size: var(--pix-text-lg);
  font-weight: var(--pix-weight-bold);
  box-shadow: 0 10px 22px rgba(98, 84, 243, 0.26);
}

.project-name {
  font-size: var(--pix-text-base);
  font-weight: var(--pix-weight-semibold);
  color: var(--pix-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  line-height: 1.3;
}

.project-mode-label {
  display: inline-flex;
  align-items: center;
  min-height: 20px;
  padding: 2px 6px;
  border-radius: var(--pix-radius-sm);
  background: var(--pix-bg-hover);
  color: var(--pix-text-muted);
  font-size: 9px;
  font-weight: var(--pix-weight-semibold);
  text-transform: uppercase;
}

.team-mode .project-mode-label {
  background: #eaf6f1;
  color: #13795b;
}

.team-mode .project-icon {
  background: #13795b;
  box-shadow: 0 10px 22px rgba(19, 121, 91, 0.2);
}

.project-path {
  font-size: var(--pix-text-xs);
  color: var(--pix-text-muted);
  margin-top: 4px;
  margin-left: calc(38px + var(--pix-space-sm));
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.panel-actions {
  display: grid;
  gap: var(--pix-space-xs);
  padding: 0 var(--pix-space-lg) var(--pix-space-md);
  flex-shrink: 0;
}

.new-session-btn,
.new-team-session-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--pix-space-sm);
  width: 100%;
  min-height: 40px;
  border-radius: var(--pix-radius-lg);
  font-size: var(--pix-text-sm);
  font-weight: var(--pix-weight-medium);
  font-family: var(--pix-font-ui);
  cursor: pointer;
  transition: box-shadow var(--pix-transition-fast), transform var(--pix-transition-fast), filter var(--pix-transition-fast);
}

.team-mode .new-session-btn {
  border: 1px solid var(--pix-border-light);
  background: #ffffff;
  color: var(--pix-accent);
  box-shadow: none;
}

.team-mode .new-team-session-btn {
  border-color: #13795b;
  background: #13795b;
  color: #ffffff;
  box-shadow: 0 10px 20px rgba(19, 121, 91, 0.18);
}

.new-session-btn {
  background: linear-gradient(135deg, #7567f5 0%, #5142df 100%);
  color: var(--pix-text-inverse);
  box-shadow: 0 12px 24px rgba(98, 84, 243, 0.22);
}

.new-team-session-btn {
  border: 1px solid var(--pix-border-light);
  background: #fff;
  color: var(--pix-accent);
}

.new-session-btn:hover,
.new-team-session-btn:hover {
  box-shadow: 0 12px 24px rgba(98, 84, 243, 0.18);
  filter: saturate(1.05);
  transform: translateY(-1px);
}

.new-session-btn:disabled,
.new-team-session-btn:disabled {
  background: var(--pix-border);
  color: var(--pix-text-secondary);
  cursor: not-allowed;
  box-shadow: none;
  transform: none;
}

.btn-icon {
  font-size: var(--pix-text-lg);
  line-height: 1;
}

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
  pointer-events: none;
  line-height: 0;
}

.search-input {
  width: 100%;
  height: 40px;
  padding: 8px 30px 8px 32px;
  border: 1px solid var(--pix-border-light);
  border-radius: var(--pix-radius-lg);
  font-size: var(--pix-text-sm);
  font-family: var(--pix-font-ui);
  background: var(--pix-bg-input);
  color: var(--pix-text-primary);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.72);
}

.search-input::placeholder {
  color: var(--pix-text-muted);
}

.search-input:focus {
  outline: none;
  border-color: var(--pix-accent);
  box-shadow: 0 0 0 3px rgba(98, 84, 243, 0.12);
}

.search-clear {
  position: absolute;
  right: 5px;
  padding: 4px;
  color: var(--pix-text-secondary);
  cursor: pointer;
  display: flex;
  align-items: center;
  line-height: 0;
  border-radius: var(--pix-radius-xs);
}

.search-clear:hover {
  color: var(--pix-text-primary);
  background: var(--pix-bg-hover);
}

.session-list {
  flex: 1;
  overflow-y: auto;
  padding: 0 var(--pix-space-sm) var(--pix-space-sm);
}

.session-item {
  display: flex;
  align-items: center;
  gap: var(--pix-space-sm);
  min-height: 44px;
  padding: 9px var(--pix-space-md);
  margin-bottom: 4px;
  border: 1px solid transparent;
  border-radius: var(--pix-radius-lg);
  cursor: pointer;
  position: relative;
}

.session-item:hover {
  background: var(--pix-bg-hover);
  border-color: var(--pix-border-subtle);
}

.session-item.active {
  background: linear-gradient(90deg, #f0eeff 0%, rgba(240, 238, 255, 0.4) 100%);
  border-color: #e4e0ff;
  box-shadow: inset 3px 0 0 var(--pix-accent);
}

.session-item.team-session {
  border-color: rgba(22, 163, 74, 0.24);
}

.session-info {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: var(--pix-space-xs);
}

.session-name {
  font-size: var(--pix-text-sm);
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

.session-kind {
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--pix-success-bg);
  color: var(--pix-success);
  font-size: 10px;
  font-weight: var(--pix-weight-semibold);
  flex-shrink: 0;
}

.session-time {
  font-size: var(--pix-text-xs);
  color: var(--pix-text-muted);
  font-weight: var(--pix-weight-medium);
  flex-shrink: 0;
  min-width: 44px;
  text-align: center;
}

.pin-marker,
.team-marker {
  display: inline-flex;
  align-items: center;
  color: var(--pix-accent);
  flex-shrink: 0;
}

.team-marker {
  color: var(--pix-success);
}

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

.empty-hint {
  font-size: var(--pix-text-sm);
  color: var(--pix-text-muted);
  padding: var(--pix-space-2xl) var(--pix-space-lg);
  text-align: center;
}

.panel-footer {
  display: flex;
  justify-content: center;
  gap: var(--pix-space-sm);
  padding: var(--pix-space-md);
  border-top: 1px solid var(--pix-border-light);
  flex-shrink: 0;
  background: rgba(255, 255, 255, 0.74);
}

.footer-btn {
  width: 34px;
  height: 34px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--pix-radius-md);
  color: var(--pix-text-secondary);
  cursor: pointer;
}

.footer-btn:hover {
  color: var(--pix-text-primary);
  background: var(--pix-accent-light);
}

.delete-dialog-card {
  padding: var(--pix-space-lg);
  border-radius: var(--pix-radius-xl);
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

.delete-dialog-error {
  margin-top: var(--pix-space-md);
  padding: var(--pix-space-sm) var(--pix-space-md);
  border: 1px solid var(--pix-error-light);
  border-radius: var(--pix-radius-md);
  background: var(--pix-error-bg);
  color: var(--pix-error);
  font-size: var(--pix-text-xs);
  line-height: var(--pix-leading-base);
  word-break: break-word;
}

.delete-dialog-actions {
  padding: var(--pix-space-lg) 0 0;
}
</style>
