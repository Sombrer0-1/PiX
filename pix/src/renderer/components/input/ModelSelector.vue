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

// Load thinking levels when dropdown opens or model changes.
// immediate: true is required because the component is created via v-if each time
// and isConnected/currentModel are already set by the time the watch registers.
watch([isConnected, currentModel], ([connected]) => {
  if (connected) void loadThinkingLevels();
}, { immediate: true });
</script>

<template>
  <div class="model-selector">
    <div class="model-dropdown">
      <div class="dropdown-header">
        <span class="dropdown-title">选择模型</span>
        <div class="header-actions">
          <label class="configured-toggle" title="仅显示已配置的提供商">
            <input v-model="showOnlyConfigured" type="checkbox" />
            <span>仅已配置</span>
          </label>
          <button class="dropdown-close" @click="emit('close')">&times;</button>
        </div>
      </div>

      <div class="dropdown-search">
        <input
          v-model="searchQuery"
          type="text"
          class="search-input"
          placeholder="搜索模型..."
          spellcheck="false"
        />
      </div>

      <!-- 思考深度选择器 -->
      <div v-if="modelSupportsThinking && availableThinkingLevels.length > 0" class="thinking-row">
        <span class="thinking-label">思考深度</span>
        <div class="thinking-chips">
          <button
            v-for="level in availableThinkingLevels"
            :key="level"
            class="thinking-chip"
            :class="{ active: currentThinkingLevel === level }"
            @click="selectThinkingLevel(level)"
          >
            {{ THINKING_LEVEL_LABELS[level] }}
          </button>
        </div>
      </div>

      <div class="dropdown-list">
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
                {{ getAuthStatus(provider).configured ? '✓' : '需登录' }}
              </span>
            </div>
            <button
              v-for="model in models"
              :key="`${model.provider}/${model.id}`"
              class="model-option"
              :class="{ active: currentModel?.provider === model.provider && currentModel?.id === model.id }"
              @click="selectModel(model)"
            >
              <div class="model-info">
                <span class="model-name">{{ model.id }}</span>
                <span class="model-meta">
                  <span v-if="model.contextWindow" class="model-ctx">{{ formatContext(model.contextWindow) }}</span>
                  <span v-if="model.reasoning" class="model-thinking">推理</span>
                </span>
              </div>
              <span
                v-if="!getAuthStatus(model.provider).configured"
                class="model-auth-warn"
                title="提供商未配置"
              >!</span>
            </button>
          </div>
        </template>
      </div>

      <div class="dropdown-footer">
        <button class="cycle-btn" @click="cycleModel('backward')">&larr; 上一个</button>
        <span class="cycle-separator"></span>
        <button class="cycle-btn" @click="cycleModel('forward')">下一个 &rarr;</button>
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

.model-dropdown {
  position: relative;
  z-index: 101;
  background: var(--pix-bg-content);
  border: 1px solid var(--pix-border);
  border-radius: var(--pix-radius-md);
  box-shadow: var(--pix-shadow-md);
  min-width: 340px;
  max-height: 480px;
  display: flex;
  flex-direction: column;
  margin-bottom: var(--pix-space-sm);
}

.dropdown-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--pix-space-sm) var(--pix-space-md);
  border-bottom: 1px solid var(--pix-border-light);
}

.dropdown-title {
  font-size: var(--pix-text-xs);
  font-weight: 600;
  color: var(--pix-text-muted);
  text-transform: uppercase;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: var(--pix-space-sm);
}

.configured-toggle {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 10px;
  color: var(--pix-text-muted);
  cursor: pointer;
}

.configured-toggle input {
  width: 12px;
  height: 12px;
  accent-color: var(--pix-accent);
}

.dropdown-close {
  font-size: var(--pix-text-lg);
  color: var(--pix-text-muted);
  line-height: 1;
}

.dropdown-close:hover {
  color: var(--pix-text-primary);
}

/* Search */
.dropdown-search {
  padding: var(--pix-space-sm) var(--pix-space-md);
  border-bottom: 1px solid var(--pix-border-light);
}

