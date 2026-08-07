<script setup lang="ts">
/**
 * Workspace Page
 *
 * Three-panel layout:
 * - Left: session navigation
 * - Center: session content + composer
 * - Right: inspector (status, tokens, errors)
 */
import { computed, onMounted, onUnmounted, ref } from "vue";
import { watch } from "vue";
import { useRouter } from "vue-router";
import { useSessionStore, useTeamLeaderSessionStore } from "../stores/session-store";
import { useRpc } from "../composables/useRpc";
import { useTeamLeaderRpc } from "../composables/useTeamLeaderRpc";
import { useProjectStore } from "../stores/project-store";
import { useAuthStore } from "../stores/auth-store";
import { useTeamStore } from "../stores/team-store";
import AppLayout from "../components/layout/AppLayout.vue";
import LeftPanel from "../components/layout/LeftPanel.vue";
import CenterPanel from "../components/layout/CenterPanel.vue";
import RightPanel from "../components/layout/RightPanel.vue";
import { toPlain } from "../utils/plain";
import type { AgentMessage, RequestUserInputRequest } from "@/types/rpc";
import type { ProjectLocation } from "@/types/session";

const router = useRouter();
const singleSessionStore = useSessionStore();
const teamLeaderSessionStore = useTeamLeaderSessionStore();
const projectStore = useProjectStore();
const authStore = useAuthStore();
const teamStore = useTeamStore();
const singleRpc = useRpc();
const teamLeaderRpc = useTeamLeaderRpc();
let unsubscribeEvent: (() => void) | null = null;
let unsubscribeUserInput: (() => void) | null = null;
let unsubscribeTeamLeaderEvent: (() => void) | null = null;
let unsubscribeTeamLeaderUserInput: (() => void) | null = null;
let unsubscribeTeamEvent: (() => void) | null = null;
const pendingUserInput = ref<RequestUserInputRequest | null>(null);
const pendingUserInputMode = ref<"single" | "team">("single");
const userInputAnswers = ref<Record<string, string>>({});
const currentQuestionIndex = ref(0);
const currentAnswer = ref("");
const subscriptionsReady = ref(false);

/** Concrete backend startup error (distro/path diagnostics from the main
 *  process), surfaced on the workspace so WSL setup failures stay actionable
 *  instead of being folded into a generic startup failure. */
const startupError = ref<string | null>(null);

const currentQuestion = computed(() => {
  const req = pendingUserInput.value;
  if (!req || currentQuestionIndex.value >= req.questions.length) return null;
  return req.questions[currentQuestionIndex.value];
});

const totalQuestions = computed(() => pendingUserInput.value?.questions.length ?? 0);

const answeredSummary = computed(() => {
  const req = pendingUserInput.value;
  if (!req) return [];
  return req.questions.map((q, i) => ({
    field: q.header,
    value: userInputAnswers.value[q.id] || "",
    checked: !!userInputAnswers.value[q.id]?.trim(),
    index: i,
  }));
});

function openUserInputRequest(request: RequestUserInputRequest, mode: "single" | "team"): void {
  pendingUserInput.value = request;
  pendingUserInputMode.value = mode;
  currentQuestionIndex.value = 0;
  const next: Record<string, string> = {};
  for (const question of request.questions) {
    next[question.id] = "";
  }
  userInputAnswers.value = next;
  currentAnswer.value = "";
}

async function respondUserInput(cancelled = false): Promise<void> {
  const request = pendingUserInput.value;
  if (!request) return;
  const sourceRpc = pendingUserInputMode.value === "team" ? teamLeaderRpc : singleRpc;
  const response = {
    id: request.id,
    answers: { ...userInputAnswers.value },
    cancelled,
  };
  pendingUserInput.value = null;
  userInputAnswers.value = {};
  currentQuestionIndex.value = 0;
  currentAnswer.value = "";
  try {
    await sourceRpc.sendCommand({ type: "respond_user_input", response });
  } catch (err) {
    console.error("[WorkspacePage] Failed to respond to user input:", err);
  }
}

function discardUserInput(): void {
  pendingUserInput.value = null;
  userInputAnswers.value = {};
  currentQuestionIndex.value = 0;
  currentAnswer.value = "";
}

function advanceToNextQuestion(): void {
  const question = currentQuestion.value;
  if (!question) return;
  userInputAnswers.value[question.id] = currentAnswer.value.trim();
  currentAnswer.value = "";
  if (currentQuestionIndex.value < totalQuestions.value - 1) {
    currentQuestionIndex.value++;
    const nextQ = pendingUserInput.value!.questions[currentQuestionIndex.value];
    currentAnswer.value = userInputAnswers.value[nextQ.id] || "";
  } else {
    void respondUserInput(false);
  }
}

function jumpToQuestion(index: number): void {
  const curQ = currentQuestion.value;
  if (curQ) {
    userInputAnswers.value[curQ.id] = currentAnswer.value.trim();
  }
  currentQuestionIndex.value = index;
  const targetQ = pendingUserInput.value!.questions[index];
  currentAnswer.value = userInputAnswers.value[targetQ.id] || "";
}

