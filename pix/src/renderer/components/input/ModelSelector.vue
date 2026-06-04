<script setup lang="ts">
/**
 * ModelSelector - 模型选择下拉框
 *
 * 显示可用模型列表，支持搜索、提供商筛选、
 * 以及为支持推理的模型切换思考深度。
 */
import { computed, ref, watch } from "vue";
import { useRpc } from "../../composables/useRpc";
import { useAuthStore } from "../../stores/auth-store";

// Thinking levels — kept inline to avoid cross-package type dependencies in SFC
const ALL_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
type ThinkingLevel = (typeof ALL_THINKING_LEVELS)[number];

const THINKING_LEVEL_LABELS: Record<string, string> = {
  off: "关闭",
  minimal: "极简",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
};

const emit = defineEmits<{
  close: [];
}>();

const rpc = useRpc();
const authStore = useAuthStore();

const searchQuery = ref("");
const showOnlyConfigured = ref(false);
const availableThinkingLevels = ref<string[]>([]);

const allModels = computed(() => rpc.availableModels.value);
const currentModel = computed(() => rpc.sessionState.value?.model);
const currentThinkingLevel = computed(() => rpc.sessionState.value?.thinkingLevel ?? "medium");
const isConnected = computed(() => rpc.isConnected.value);

const modelSupportsThinking = computed(() => {
  if (!currentModel.value) return false;
  const found = allModels.value.find(
    m => m.provider === currentModel.value!.provider && m.id === currentModel.value!.id,
  );
  return !!found?.reasoning;
});

const filteredModels = computed(() => {
  let models = allModels.value;
  if (showOnlyConfigured.value) {
    models = models.filter((m) => authStore.getProviderStatus(m.provider).configured);
  }
  if (searchQuery.value) {
    const q = searchQuery.value.toLowerCase();
    models = models.filter(
      (m) =>
        m.provider.toLowerCase().includes(q) ||
        m.id.toLowerCase().includes(q) ||
        `${m.provider}/${m.id}`.toLowerCase().includes(q),
    );
  }
  return models;
});

const groupedModels = computed(() => {
  const groups: Record<string, typeof filteredModels.value> = {};
  for (const model of filteredModels.value) {
    if (!groups[model.provider]) groups[model.provider] = [];
    groups[model.provider].push(model);
  }
  return Object.entries(groups).sort(([a], [b]) => a.localeCompare(b));
});

async function loadThinkingLevels(): Promise<void> {
  if (!isConnected.value) return;
  try {
    const levels = await rpc.getAvailableThinkingLevels();
    if (levels && levels.length > 0) {
      availableThinkingLevels.value = levels;
    }
  } catch {
    // Silently ignore — levels will be loaded on next open
  }
}

async function refreshModelData(): Promise<void> {
  if (!isConnected.value) return;
  await Promise.all([
    rpc.refreshModels(),
    authStore.refreshStatus(),
    loadThinkingLevels(),
  ]);
}

async function selectModel(model: { provider: string; id: string }): Promise<void> {
  await rpc.setModel(model.provider, model.id);
  emit("close");
}

async function selectThinkingLevel(level: string): Promise<void> {
  if (ALL_THINKING_LEVELS.includes(level as ThinkingLevel)) {
    await rpc.setThinkingLevel(level as ThinkingLevel);
  }
}

async function cycleModel(direction: "forward" | "backward" = "forward"): Promise<void> {
  await rpc.cycleModel(direction);
  emit("close");
}

function getAuthStatus(provider: string): { configured: boolean; source?: string } {
  return authStore.getProviderStatus(provider);
}

function formatContext(ctx?: number): string {
  if (!ctx) return "";
  if (ctx >= 1_000_000) return `${(ctx / 1_000_000).toFixed(1)}M ctx`;
  if (ctx >= 1000) return `${Math.round(ctx / 1000)}k ctx`;
  return `${ctx} ctx`;
}

// The component is created via v-if, so immediate watchers refresh stale auth/model
// state every time the selector opens.
watch(isConnected, (connected) => {
  if (connected) void refreshModelData();
}, { immediate: true });

watch(currentModel, () => {
  if (isConnected.value) void loadThinkingLevels();
}, { immediate: true });
</script>

