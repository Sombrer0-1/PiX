<script setup lang="ts">
/**
 * AgentTaskInputCard - 任务输入请求卡片（PiX 1.4.1）
 *
 * 渲染在任务面板「需要处理」分组顶部。展示 taskId+requestId+generation 三元
 * 标识与问题列表；回答后经 store.respondInput（三元校验由 main 执行）继续任务，
 * 也可取消本次输入。回答/取消按钮至少展示 300ms 忙碌状态并防重复提交；
 * 全部问题都渲染输入框（canSubmit 要求全部非空，截断渲染会造成死锁）。
 */
import { computed, ref } from "vue";
import { useAgentTaskStore } from "../../stores/agent-task-store";
import type { AgentTaskInputRequest } from "@shared/agent-task-types.js";
import type { RequestUserInputResponse } from "@shared/types.js";

const props = defineProps<{
  request: AgentTaskInputRequest;
}>();

const store = useAgentTaskStore();

const MIN_BUSY_MS = 300;

const answers = ref<Record<string, string>>({});
const busy = ref<"respond" | "cancel" | null>(null);

const questions = computed(() => props.request.request.questions);
const canSubmit = computed(() => {
  if (questions.value.length === 0) return true;
  return questions.value.every((q) => (answers.value[q.id] ?? "").trim().length > 0);
});

function updateAnswer(questionId: string, value: string): void {
  answers.value = { ...answers.value, [questionId]: value };
}

/** 防重复提交 + 至少 300ms 的进度指示。 */
async function runBusy(key: "respond" | "cancel", fn: () => Promise<unknown>): Promise<void> {
  if (busy.value) return;
  busy.value = key;
  const startedAt = Date.now();
  try {
    await fn();
  } finally {
    const elapsed = Date.now() - startedAt;
    const rest = Math.max(0, MIN_BUSY_MS - elapsed);
    if (rest > 0) {
      await new Promise((resolve) => setTimeout(resolve, rest));
    }
    busy.value = null;
  }
}

function submitResponse(): void {
  if (busy.value || !canSubmit.value) return;
  const response: RequestUserInputResponse = {
    id: props.request.requestId,
    answers: { ...answers.value },
  };
  void runBusy("respond", () =>
    store.respondInput(props.request.taskId, props.request.requestId, props.request.generation, response),
  );
}

function cancelRequest(): void {
  if (busy.value) return;
  void runBusy("cancel", () =>
    store.cancelInput(props.request.taskId, props.request.requestId, props.request.generation),
  );
}
</script>

<template>
  <div class="agent-task-input-card" data-test="agent-task-input-card" role="group" aria-label="任务输入请求">
    <div class="agent-task-input-key" data-test="agent-task-input-key" :title="`taskId ${request.taskId} · requestId ${request.requestId} · generation ${request.generation}`">
      任务 {{ request.taskId }} · 请求 {{ request.requestId }} · 代 {{ request.generation }}
    </div>
    <div v-if="questions.length > 0" class="agent-task-input-questions">
      <div v-for="question in questions" :key="question.id" class="agent-task-input-question" :data-test="`agent-task-input-question-${question.id}`">
        <div class="agent-task-input-question-header">
          <span v-if="question.header" class="agent-task-input-question-header-text">{{ question.header }}</span>
        </div>
        <div class="agent-task-input-question-text">{{ question.question }}</div>
        <label class="agent-task-input-answer-label" :for="`agent-task-answer-${question.id}`">
          回答
          <input
            :id="`agent-task-answer-${question.id}`"
            :value="answers[question.id] ?? ''"
            class="agent-task-input-answer"
            data-test="agent-task-input-answer"
            type="text"
            :disabled="busy !== null"
            @input="updateAnswer(question.id, ($event.target as HTMLInputElement).value)"
          />
        </label>
      </div>
    </div>
    <div class="agent-task-input-actions">
      <button
        type="button"
        class="agent-task-action-btn primary"
        data-test="agent-task-input-respond-btn"
        :disabled="busy !== null || !canSubmit"
        :title="!canSubmit ? '请回答全部问题' : '提交回答并继续任务'"
        @click="submitResponse"
      >
        {{ busy === "respond" ? "处理中..." : "提交回答" }}
      </button>
      <button
        type="button"
        class="agent-task-action-btn"
        data-test="agent-task-input-cancel-btn"
        :disabled="busy !== null"
        title="取消本次输入请求"
        @click="cancelRequest"
      >
        {{ busy === "cancel" ? "处理中..." : "取消" }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.agent-task-input-card {
  border: 1px solid var(--pix-warning-light);
  border-radius: var(--pix-radius-md);
  padding: var(--pix-space-sm) var(--pix-space-md);
  background: var(--pix-warning-light);
  min-width: 0;
  margin-bottom: var(--pix-space-xs);
}

.agent-task-input-key {
  font-family: var(--pix-font-mono);
  font-size: 10px;
  color: var(--pix-warning);
  font-weight: var(--pix-weight-semibold);
  margin-bottom: var(--pix-space-xs);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.agent-task-input-question {
  margin-bottom: var(--pix-space-sm);
  min-width: 0;
}

.agent-task-input-question-header-text {
  font-size: var(--pix-text-xs);
  font-weight: var(--pix-weight-semibold);
  color: var(--pix-text-primary);
}

.agent-task-input-question-text {
  font-size: var(--pix-text-xs);
  color: var(--pix-text-secondary);
  margin: 2px 0 var(--pix-space-xs);
  overflow-wrap: anywhere;
}

.agent-task-input-answer-label {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 10px;
  color: var(--pix-text-muted);
}

.agent-task-input-answer {
  font-family: var(--pix-font-ui);
  font-size: var(--pix-text-xs);
  padding: 4px 8px;
  border: 1px solid var(--pix-border-light);
  border-radius: var(--pix-radius-sm);
  background: #ffffff;
  color: var(--pix-text-primary);
  min-width: 0;
}

.agent-task-input-questions {
  max-height: 240px;
  overflow-y: auto;
  padding-right: 2px;
}

.agent-task-input-actions {
  display: flex;
  gap: 6px;
}

.agent-task-action-btn {
  flex-shrink: 0;
  font-size: var(--pix-text-xs);
  font-weight: var(--pix-weight-medium);
  padding: 2px 8px;
  border-radius: var(--pix-radius-sm);
  background: var(--pix-bg-hover);
  color: var(--pix-text-primary);
  border: 1px solid var(--pix-border-light);
  cursor: pointer;
  white-space: nowrap;
}

.agent-task-action-btn:hover {
  background: var(--pix-accent-light);
  color: var(--pix-accent);
}

.agent-task-action-btn.primary {
  color: var(--pix-accent);
  background: var(--pix-accent-light);
}

.agent-task-action-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