function cancelClarification(): void {
  void respondUserInput(true);
}

async function syncWorkspaceState(
  options: { loadMessagesIfEmpty?: boolean } = {},
  mode = teamStore.teamMode,
): Promise<void> {
  // Capture the mode at the start so an in-flight refresh from the old mode
  // cannot switch transports halfway through a mode transition.
  const targetRpc = mode ? teamLeaderRpc : singleRpc;
  const targetStore = mode ? teamLeaderSessionStore : singleSessionStore;
  await targetRpc.refreshState();
  await targetRpc.refreshModels();
  await targetRpc.refreshSessionStats();
  if (teamStore.teamMode !== mode) return;

  if (!mode) {
    await projectStore.listSessions();
    if (teamStore.teamMode !== mode) return;
    projectStore.syncCurrentSession(
      targetRpc.sessionState.value?.sessionFile,
      targetRpc.sessionState.value?.sessionId
    );
  } else {
    await projectStore.listTeamLeaderSessions();
    if (teamStore.teamMode !== mode) return;
    projectStore.syncCurrentTeamSession(
      targetRpc.sessionState.value?.sessionFile,
      targetRpc.sessionState.value?.sessionId,
    );
  }

  if (options.loadMessagesIfEmpty && targetStore.displayBlocks.length === 0) {
    const messages = await targetRpc.getMessages();
    if (teamStore.teamMode !== mode) return;
    if (Array.isArray(messages) && messages.length > 0) {
      targetStore.loadMessages(messages as AgentMessage[]);
    }
  }
}

function clearSessionSubscriptions(): void {
  unsubscribeEvent?.();
  unsubscribeEvent = null;
  unsubscribeUserInput?.();
  unsubscribeUserInput = null;
  unsubscribeTeamLeaderEvent?.();
  unsubscribeTeamLeaderEvent = null;
  unsubscribeTeamLeaderUserInput?.();
  unsubscribeTeamLeaderUserInput = null;
  unsubscribeTeamEvent?.();
  unsubscribeTeamEvent = null;
}

function subscribeToModeEvents(): void {
  clearSessionSubscriptions();

  if (teamStore.teamMode) {
    unsubscribeTeamLeaderEvent = window.pixApi.onTeamLeaderEvent((event) => {
      teamLeaderSessionStore.addEvent(event);
      const shouldRefresh =
        event.type === "agent_start" ||
        event.type === "agent_end" ||
        event.type === "session_info_changed" ||
        (event.type === "message_end" && event.message.role === "user");
      if (shouldRefresh) void syncWorkspaceState();
    });
    unsubscribeTeamLeaderUserInput = window.pixApi.onTeamLeaderUserInputRequest((request) => {
      if (pendingUserInput.value) void respondUserInput(true);
      openUserInputRequest(request, "team");
    });
    unsubscribeTeamEvent = teamStore.subscribeToEvents();
    return;
  }

  unsubscribeEvent = window.pixApi.onPiEvent((event) => {
    singleSessionStore.addEvent(event);
    const shouldRefreshSessions =
      event.type === "agent_start" ||
      event.type === "agent_end" ||
      event.type === "session_info_changed" ||
      (event.type === "message_end" && event.message.role === "user");
    if (shouldRefreshSessions) void syncWorkspaceState();
  });

  unsubscribeUserInput = window.pixApi.onUserInputRequest((request) => {
    if (pendingUserInput.value) void respondUserInput(true);
    openUserInputRequest(request, "single");
  });
}

async function attachTeamRuntimeIfNeeded(location: ProjectLocation): Promise<boolean> {
  // projectStore.currentProject is a Vue reactive proxy; strip reactivity
  // before it crosses the contextBridge/IPC boundary.
  const target = toPlain(location);
  // A team leader still running from a previous process (e.g. the app crashed
  // and reopened) is always re-attached: the team is live and must resume in
  // team mode regardless of the persisted preference.
  if (await window.pixApi.isTeamLeaderRunning()) {
    const attached = await teamLeaderRpc.attachToRunningTeamSession();
    if (attached) {
      teamStore.teamMode = true;
      return true;
    }
  }

  // Otherwise restore team mode only when the user last chose team mode for
  // this workspace. The team snapshot alone must not force team mode: a
  // snapshot is deliberately preserved when switching to solo (so the user can
  // resume the team later), but restoring purely on its existence caused the
  // workspace to jump back to team mode on every remount - including after a
  // visit to settings - discarding the user's solo choice.
  const lastMode = await window.pixApi.getWorkspaceMode(target);
  if (lastMode !== "team") return false;
  if (!(await window.pixApi.hasTeamSnapshot(target))) return false;
  const started = await teamStore.toggleTeamMode(target);
  if (!started) {
    // toggleTeamMode stores the concrete error in teamStore.lastError, which
    // has no visible surface while still in solo mode (TeamDashboard is not
    // mounted). Keep the distro/path diagnostic visible on the workspace.
    startupError.value = teamStore.lastError || "启动团队运行环境失败";
    return false;
  }
  startupError.value = null;
  return true;
}