<template>
  <div class="model-selector">
    <div class="model-panel">
      <!-- Header -->
      <div class="panel-header">
        <span class="panel-title">选择模型</span>
        <div class="header-actions">
          <label class="toggle-label" title="仅显示已配置的提供商">
            <input v-model="showOnlyConfigured" type="checkbox" />
            <span class="toggle-text">仅已配置</span>
          </label>
          <button class="close-btn" @click="emit('close')" title="关闭">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
      </div>

      <!-- Search -->
      <div class="search-row">
        <div class="search-wrapper">
          <span class="search-icon">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          </span>
          <input
            v-model="searchQuery"
            type="text"
            class="search-input"
            placeholder="搜索模型..."
            spellcheck="false"
          />
        </div>
      </div>

      <!-- Thinking level selector -->
      <div v-if="modelSupportsThinking && availableThinkingLevels.length > 0" class="thinking-row">
        <span class="thinking-label">思考深度</span>
        <div class="thinking-segments">
          <button
            v-for="level in availableThinkingLevels"
            :key="level"
            class="segment-btn"
            :class="{ active: currentThinkingLevel === level }"
            @click="selectThinkingLevel(level)"
          >
            {{ THINKING_LEVEL_LABELS[level] }}
          </button>
        </div>
      </div>

      <!-- Model list -->
      <div class="model-list">
        <template v-if="filteredModels.length === 0">
          <div class="empty-message">未找到模型</div>
        </template>
        <template v-else>
          <div v-for="[provider, models] in groupedModels" :key="provider" class="provider-group">
            <div class="provider-header">
              <span class="provider-name">{{ provider }}</span>
              <span
                class="provider-auth"
                :class="{ configured: getAuthStatus(provider).configured }"
              >
                {{ getAuthStatus(provider).configured ? '已配置' : '需登录' }}
              </span>
            </div>
            <button
              v-for="model in models"
              :key="`${model.provider}/${model.id}`"
              class="model-option"
              :class="{ active: currentModel?.provider === model.provider && currentModel?.id === model.id }"
              @click="selectModel(model)"
            >
              <div class="model-main">
                <span class="model-id">{{ model.id }}</span>
                <div class="model-tags">
                  <span v-if="model.contextWindow" class="model-tag ctx">{{ formatContext(model.contextWindow) }}</span>
                  <span v-if="model.reasoning" class="model-tag reasoning">推理</span>
                </div>
              </div>
              <span class="model-check" v-if="currentModel?.provider === model.provider && currentModel?.id === model.id">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
              </span>
              <span
                v-else-if="!getAuthStatus(model.provider).configured"
                class="model-auth-warn"
                title="提供商未配置"
              >!</span>
            </button>
          </div>
        </template>
      </div>

      <!-- Footer -->
      <div class="panel-footer">
        <button class="footer-btn" @click="cycleModel('backward')">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>
          <span>上一个</span>
        </button>
        <span class="footer-sep"></span>
        <button class="footer-btn" @click="cycleModel('forward')">
          <span>下一个</span>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
        </button>
      </div>
    </div>
    <div class="dropdown-backdrop" @click="emit('close')"></div>
  </div>
</template>

<style scoped>
.model-selector {
  position: absolute;
  bottom: 100%;
  left: 0;
  z-index: 100;
}

.model-panel {
  position: relative;
  z-index: 101;
  background: var(--pix-bg-elevated);
  border: 1px solid var(--pix-border);
  border-radius: var(--pix-radius-lg);
  box-shadow: var(--pix-shadow-lg);
  min-width: 360px;
  max-width: 400px;
  max-height: 480px;
  display: flex;
  flex-direction: column;
  margin-bottom: var(--pix-space-sm);
}

/* ── Header ── */
.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--pix-space-md) var(--pix-space-md) var(--pix-space-sm);
  flex-shrink: 0;
}

.panel-title {
  font-size: var(--pix-text-sm);
  font-weight: var(--pix-weight-semibold);
  color: var(--pix-text-primary);
}

.header-actions {
  display: flex;
  align-items: center;
  gap: var(--pix-space-sm);
}

.toggle-label {
  display: flex;
  align-items: center;
  gap: 5px;
  cursor: pointer;
  font-size: var(--pix-text-xs);
  color: var(--pix-text-secondary);
  user-select: none;
}

.toggle-label input {
  width: 13px;
  height: 13px;
  accent-color: var(--pix-accent);
  cursor: pointer;
}

.toggle-text {
  color: var(--pix-text-secondary);
}

.close-btn {
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--pix-radius-xs);
  color: var(--pix-text-secondary);
  cursor: pointer;
  transition: color var(--pix-transition-fast), background var(--pix-transition-fast);
}

.close-btn:hover {
  color: var(--pix-text-primary);
  background: var(--pix-bg-hover);
}

/* ── Search ── */
.search-row {
  padding: 0 var(--pix-space-md) var(--pix-space-sm);
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
  padding: 7px var(--pix-space-sm) 7px 30px;
  border: 1px solid var(--pix-border-light);
  border-radius: var(--pix-radius-sm);
  font-size: var(--pix-text-sm);
  font-family: var(--pix-font-ui);
  background: var(--pix-bg-input);
  color: var(--pix-text-primary);
  transition: border-color var(--pix-transition-fast), box-shadow var(--pix-transition-fast);
}

.search-input::placeholder {
  color: var(--pix-text-muted);
}

.search-input:focus {
  outline: none;
  border-color: var(--pix-accent);
  box-shadow: 0 0 0 2px var(--pix-accent-light);
}

/* ── Thinking level ── */
.thinking-row {
  display: flex;
  align-items: center;
  gap: var(--pix-space-sm);
  padding: var(--pix-space-xs) var(--pix-space-md) var(--pix-space-sm);
  flex-shrink: 0;
}

