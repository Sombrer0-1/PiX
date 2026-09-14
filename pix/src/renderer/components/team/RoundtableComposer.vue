<script setup lang="ts">
/**
 * RoundtableComposer - the user's seat at the table.
 *
 * The user is not an LLM seat: they broadcast, @ one seat, send a private
 * message to one seat, throw material in, steer the schedule (ordered mode /
 * wrap-up / pause-resume) and pick how strongly a message cuts in (L1 插话 /
 * L2 打断 / L3 中止). Material goes through the existing `select-chat-files`
 * channel and travels as `ChatMessageAttachment[]`.
 */
import { computed, ref, watch } from "vue";
import { useTeamStore } from "../../stores/team-store";
import type { ChatMessageAttachment } from "@shared/types.js";
import type { InterruptLevel } from "@shared/team-types.js";

const teamStore = useTeamStore();

const target = ref<string>("*");
const privateMessage = ref(false);
const interrupt = ref<InterruptLevel>("L1");
const text = ref("");
const attachments = ref<ChatMessageAttachment[]>([]);
const isSending = ref(false);
const isWrapUpBusy = ref(false);

// 切回「全员」必须复位私密开关：开关只被 disabled 时仍保留 ON，之后再选席位就会
// 静默恢复私密——用户以为自己在广播。
watch(target, (next) => {
  if (next === "*") privateMessage.value = false;
});

const targetItems = computed(() => [
  { title: "全员", value: "*" },
  ...teamStore.seatList
    .filter((seat) => seat.status !== "exited")
    .map((seat) => ({ title: seat.name, value: seat.seatId })),
]);

const interruptItems: Array<{ title: string; value: InterruptLevel }> = [
  { title: "插话（不打断当前生成）", value: "L1" },
  { title: "打断（工具批次安全点）", value: "L2" },
  { title: "中止（请求取消当前回合）", value: "L3" },
];

const canSend = computed(() =>
  !isSending.value && (text.value.trim().length > 0 || attachments.value.length > 0),
);

const isPaused = computed(() => teamStore.lifecycle === "paused");
const isStopped = computed(() => teamStore.lifecycle === "stopped");

async function send(): Promise<void> {
  if (!canSend.value) return;
  const body = text.value.trim();
  const to = target.value;
  const usePrivate = privateMessage.value && to !== "*";
  isSending.value = true;
  try {
    const result = await teamStore.postUserMessage({
      to,
      // Empty body is legal: an attachment-only message throws material in.
      text: body,
      private: usePrivate || undefined,
      interrupt: interrupt.value,
      attachments: attachments.value.length > 0 ? attachments.value : undefined,
    });
    if (result !== null) {
      text.value = "";
      attachments.value = [];
    }
  } finally {
    isSending.value = false;
  }
}

function imageKind(path: string): "image" | "text" {
  return /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(path) ? "image" : "text";
}

function fileName(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] || path;
}

async function pickFiles(): Promise<void> {
  try {
    const paths = await window.pixApi.selectChatFiles();
    const existing = new Set(attachments.value.map((attachment) => attachment.path));
    const next = [...attachments.value];
    for (const path of paths) {
      const trimmed = path.trim();
      if (trimmed.length === 0 || existing.has(trimmed)) continue;
      next.push({ path: trimmed, name: fileName(trimmed), kind: imageKind(trimmed) });
      existing.add(trimmed);
    }
    attachments.value = next;
  } catch (err) {
    console.error("[RoundtableComposer] Select files failed:", err);
  }
}

function removeAttachment(path: string): void {
  attachments.value = attachments.value.filter((attachment) => attachment.path !== path);
}

async function toggleOrdered(on: boolean): Promise<void> {
  await teamStore.setOrderedMode(on);
}

async function requestWrapUp(): Promise<void> {
  if (isWrapUpBusy.value) return;
  isWrapUpBusy.value = true;
  try {
    await teamStore.requestWrapUp();
  } finally {
    isWrapUpBusy.value = false;
  }
}

async function togglePause(): Promise<void> {
  if (isPaused.value) {
    await teamStore.resume();
  } else {
    await teamStore.pause();
  }
}
</script>