/** Re-attempt a failed team runtime startup from the error banner. */
async function retryStartup(): Promise<void> {
  const location = projectStore.currentProject;
  if (!location) {
    startupError.value = null;
    return;
  }
  const started = await attachTeamRuntimeIfNeeded(location);
  if (!started) {
    startupError.value = teamStore.lastError || startupError.value;
  }
}

watch(() => teamStore.teamMode, async () => {
  if (!subscriptionsReady.value) return;
  // A fresh mode switch supersedes any stale startup error from the previous
  // one; failures of the new switch surface via their own alerts/banner.
  startupError.value = null;
  discardUserInput();
  singleSessionStore.clearSession();
  teamLeaderSessionStore.clearSession();
  subscribeToModeEvents();
  await syncWorkspaceState({ loadMessagesIfEmpty: true });
  if (teamStore.teamMode) {
    await teamStore.fetchTeamState();
    await teamStore.fetchTeamHistory();
  }
});

onMounted(async () => {
  // Strip reactivity so the location can cross the IPC boundary.
  const location = toPlain(projectStore.currentProject);
  if (!singleRpc.isConnected.value) {
    const attached = await singleRpc.attachToRunningSession();
    const teamLeaderRunning = location ? await window.pixApi.isTeamLeaderRunning() : false;
    const hasTeamSnapshot = location ? await window.pixApi.hasTeamSnapshot(location) : false;
    if (!attached && !teamLeaderRunning && !hasTeamSnapshot) {
      await router.push("/");
      return;
    }
  }

  if (location && !teamStore.teamMode) {
    const teamStarted = await attachTeamRuntimeIfNeeded(location);
    if (teamStarted) {
      // Team runtime startup owns the leader session and TeamManager. The
      // subscriptions below are installed only after the mode is selected.
      teamLeaderSessionStore.clearSession();
    }
  }

  // Fetch provider auth status so the model selector shows correct badges.
  try { await authStore.refreshStatus(); } catch { /* non-fatal */ }

  await syncWorkspaceState({ loadMessagesIfEmpty: true });
  subscribeToModeEvents();
  if (teamStore.teamMode) {
    await teamStore.fetchTeamState();
    await teamStore.fetchTeamHistory();
  }
  subscriptionsReady.value = true;
});

onUnmounted(() => {
  subscriptionsReady.value = false;
  clearSessionSubscriptions();
  if (pendingUserInput.value) void respondUserInput(true);
});
</script>

<template>
  <div class="workspace-page">
    <div v-if="startupError" class="startup-error-banner" role="alert">
      <span class="startup-error-icon">
        <v-icon icon="mdi-alert-circle-outline" size="16" />
      </span>
      <span class="startup-error-text">启动失败：{{ startupError }}</span>
      <button class="startup-error-btn" type="button" @click="retryStartup">重试</button>
      <button class="startup-error-btn" type="button" @click="startupError = null">关闭</button>
    </div>
    <AppLayout :team-mode="teamStore.teamMode">
    <template #left>
      <LeftPanel />
    </template>
    <template #center>
      <CenterPanel
        :pending-user-input="pendingUserInput"
        :current-question-index="currentQuestionIndex"
        :current-answer="currentAnswer"
        :current-question="currentQuestion"
        :total-questions="totalQuestions"
        :answered-summary="answeredSummary"
        @update:current-answer="currentAnswer = $event"
        @advance-question="advanceToNextQuestion"
        @jump-to-question="jumpToQuestion"
        @cancel-clarification="cancelClarification"
      />
    </template>
    <template #right>
      <RightPanel />
    </template>
    </AppLayout>
  </div>
</template>


<style scoped>
.workspace-page {
  display: flex;
  flex-direction: column;
  height: 100%;
}

/* The child AppLayout keeps its own height:100% rule; as a flex item it is
   shrunk by the banner instead of overflowing. */
.workspace-page > .app-layout {
  flex: 1 1 0;
  min-height: 0;
  height: auto;
}

.startup-error-banner {
  display: flex;
  align-items: center;
  gap: var(--pix-space-sm);
  margin: calc(var(--pix-window-controls-height) + 4px) 12px 0;
  padding: var(--pix-space-sm) var(--pix-space-md);
  border: 1px solid var(--pix-error-light);
  border-radius: var(--pix-radius-lg);
  background: var(--pix-error-bg);
  color: var(--pix-error);
  flex-shrink: 0;
}

.startup-error-icon {
  display: inline-flex;
  align-items: center;
  flex-shrink: 0;
}

.startup-error-text {
  flex: 1;
  min-width: 0;
  font-size: var(--pix-text-sm);
  line-height: var(--pix-leading-base);
  word-break: break-word;
  white-space: pre-wrap;
}

.startup-error-btn {
  flex-shrink: 0;
  padding: 3px 10px;
  border: 1px solid var(--pix-error-light);
  border-radius: var(--pix-radius-md);
  background: rgba(255, 255, 255, 0.8);
  color: var(--pix-error);
  font-size: var(--pix-text-xs);
  font-weight: var(--pix-weight-medium);
  font-family: var(--pix-font-ui);
  cursor: pointer;
}

.startup-error-btn:hover {
  background: #ffffff;
}
</style>
