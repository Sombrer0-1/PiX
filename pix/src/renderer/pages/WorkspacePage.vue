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
import { useRouter } from "vue-router";
import { useSessionStore } from "../stores/session-store";
import { useRpc } from "../composables/useRpc";
import { useProjectStore } from "../stores/project-store";
import { useAuthStore } from "../stores/auth-store";
import AppLayout from "../components/layout/AppLayout.vue";
import LeftPanel from "../components/layout/LeftPanel.vue";
import CenterPanel from "../components/layout/CenterPanel.vue";
import RightPanel from "../components/layout/RightPanel.vue";
import type { AgentMessage, RequestUserInputRequest } from "@/types/rpc";

const router = useRouter();
const sessionStore = useSessionStore();
const projectStore = useProjectStore();
const authStore = useAuthStore();
const rpc = useRpc();
let unsubscribeEvent: (() => void) | null = null;
let unsubscribeUserInput: (() => void) | null = null;
const pendingUserInput = ref<RequestUserInputRequest | null>(null);
const userInputAnswers = ref<Record<string, string>>({});
const currentQuestionIndex = ref(0);
const currentAnswer = ref("");

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

function openUserInputRequest(request: RequestUserInputRequest): void {
  pendingUserInput.value = request;
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
  const response = {
    id: request.id,
    answers: { ...userInputAnswers.value },
    cancelled,
  };
  pendingUserInput.value = null;
  userInputAnswers.value = {};
  currentQuestionIndex.value = 0;
  currentAnswer.value = "";
  await rpc.sendCommand({ type: "respond_user_input", response });
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

async function syncWorkspaceState(options: { loadMessagesIfEmpty?: boolean } = {}): Promise<void> {
  await rpc.refreshState();
  await rpc.refreshModels();
  await rpc.refreshSessionStats();
  await projectStore.listSessions();
  projectStore.syncCurrentSession(
    rpc.sessionState.value?.sessionFile,
    rpc.sessionState.value?.sessionId
  );

  if (options.loadMessagesIfEmpty && sessionStore.displayBlocks.length === 0) {
    const messages = await rpc.getMessages();
    if (Array.isArray(messages) && messages.length > 0) {
      sessionStore.loadMessages(messages as AgentMessage[]);
    }
  }
}

onMounted(async () => {
  if (!rpc.isConnected.value) {
    const attached = await rpc.attachToRunningSession();
    if (!attached) {
      router.push("/");
      return;
    }
  }

  // Fetch provider auth status so the model selector shows correct badges.
  try { await authStore.refreshStatus(); } catch { /* non-fatal */ }

  await syncWorkspaceState({ loadMessagesIfEmpty: true });

  unsubscribeEvent = window.pixApi.onPiEvent((event) => {
    sessionStore.addEvent(event);
    const shouldRefreshSessions =
      event.type === "agent_start" ||
      event.type === "agent_end" ||
      event.type === "session_info_changed" ||
      (event.type === "message_end" && event.message.role === "user");
    if (shouldRefreshSessions) {
      void syncWorkspaceState();
    }
  });

  unsubscribeUserInput = window.pixApi.onUserInputRequest((request) => {
    if (pendingUserInput.value) {
      void respondUserInput(true);
    }
    openUserInputRequest(request);
  });
});

onUnmounted(() => {
  if (unsubscribeEvent) {
    unsubscribeEvent();
    unsubscribeEvent = null;
  }
  if (unsubscribeUserInput) {
    unsubscribeUserInput();
    unsubscribeUserInput = null;
  }
  if (pendingUserInput.value) {
    void respondUserInput(true);
  }
});
</script>

<template>
  <AppLayout>
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
