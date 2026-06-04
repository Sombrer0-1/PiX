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

const hasMissingUserInputAnswer = computed(() => {
  const request = pendingUserInput.value;
  if (!request) return true;
  return request.questions.some((question) => !userInputAnswers.value[question.id]?.trim());
});

function openUserInputRequest(request: RequestUserInputRequest): void {
  pendingUserInput.value = request;
  const next: Record<string, string> = {};
  for (const question of request.questions) {
    next[question.id] = question.options?.[0]?.label ?? "";
  }
  userInputAnswers.value = next;
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
  await rpc.sendCommand({ type: "respond_user_input", response });
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
      <CenterPanel />
    </template>
    <template #right>
      <RightPanel />
    </template>
  </AppLayout>

  <v-dialog :model-value="!!pendingUserInput" persistent max-width="640">
    <v-card v-if="pendingUserInput" class="user-input-dialog">
      <div class="user-input-title">需要你的输入</div>
      <div class="user-input-questions">
        <div
          v-for="question in pendingUserInput.questions"
          :key="question.id"
          class="user-input-question"
        >
          <div class="question-header">{{ question.header }}</div>
          <div class="question-text">{{ question.question }}</div>
          <div v-if="question.options?.length" class="question-options">
            <button
              v-for="option in question.options"
              :key="option.label"
              class="question-option"
              :class="{ active: userInputAnswers[question.id] === option.label }"
              @click="userInputAnswers[question.id] = option.label"
            >
              <span class="option-label">{{ option.label }}</span>
              <span v-if="option.description" class="option-description">{{ option.description }}</span>
            </button>
          </div>
          <textarea
            v-model="userInputAnswers[question.id]"
            class="question-textarea"
            rows="2"
            :placeholder="question.options?.length ? '其他回答...' : '输入回答...'"
          ></textarea>
        </div>
      </div>
      <v-card-actions class="user-input-actions">
        <v-spacer />
        <v-btn variant="text" @click="respondUserInput(true)">取消</v-btn>
        <v-btn color="primary" variant="flat" :disabled="hasMissingUserInputAnswer" @click="respondUserInput(false)">
          发送
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.user-input-dialog {
  padding: var(--pix-space-lg);
}

.user-input-title {
  font-size: var(--pix-text-lg);
  font-weight: var(--pix-weight-semibold);
  color: var(--pix-text-primary);
  margin-bottom: var(--pix-space-md);
}

.user-input-questions {
  display: flex;
  flex-direction: column;
  gap: var(--pix-space-lg);
}

.question-header {
  color: var(--pix-accent);
  font-size: var(--pix-text-xs);
  font-weight: var(--pix-weight-semibold);
  text-transform: uppercase;
  letter-spacing: 0;
  margin-bottom: var(--pix-space-xs);
}

.question-text {
  color: var(--pix-text-primary);
  font-size: var(--pix-text-sm);
  line-height: var(--pix-leading-base);
  margin-bottom: var(--pix-space-sm);
}

.question-options {
  display: grid;
  gap: var(--pix-space-xs);
  margin-bottom: var(--pix-space-sm);
}

.question-option {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  width: 100%;
  padding: var(--pix-space-sm) var(--pix-space-md);
  border: 1px solid var(--pix-border-light);
  border-radius: var(--pix-radius-sm);
  color: var(--pix-text-primary);
  background: var(--pix-bg-content);
  text-align: left;
}

.question-option:hover {
  background: var(--pix-bg-hover);
}

.question-option.active {
  border-color: var(--pix-accent);
  background: var(--pix-accent-light);
}

.option-label {
  font-size: var(--pix-text-sm);
  font-weight: var(--pix-weight-medium);
}

.option-description {
  color: var(--pix-text-secondary);
  font-size: var(--pix-text-xs);
  line-height: var(--pix-leading-base);
}

.question-textarea {
  width: 100%;
  resize: vertical;
  min-height: 58px;
  padding: var(--pix-space-sm) var(--pix-space-md);
  border: 1px solid var(--pix-border-light);
  border-radius: var(--pix-radius-sm);
  background: var(--pix-bg-input);
  color: var(--pix-text-primary);
  font-family: var(--pix-font-ui);
  font-size: var(--pix-text-sm);
  line-height: var(--pix-leading-base);
}

.question-textarea:focus {
  outline: none;
  border-color: var(--pix-accent);
  box-shadow: 0 0 0 2px var(--pix-accent-light);
}

.user-input-actions {
  padding: var(--pix-space-lg) 0 0;
}
</style>