<template>
  <div class="roundtable-composer" data-test="roundtable-composer">
    <div class="rc-controls">
      <v-select
        v-model="target"
        :items="targetItems"
        item-title="title"
        item-value="value"
        density="compact"
        variant="outlined"
        hide-details
        class="rc-target"
        data-test="composer-target"
      />
      <v-switch
        v-model="privateMessage"
        :disabled="target === '*'"
        hide-details
        density="compact"
        color="primary"
        label="私密"
        class="rc-switch"
      />
      <v-select
        v-model="interrupt"
        :items="interruptItems"
        item-title="title"
        item-value="value"
        density="compact"
        variant="outlined"
        hide-details
        class="rc-interrupt"
      />
      <v-switch
        :model-value="teamStore.orderedMode"
        hide-details
        density="compact"
        color="primary"
        label="有序模式"
        class="rc-switch"
        @update:model-value="toggleOrdered"
      />
      <v-btn
        size="small"
        variant="tonal"
        color="primary"
        prepend-icon="mdi-clipboard-text-outline"
        :loading="isWrapUpBusy"
        :disabled="isStopped"
        @click="requestWrapUp"
      >
        整理当前方案
      </v-btn>
      <v-btn
        size="small"
        variant="text"
        :color="isPaused ? 'primary' : 'warning'"
        :prepend-icon="isPaused ? 'mdi-play' : 'mdi-pause'"
        :disabled="isStopped"
        @click="togglePause"
      >
        {{ isPaused ? "恢复" : "暂停" }}
      </v-btn>
    </div>

    <div class="rc-body">
      <div v-if="attachments.length > 0" class="rc-attachments">
        <span
          v-for="attachment in attachments"
          :key="attachment.path"
          class="rc-attachment"
          :title="attachment.path"
        >
          <v-icon :icon="attachment.kind === 'image' ? 'mdi-image-outline' : 'mdi-file-outline'" size="12" />
          {{ attachment.name }}
          <button type="button" class="rc-attachment-remove" aria-label="移除材料" @click="removeAttachment(attachment.path)">
            ×
          </button>
        </span>
      </div>

      <div class="rc-input-row">
        <v-textarea
          v-model="text"
          rows="1"
          auto-grow
          density="compact"
          variant="outlined"
          hide-details
          :disabled="isStopped"
          :placeholder="target === '*' ? '向全员说一句…' : `单独与所选席位说话…`"
          class="rc-input"
          data-test="composer-input"
          @keydown.enter.exact.prevent="send"
        />
        <v-btn
          icon="mdi-paperclip"
          size="small"
          variant="text"
          title="抛出材料（文件）"
          aria-label="抛出材料"
          data-test="composer-attach"
          @click="pickFiles"
        />
        <v-btn
          icon="mdi-send"
          size="small"
          color="primary"
          variant="flat"
          :loading="isSending"
          :disabled="!canSend"
          title="发送"
          aria-label="发送"
          data-test="composer-send"
          @click="send"
        />
      </div>

      <p class="rc-hint">
        {{ privateMessage && target !== "*" ? "私密（仅该席位可见，时间线仅留痕迹）" : target === "*" ? "广播（全员可见）" : "@点名（全员可见，优先进入该席位收件箱）" }}
      </p>
    </div>
  </div>
</template>

<style scoped>
.roundtable-composer {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: var(--pix-space-sm);
  border-top: 1px solid var(--pix-border-subtle);
  background: rgba(255, 255, 255, 0.9);
  flex-shrink: 0;
}

.rc-controls {
  display: flex;
  align-items: center;
  gap: var(--pix-space-xs);
  flex-wrap: wrap;
}

.rc-target {
  max-width: 150px;
}

.rc-interrupt {
  max-width: 210px;
}

.rc-switch {
  flex: 0 0 auto;
}

.rc-controls :deep(.v-field) {
  font-size: var(--pix-text-xs);
}

.rc-controls :deep(.v-label) {
  font-size: 10px;
}

.rc-body {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.rc-attachments {
  display: flex;
  gap: 5px;
  flex-wrap: wrap;
}

.rc-attachment {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 1px 6px;
  border: 1px solid var(--pix-border-subtle);
  border-radius: 9px;
  background: #ffffff;
  color: var(--pix-text-secondary);
  font-size: 9px;
}

.rc-attachment-remove {
  border: none;
  background: transparent;
  color: var(--pix-text-muted);
  cursor: pointer;
  font-size: 12px;
  line-height: 1;
  padding: 0 2px;
}

.rc-attachment-remove:hover {
  color: var(--pix-error);
}

.rc-input-row {
  display: flex;
  align-items: flex-end;
  gap: var(--pix-space-xs);
}

.rc-input {
  flex: 1;
  min-width: 0;
}

.rc-input :deep(textarea) {
  font-size: var(--pix-text-xs);
}

.rc-hint {
  margin: 0;
  color: var(--pix-text-muted);
  font-size: 9px;
}
</style>