.search-input {
  width: 100%;
  padding: 4px 8px;
  border: 1px solid var(--pix-border);
  border-radius: var(--pix-radius-sm);
  font-size: var(--pix-text-xs);
  font-family: var(--pix-font-mono);
  background: var(--pix-bg-input);
  color: var(--pix-text-primary);
}

.search-input:focus {
  outline: none;
  border-color: var(--pix-border-focus);
}

/* List */
.dropdown-list {
  flex: 1;
  overflow-y: auto;
  padding: var(--pix-space-xs);
}

.empty-message {
  padding: var(--pix-space-xl);
  text-align: center;
  color: var(--pix-text-muted);
  font-size: var(--pix-text-sm);
}

/* Provider groups */
.provider-group {
  margin-bottom: var(--pix-space-xs);
}

.provider-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: var(--pix-space-xs) var(--pix-space-md);
  border-bottom: 1px solid var(--pix-border-light);
}

.provider-name {
  font-size: 11px;
  font-weight: 600;
  color: var(--pix-text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.provider-auth {
  font-size: 10px;
  color: var(--pix-text-muted);
}

.provider-auth.configured {
  color: var(--pix-success);
}

/* Model options */
.model-option {
  display: flex;
  justify-content: space-between;
  align-items: center;
  width: 100%;
  padding: var(--pix-space-sm) var(--pix-space-md);
  border-radius: var(--pix-radius-sm);
  text-align: left;
  font-size: var(--pix-text-sm);
}

.model-option:hover {
  background: var(--pix-bg-hover);
}

.model-option.active {
  background: var(--pix-accent-light);
}

.model-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.model-name {
  font-family: var(--pix-font-mono);
  font-size: var(--pix-text-xs);
  color: var(--pix-text-primary);
}

.model-meta {
  display: flex;
  gap: var(--pix-space-sm);
}

.model-ctx {
  font-size: 10px;
  color: var(--pix-text-muted);
}

.model-thinking {
  font-size: 10px;
  color: var(--pix-accent);
  background: var(--pix-accent-light);
  padding: 0 4px;
  border-radius: 3px;
}

.model-auth-warn {
  font-size: 10px;
  font-weight: 700;
  color: var(--pix-warning);
  background: var(--pix-warning-bg);
  width: 16px;
  height: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
}

/* Footer */
.dropdown-footer {
  display: flex;
  padding: var(--pix-space-sm) var(--pix-space-md);
  border-top: 1px solid var(--pix-border-light);
}

.cycle-btn {
  flex: 1;
  padding: var(--pix-space-xs) 0;
  font-size: var(--pix-text-sm);
  color: var(--pix-accent);
  text-align: center;
}

.cycle-btn:hover {
  text-decoration: underline;
}

.cycle-separator {
  width: 1px;
  background: var(--pix-border-light);
  margin: 0 var(--pix-space-sm);
}

/* Thinking level row */
.thinking-row {
  display: flex;
  align-items: center;
  gap: var(--pix-space-sm);
  padding: var(--pix-space-sm) var(--pix-space-md);
  border-bottom: 1px solid var(--pix-border-light);
}

.thinking-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--pix-text-muted);
  text-transform: uppercase;
  white-space: nowrap;
  flex-shrink: 0;
}

.thinking-chips {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}

.thinking-chip {
  padding: 2px 8px;
  border: 1px solid var(--pix-border);
  border-radius: 4px;
  font-size: 11px;
  font-family: var(--pix-font-ui);
  color: var(--pix-text-secondary);
  background: var(--pix-bg-app);
  cursor: pointer;
  transition: background var(--pix-transition-fast), border-color var(--pix-transition-fast), color var(--pix-transition-fast);
}

.thinking-chip:hover {
  background: var(--pix-bg-hover);
  border-color: var(--pix-border-focus);
  color: var(--pix-text-primary);
}

.thinking-chip.active {
  background: var(--pix-accent-light);
  border-color: var(--pix-accent);
  color: var(--pix-accent);
  font-weight: 600;
}

/* Backdrop */
.dropdown-backdrop {
  position: fixed;
  inset: 0;
  z-index: 100;
}
</style>