.thinking-label {
  font-size: var(--pix-text-xs);
  font-weight: var(--pix-weight-medium);
  color: var(--pix-text-secondary);
  white-space: nowrap;
  flex-shrink: 0;
}

.thinking-segments {
  display: flex;
  gap: 0;
  border: 1px solid var(--pix-border-light);
  border-radius: var(--pix-radius-sm);
  overflow: hidden;
}

.segment-btn {
  padding: 3px 10px;
  font-size: var(--pix-text-xs);
  font-family: var(--pix-font-ui);
  color: var(--pix-text-secondary);
  background: transparent;
  cursor: pointer;
  transition: background var(--pix-transition-fast), color var(--pix-transition-fast);
  border-right: 1px solid var(--pix-border-light);
  font-weight: var(--pix-weight-normal);
}

.segment-btn:last-child {
  border-right: none;
}

.segment-btn:hover {
  background: var(--pix-bg-hover);
  color: var(--pix-text-primary);
}

.segment-btn.active {
  background: var(--pix-accent-light);
  color: var(--pix-accent);
  font-weight: var(--pix-weight-semibold);
}

/* ── Model list ── */
.model-list {
  flex: 1;
  overflow-y: auto;
  padding: 0 var(--pix-space-xs) var(--pix-space-xs);
}

.empty-message {
  padding: var(--pix-space-xl);
  text-align: center;
  color: var(--pix-text-secondary);
  font-size: var(--pix-text-sm);
}

.provider-group {
  margin-bottom: 2px;
}

.provider-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: var(--pix-space-sm) var(--pix-space-md) var(--pix-space-xs);
}

.provider-name {
  font-size: var(--pix-text-xs);
  font-weight: var(--pix-weight-semibold);
  color: var(--pix-text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.provider-auth {
  font-size: var(--pix-text-xs);
  font-weight: var(--pix-weight-medium);
  padding: 1px 6px;
  border-radius: 8px;
  background: var(--pix-bg-hover);
  color: var(--pix-text-secondary);
}

.provider-auth.configured {
  background: var(--pix-success-bg);
  color: var(--pix-success);
}

/* Model option */
.model-option {
  display: flex;
  justify-content: space-between;
  align-items: center;
  width: 100%;
  padding: var(--pix-space-sm) var(--pix-space-md);
  border-radius: var(--pix-radius-sm);
  text-align: left;
  cursor: pointer;
  transition: background var(--pix-transition-fast);
  gap: var(--pix-space-sm);
}

.model-option:hover {
  background: var(--pix-bg-hover);
}

.model-option.active {
  background: var(--pix-accent-light);
}

.model-option.active:hover {
  background: var(--pix-accent-light-hover);
}

.model-main {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.model-id {
  font-family: var(--pix-font-ui);
  font-size: var(--pix-text-sm);
  color: var(--pix-text-primary);
  font-weight: var(--pix-weight-medium);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.model-option.active .model-id {
  color: var(--pix-accent);
}

.model-tags {
  display: flex;
  gap: 6px;
}

.model-tag {
  font-size: var(--pix-text-xs);
  font-weight: var(--pix-weight-medium);
  padding: 0 5px;
  border-radius: 3px;
  line-height: 16px;
}

.model-tag.ctx {
  background: var(--pix-bg-hover);
  color: var(--pix-text-secondary);
}

.model-option.active .model-tag.ctx {
  background: rgba(58, 109, 165, 0.12);
  color: var(--pix-accent);
}

.model-tag.reasoning {
  background: var(--pix-accent-light);
  color: var(--pix-accent);
}

/* Checkmark */
.model-check {
  color: var(--pix-accent);
  flex-shrink: 0;
  display: flex;
  align-items: center;
}

/* Auth warning */
.model-auth-warn {
  font-size: 10px;
  font-weight: var(--pix-weight-bold);
  color: var(--pix-warning);
  background: var(--pix-warning-bg);
  width: 18px;
  height: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  flex-shrink: 0;
}

/* ── Footer ── */
.panel-footer {
  display: flex;
  align-items: center;
  padding: var(--pix-space-sm) var(--pix-space-md);
  border-top: 1px solid var(--pix-border-light);
  flex-shrink: 0;
}

.footer-btn {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: var(--pix-space-xs) 0;
  font-size: var(--pix-text-sm);
  font-family: var(--pix-font-ui);
  color: var(--pix-accent);
  cursor: pointer;
  border-radius: var(--pix-radius-sm);
  transition: background var(--pix-transition-fast);
}

.footer-btn:hover {
  background: var(--pix-bg-hover);
}

.footer-sep {
  width: 1px;
  height: 16px;
  background: var(--pix-border-light);
  flex-shrink: 0;
}

/* ── Backdrop ── */
.dropdown-backdrop {
  position: fixed;
  inset: 0;
  z-index: 100;
}
</style>
