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
import type { AgentMessage, RequestUserInputRequest } from "@/types/rpc";

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

async function attachTeamRuntimeIfNeeded(projectDir: string): Promise<boolean> {
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
  const lastMode = await window.pixApi.getWorkspaceMode(projectDir);
  if (lastMode !== "team") return false;
  if (!(await window.pixApi.hasTeamSnapshot(projectDir))) return false;
  return teamStore.toggleTeamMode(projectDir);
}

watch(() => teamStore.teamMode, async () => {
  if (!subscriptionsReady.value) return;
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
  const projectDir = projectStore.currentProject?.path;
  if (!singleRpc.isConnected.value) {
    const attached = await singleRpc.attachToRunningSession();
    const teamLeaderRunning = projectDir ? await window.pixApi.isTeamLeaderRunning() : false;
    const hasTeamSnapshot = projectDir ? await window.pixApi.hasTeamSnapshot(projectDir) : false;
    if (!attached && !teamLeaderRunning && !hasTeamSnapshot) {
      await router.push("/");
      return;
    }
  }

  if (projectDir && !teamStore.teamMode) {
    const teamStarted = await attachTeamRuntimeIfNeeded(projectDir);
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
</template>


<style scoped>
</style>
