<script setup lang="ts">
/**
 * RightPanel - Session inspector
 */
import { computed, ref, onMounted, watch } from "vue";
import { useRouter } from "vue-router";
import { useRpc } from "../../composables/useRpc";
import { useProjectStore } from "../../stores/project-store";
import TokenStats from "../status/TokenStats.vue";
import { deriveSessionTitle } from "@/utils/session-title";
import type { McpServerInfo } from "../../../shared/types";

const rpc = useRpc();
const projectStore = useProjectStore();

const modelDisplay = computed(() => {
  const model = rpc.sessionState.value?.model;
  if (!model) return "未设置";
  return `${model.provider}/${model.id}`;
});

const thinkingLevel = computed(() => rpc.sessionState.value?.thinkingLevel || "medium");
const sessionId = computed(() => rpc.sessionState.value?.sessionId || "-");
const sessionName = computed(() => {
  const explicitName = rpc.sessionState.value?.sessionName?.trim();
  if (explicitName) return explicitName;
  return deriveSessionTitle(projectStore.currentSession);
});
const messageCount = computed(() => rpc.sessionState.value?.messageCount || 0);
const projectPath = computed(() => projectStore.currentProject?.path || "-");
const goal = computed(() => {
  const currentGoal = rpc.sessionState.value?.goal;
  if (!currentGoal) return undefined;
  return currentGoal.status === "active" || currentGoal.status === "paused" ? currentGoal : undefined;
});
const goalStatusText = computed(() => {
  switch (goal.value?.status) {
    case "active": return "进行中";
    case "paused": return "已暂停";
    case "blocked": return "已阻塞";
    case "usage_limited": return "用量受限";
    case "budget_limited": return "预算耗尽";
    case "complete": return "已完成";
    default: return "-";
  }
});
const goalBudgetText = computed(() => {
  const currentGoal = goal.value;
  if (!currentGoal) return "-";
  const budget = currentGoal.tokenBudget == null ? "不限" : currentGoal.tokenBudget.toLocaleString();
  return `${currentGoal.tokensUsed.toLocaleString()} / ${budget}`;
});
const goalTimeText = computed(() => {
  const ms = goal.value?.timeUsedMs ?? 0;
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "< 1 分钟";
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest > 0 ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`;
});

// ---- MCP status ----
const router = useRouter();
const mcpServers = ref<McpServerInfo[]>([]);
const mcpConnected = computed(() => mcpServers.value.filter((s) => s.status === "connected").length);
const mcpFailed = computed(() => mcpServers.value.filter((s) => s.status === "failed").length);
const mcpTotal = computed(() => mcpServers.value.length);
const connectedMcpServers = computed(() => mcpServers.value.filter((s) => s.status === "connected"));
const failedMcpServers = computed(() => mcpServers.value.filter((s) => s.status === "failed"));
const pendingMcpServers = computed(() =>
  mcpServers.value.filter((s) => s.status !== "connected" && s.status !== "failed")
);

async function refreshMcp(): Promise<void> {
  try {
    mcpServers.value = await window.pixApi.mcpGetServers();
  } catch {
    mcpServers.value = [];
  }
}

function goToMcpSettings(): void {
  router.push({ path: "/settings", query: { section: "mcp" } });
}

function mcpStatusText(status: McpServerInfo["status"]): string {
  if (status === "connecting") return "连接中";
  if (status === "disconnected") return "未连接";
  return status;
}

onMounted(refreshMcp);
watch(() => rpc.isConnected.value, (connected) => {
  if (connected) refreshMcp();
});
</script>

<template>
  <div class="right-panel">
    <!-- Session info card -->
    <div class="info-card">
      <div class="card-title">会话信息</div>
      <div class="info-rows">
        <div class="info-row">
          <span class="info-label">模型</span>
          <span class="info-value" :title="modelDisplay">{{ modelDisplay }}</span>
        </div>
        <div class="info-row">
          <span class="info-label">思考级别</span>
          <span class="info-value">{{ thinkingLevel }}</span>
        </div>
        <div class="info-row">
          <span class="info-label">会话</span>
          <span class="info-value" :title="sessionId">{{ sessionName }}</span>
        </div>
        <div class="info-row">
          <span class="info-label">消息数</span>
          <span class="info-value">{{ messageCount }}</span>
        </div>
        <div class="info-row">
          <span class="info-label">项目</span>
          <span class="info-value">{{ projectPath.split(/[/\\]/).pop() }}</span>
        </div>
      </div>
    </div>

    <!-- Goal card -->
    <div v-if="goal" class="info-card">
      <div class="card-title">目标</div>
      <div class="goal-objective" :title="goal.objective">{{ goal.objective }}</div>
      <div class="info-rows compact">
        <div class="info-row">
          <span class="info-label">状态</span>
          <span class="info-value" :class="`goal-status ${goal.status}`">{{ goalStatusText }}</span>
        </div>
        <div class="info-row">
          <span class="info-label">Token</span>
          <span class="info-value">{{ goalBudgetText }}</span>
        </div>
        <div class="info-row">
          <span class="info-label">用时</span>
          <span class="info-value">{{ goalTimeText }}</span>
        </div>
      </div>
    </div>

    <!-- Token stats card -->
    <div class="info-card">
      <div class="card-title">Token 用量</div>
      <TokenStats />
    </div>

    <!-- MCP card -->
    <div v-if="mcpTotal > 0" class="info-card">
      <div class="card-title-row">
        <span class="card-title">MCP 服务器</span>
        <button
          class="card-action-btn"
          @click="goToMcpSettings"
          title="MCP 设置"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
        </button>
      </div>
      <div class="mcp-overview" :class="mcpFailed > 0 ? 'warning' : 'ok'">
        <span class="mcp-count">{{ mcpConnected }}/{{ mcpTotal }}</span>
        <span class="mcp-count-label">已连接</span>
        <span v-if="mcpFailed > 0" class="mcp-failed-count">{{ mcpFailed }} 失败</span>
      </div>
      <div class="mcp-server-list">
        <div
          v-for="server in connectedMcpServers"
          :key="server.name"
          class="mcp-server-row connected"
          :title="`${server.name} · ${server.transport} · ${server.toolCount} 个工具`"
        >
          <span class="mcp-server-dot"></span>
          <span class="mcp-server-name">{{ server.name }}</span>
          <span class="mcp-server-meta">{{ server.toolCount }} 工具</span>
        </div>
        <div
          v-for="server in failedMcpServers"
          :key="server.name"
          class="mcp-server-row failed"
          :title="server.error || server.name"
        >
          <span class="mcp-server-dot"></span>
          <span class="mcp-server-name">{{ server.name }}</span>
          <span class="mcp-server-meta">失败</span>
        </div>
        <div
          v-for="server in pendingMcpServers"
          :key="server.name"
          class="mcp-server-row pending"
          :title="server.name"
        >
          <span class="mcp-server-dot"></span>
          <span class="mcp-server-name">{{ server.name }}</span>
          <span class="mcp-server-meta">{{ mcpStatusText(server.status) }}</span>
        </div>
      </div>
    </div>

    <!-- Error card -->
    <div v-if="rpc.lastError.value" class="info-card error-card">
      <div class="card-title error-title">最近错误</div>
      <div class="error-text">{{ rpc.lastError.value }}</div>
    </div>
  </div>
</template>

<style scoped>
.right-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 46px var(--pix-space-md) var(--pix-space-md);
  gap: var(--pix-space-md);
  user-select: none;
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.94), rgba(251, 252, 255, 0.82));
}

/* ── Status indicator ── */
.panel-status {
  padding-bottom: var(--pix-space-sm);
}

.status-indicator {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px;
  border-radius: 12px;
  font-size: var(--pix-text-xs);
  font-weight: var(--pix-weight-medium);
  width: 100%;
}

.status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}

.status-indicator.idle {
  background: var(--pix-bg-hover);
  color: var(--pix-text-secondary);
}
.status-indicator.idle .status-dot { background: var(--pix-text-secondary); }

.status-indicator.running {
  background: var(--pix-accent-light);
  color: var(--pix-accent);
}
.status-indicator.running .status-dot {
  background: var(--pix-accent);
  animation: status-pulse 1.5s ease-in-out infinite;
}

.status-indicator.error {
  background: var(--pix-error-bg);
  color: var(--pix-error);
}
.status-indicator.error .status-dot { background: var(--pix-error); }

@keyframes status-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}

/* ── Info cards ── */
.info-card {
  background: rgba(255, 255, 255, 0.92);
  border: 1px solid var(--pix-border-light);
  border-radius: var(--pix-radius-xl);
  padding: var(--pix-space-lg);
  box-shadow: var(--pix-shadow-xs);
  transition:
    border-color var(--pix-transition-fast),
    box-shadow var(--pix-transition-fast);
}

.info-card:hover {
  border-color: #dfe2f0;
  box-shadow: var(--pix-shadow-sm);
}

.card-title {
  font-size: var(--pix-text-sm);
  font-weight: var(--pix-weight-semibold);
  color: var(--pix-text-primary);
  text-transform: none;
  letter-spacing: 0;
  margin-bottom: var(--pix-space-md);
}

.card-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--pix-space-md);
}

.card-action-btn {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--pix-radius-md);
  color: var(--pix-text-secondary);
  cursor: pointer;
  transition: color var(--pix-transition-fast), background var(--pix-transition-fast);
}

.card-action-btn:hover {
  color: var(--pix-text-primary);
  background: var(--pix-accent-light);
}

/* ── Info rows ── */
.info-rows {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.info-rows.compact {
  margin-top: var(--pix-space-sm);
}

.info-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 3px 0;
  min-height: 28px;
}

.info-label {
  font-size: var(--pix-text-sm);
  color: var(--pix-text-muted);
  flex-shrink: 0;
}

.info-value {
  font-size: var(--pix-text-sm);
  color: var(--pix-text-primary);
  font-weight: var(--pix-weight-medium);
  text-align: right;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 55%;
}

.info-value.mono {
  font-family: var(--pix-font-mono);
  font-size: var(--pix-text-xs);
}

.goal-objective {
  color: var(--pix-text-primary);
  font-size: var(--pix-text-sm);
  font-weight: var(--pix-weight-medium);
  background: var(--pix-bg-code);
  border: 1px solid var(--pix-border-subtle);
  border-radius: var(--pix-radius-md);
  padding: var(--pix-space-sm);
  line-height: var(--pix-leading-base);
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.goal-status {
  max-width: none;
}

.goal-status.active {
  color: var(--pix-accent);
}

.goal-status.complete {
  color: var(--pix-success);
}

.goal-status.blocked,
.goal-status.usage_limited,
.goal-status.budget_limited {
  color: var(--pix-error);
}

.goal-status.paused {
  color: var(--pix-warning);
}

/* ── MCP status ── */
.mcp-overview {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin-bottom: var(--pix-space-sm);
}

.mcp-count {
  font-family: var(--pix-font-mono);
  font-size: var(--pix-text-xl);
  font-weight: var(--pix-weight-semibold);
  color: var(--pix-success);
}

.mcp-overview.warning .mcp-count {
  color: var(--pix-warning);
}

.mcp-count-label,
.mcp-failed-count {
  font-size: var(--pix-text-xs);
  font-weight: var(--pix-weight-medium);
  color: var(--pix-text-secondary);
}

.mcp-failed-count {
  color: var(--pix-error);
}

.mcp-server-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.mcp-server-row {
  display: flex;
  align-items: center;
  gap: 7px;
  min-height: 24px;
  font-size: var(--pix-text-xs);
  padding: 2px 0;
}

.mcp-server-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}

.mcp-server-row.connected .mcp-server-dot {
  background: var(--pix-success);
}

.mcp-server-row.failed .mcp-server-dot {
  background: var(--pix-error);
}

.mcp-server-row.pending .mcp-server-dot {
  background: var(--pix-warning);
}

.mcp-server-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--pix-text-primary);
  font-weight: var(--pix-weight-medium);
}

.mcp-server-meta {
  flex-shrink: 0;
  color: var(--pix-text-secondary);
}

.mcp-server-row.failed .mcp-server-meta {
  color: var(--pix-error);
}

/* ── Error card ── */
.error-card {
  border-color: var(--pix-error-light);
  background: var(--pix-error-bg);
}

.error-title {
  color: var(--pix-error) !important;
}

.error-text {
  font-size: var(--pix-text-sm);
  color: var(--pix-error);
  line-height: var(--pix-leading-base);
  max-height: 100px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
