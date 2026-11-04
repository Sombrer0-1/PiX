<script setup lang="ts">
/**
 * ComputerUseActivityBar - composer 上方的电脑操控活动条
 *
 * 会话开启且（持有桌面租约/有活动）时显示：当前动作摘要、授权级别、
 * “停止”（emergency_stop）与“撤销授权”。数据全部来自 computer-use store
 * （快照 + activity 事件合并），纯展示 + 两个 store 动作。
 */

import { computed, onMounted } from "vue";
import { computerUseGrantLabel } from "@shared/computer-use-types.js";
import { useComputerUseStore } from "../../stores/computer-use-store";

const store = useComputerUseStore();

onMounted(() => store.start());

const session = computed(() => store.snapshot?.session ?? null);

/** 当前活动：快照优先，事件合并兜底（会话切换时 store 会清除 lastActivity）。 */
const activity = computed(() => session.value?.activity ?? store.lastActivity);

/**
 * 全局关闭（availability "disabled" / inactiveReason "global_disabled"）后，
 * 主进程可能仍保留 controller 的 _sessionEnabled/_activity 残留快照；活动条
 * 必须立即隐藏，不能等主进程清理。
 */
const visible = computed(() => {
  if (store.snapshot?.availability === "disabled") return false;
  const s = session.value;
  if (s === null) return false;
  if (s.inactiveReason === "global_disabled") return false;
  return s.sessionEnabled && (s.holdsLease || activity.value !== null);
});

const grantLabel = computed(() => computerUseGrantLabel(store.grant));

const stateLabel = computed(() => {
  const a = activity.value;
  if (!a) return null;
  switch (a.state) {
    case "running":
      return "执行中";
    case "succeeded":
      return "已完成";
    case "failed":
      return a.errorCode ? `失败 · ${a.errorCode}` : "失败";
    case "cancelled":
      return "已取消";
  }
});

const summary = computed(() => activity.value?.summary ?? "占用桌面控制权，等待下一步操作");

function stop(): void {
  void store.emergencyStop();
}

function revoke(): void {
  void store.revokeGrants();
}
</script>

<template>
  <div
    v-if="visible"
    class="cu-activity-bar"
    :class="{ 'cu-activity-halted': session?.halted, 'cu-activity-busy': store.isActing }"
    role="status"
  >
    <span class="cu-activity-dot" aria-hidden="true"></span>
    <div class="cu-activity-main">
      <span class="cu-activity-summary" :title="summary">{{ summary }}</span>
      <span class="cu-activity-meta">
        <span class="cu-activity-grant">{{ grantLabel }}</span>
        <span v-if="stateLabel" class="cu-activity-state">{{ stateLabel }}</span>
        <span v-if="session?.halted" class="cu-activity-halt-note">已紧急停止，发送下一条消息后恢复</span>
      </span>
    </div>
    <div class="cu-activity-actions">
      <button
        type="button"
        class="cu-activity-btn cu-activity-revoke"
        :disabled="store.grant === 'none'"
        @click="revoke"
      >
        撤销授权
      </button>
      <button type="button" class="cu-activity-btn cu-activity-stop" @click="stop">停止</button>
    </div>
  </div>
</template>

<style scoped>
.cu-activity-bar {
  display: flex;
  align-items: center;
  gap: var(--pix-space-sm);
  margin-bottom: var(--pix-space-xs);
  padding: 6px 10px;
  border: 1px solid var(--pix-accent-soft);
  border-radius: var(--pix-radius-lg);
  background: var(--pix-accent-light);
  font-size: var(--pix-text-xs);
  color: var(--pix-text-primary);
}

.cu-activity-bar.cu-activity-halted {
  border-color: var(--pix-warning);
  background: var(--pix-warning-bg);
}

.cu-activity-dot {
  flex-shrink: 0;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--pix-accent);
}

.cu-activity-busy .cu-activity-dot {
  animation: cu-activity-pulse 1.1s ease-in-out infinite;
}

@keyframes cu-activity-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.35;
  }
}

@media (prefers-reduced-motion: reduce) {
  .cu-activity-busy .cu-activity-dot {
    animation: none;
  }
}

.cu-activity-main {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: var(--pix-space-sm);
}

.cu-activity-summary {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--pix-text-primary);
  font-weight: var(--pix-weight-medium);
}

.cu-activity-meta {
  flex-shrink: 0;
  display: inline-flex;
  align-items: baseline;
  gap: var(--pix-space-xs);
  color: var(--pix-text-muted);
}

.cu-activity-state {
  color: var(--pix-text-secondary);
}

.cu-activity-halt-note {
  color: var(--pix-warning);
}

.cu-activity-actions {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: var(--pix-space-xs);
}

.cu-activity-btn {
  padding: 3px 9px;
  border: 1px solid var(--pix-border-light);
  border-radius: var(--pix-radius-md);
  background: var(--pix-bg-content);
  color: var(--pix-text-secondary);
  font-size: var(--pix-text-xs);
  font-family: var(--pix-font-ui);
  cursor: pointer;
  transition:
    background var(--pix-transition-fast),
    color var(--pix-transition-fast),
    border-color var(--pix-transition-fast);
}

.cu-activity-btn:hover:not(:disabled) {
  background: var(--pix-bg-hover);
  color: var(--pix-text-primary);
}

.cu-activity-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.cu-activity-stop {
  border-color: var(--pix-error-light);
  color: var(--pix-error);
}

.cu-activity-stop:hover:not(:disabled) {
  background: var(--pix-error-bg);
  color: var(--pix-error);
}
</style>
