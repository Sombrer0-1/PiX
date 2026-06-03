<script setup lang="ts">
/**
 * RightPanel - Session inspector
 */
import { computed, ref, onMounted, watch } from "vue";
import { useRouter } from "vue-router";
import { useRpc } from "../../composables/useRpc";
import { useProjectStore } from "../../stores/project-store";
import TokenStats from "../status/TokenStats.vue";
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
const sessionName = computed(() => rpc.sessionState.value?.sessionName);
const isStreaming = computed(() => rpc.isStreaming.value);
const isError = computed(() => rpc.lastError.value !== null);
const messageCount = computed(() => rpc.sessionState.value?.messageCount || 0);
const projectPath = computed(() => projectStore.currentProject?.path || "-");

const statusLabel = computed(() => {
  if (isStreaming.value) return "运行中";
  if (isError.value) return "错误";
  return "空闲";
});

const statusColor = computed(() => {
  if (isStreaming.value) return "primary";
  if (isError.value) return "error";
  return undefined;
});

const statusVariant = computed(() => {
  if (isStreaming.value) return "tonal";
  if (isError.value) return "tonal";
  return "text";
});

// ---- MCP status ----
const router = useRouter();
const mcpServers = ref<McpServerInfo[]>([]);
const mcpConnected = computed(() => mcpServers.value.filter((s) => s.status === "connected").length);
const mcpFailed = computed(() => mcpServers.value.filter((s) => s.status === "failed").length);
const mcpTotal = computed(() => mcpServers.value.length);

async function refreshMcp(): Promise<void> {
  try {
    mcpServers.value = await window.pixApi.mcpGetServers();
  } catch {
    mcpServers.value = [];
  }
}

function goToMcpSettings(): void {
  router.push("/settings");
  // settings page defaults to "general", we trigger via store or just navigate
}

onMounted(refreshMcp);
watch(() => rpc.isConnected.value, (connected) => {
  if (connected) refreshMcp();
});
</script>

<template>
  <div class="right-panel">
    <!-- Status -->
    <div class="inspector-section">
      <v-chip
        size="small"
        :color="statusColor"
        :variant="statusVariant"
        class="status-chip"
      >
        {{ statusLabel }}
      </v-chip>
    </div>

    <v-divider class="my-2" />

    <!-- Session info -->
    <div class="inspector-section">
      <v-list density="default" bg-color="transparent" class="info-list">
        <v-list-item density="default">
          <template #title>
            <span class="info-key">模型</span>
          </template>
          <template #append>
            <span class="info-mono">{{ modelDisplay }}</span>
          </template>
        </v-list-item>
        <v-list-item density="default">
          <template #title>
            <span class="info-key">思考级别</span>
          </template>
          <template #append>
            <span class="info-val">{{ thinkingLevel }}</span>
          </template>
        </v-list-item>
        <v-list-item density="default">
          <template #title>
            <span class="info-key">会话</span>
          </template>
          <template #append>
            <span class="info-mono" :title="sessionId">{{ sessionName || sessionId.slice(0, 12) }}</span>
          </template>
        </v-list-item>
        <v-list-item density="default">
          <template #title>
            <span class="info-key">消息数</span>
          </template>
          <template #append>
            <span class="info-val">{{ messageCount }}</span>
          </template>
        </v-list-item>
        <v-list-item density="default">
          <template #title>
            <span class="info-key">项目</span>
          </template>
          <template #append>
            <span class="info-mono">{{ projectPath.split(/[/\\]/).pop() }}</span>
          </template>
        </v-list-item>
      </v-list>
    </div>

    <v-divider class="my-2" />

    <!-- Token stats -->
    <div class="inspector-section">
      <div class="section-label">Token 用量</div>
      <TokenStats />
    </div>

    <!-- MCP servers -->
    <template v-if="mcpTotal > 0">
      <v-divider class="my-2" />
      <div class="inspector-section">
        <div class="d-flex align-center justify-space-between mb-1">
          <span class="section-label">MCP 服务器</span>
          <v-btn
            variant="text"
            size="x-small"
            icon="mdi-open-in-new"
            @click="goToMcpSettings"
          />
        </div>
        <v-chip
          size="x-small"
          :color="mcpFailed > 0 ? 'warning' : 'success'"
          variant="tonal"
          class="mb-1"
        >
          {{ mcpConnected }}/{{ mcpTotal }} 已连接
        </v-chip>
        <v-chip
          v-if="mcpFailed > 0"
          size="x-small"
          color="error"
          variant="tonal"
        >
          {{ mcpFailed }} 失败
        </v-chip>
      </div>
    </template>

    <!-- Error -->
    <template v-if="rpc.lastError.value">
      <v-divider class="my-2" />
      <div class="inspector-section">
        <div class="section-label error-label">最近错误</div>
        <div class="error-text">{{ rpc.lastError.value }}</div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.right-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: var(--pix-space-md);
  gap: 0;
}

.inspector-section {
  padding: var(--pix-space-sm) 0;
}

.section-label {
  font-size: var(--pix-text-xs);
  font-weight: 600;
  color: var(--pix-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.3px;
  margin-bottom: var(--pix-space-sm);
}

.status-chip {
  width: 100%;
}

.info-list :deep(.v-list-item) {
  padding-left: 0;
  padding-right: 0;
  min-height: 30px;
}

.info-key {
  font-size: var(--pix-text-sm);
  color: var(--pix-text-muted);
}

.info-val {
  font-size: var(--pix-text-sm);
  color: var(--pix-text-primary);
  font-weight: 500;
}

.info-mono {
  font-family: var(--pix-font-mono);
  font-size: var(--pix-text-xs);
  color: var(--pix-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 140px;
}

.error-label {
  color: var(--pix-error) !important;
}

.error-text {
  font-size: var(--pix-text-sm);
  color: var(--pix-error);
  line-height: var(--pix-leading-base);
  max-height: 120px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
