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
  minimal: "轻量",
  low: "快速",
  medium: "标准",
  high: "深入",
  xhigh: "极深",
};

const THINKING_LEVEL_DESCRIPTIONS: Record<string, string> = {
  off: "不启用额外推理，适合直接任务",
  minimal: "最低推理开销，适合快速答复",
  low: "优先响应速度，适合简单任务",
  medium: "速度更快，适合日常问答",
  high: "更强推理，适合复杂问题",
  xhigh: "最充分思考，适合高难任务",
};

const emit = defineEmits<{
  close: [];
}>();

const rpc = useRpc();
const authStore = useAuthStore();

const searchQuery = ref("");
const showOnlyConfigured = ref(false);
const openThinkingForModel = ref<string | null>(null);

const allModels = computed(() => rpc.availableModels.value);
const currentModel = computed(() => rpc.sessionState.value?.model);
const currentThinkingLevel = computed(() => rpc.sessionState.value?.thinkingLevel ?? "medium");
const isConnected = computed(() => rpc.isConnected.value);

const openThinkingModel = computed(() => {
  const key = openThinkingForModel.value;
  if (!key) return null;
  return allModels.value.find((model) => modelKey(model) === key) ?? null;
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

async function refreshModelData(): Promise<void> {
  if (!isConnected.value) return;
  await Promise.all([
    rpc.refreshModels(),
    authStore.refreshStatus(),
  ]);
}

async function selectModel(model: { provider: string; id: string }): Promise<void> {
  await rpc.setModel(model.provider, model.id);
  if (modelHasThinking(model)) {
    openThinkingForModel.value = modelKey(model);
  } else {
    openThinkingForModel.value = null;
    emit("close");
  }
}

async function cycleModel(direction: "forward" | "backward" = "forward"): Promise<void> {
  await rpc.cycleModel(direction);
  emit("close");
}

function modelKey(model: { provider: string; id: string }): string {
  return `${model.provider}/${model.id}`;
}

function isCurrentModel(model: { provider: string; id: string }): boolean {
  return currentModel.value?.provider === model.provider && currentModel.value?.id === model.id;
}

function thinkingLabel(level = String(currentThinkingLevel.value)): string {
  return THINKING_LEVEL_LABELS[level] ?? level;
}

function thinkingDescription(level: string): string {
  return THINKING_LEVEL_DESCRIPTIONS[level] ?? "选择该模型的思考深度";
}

function thinkingLevelsFor(model: { reasoning?: boolean; thinkingLevels?: string[] } | null): string[] {
  if (!model?.reasoning) return ["off"];
  const supported = (model.thinkingLevels ?? []).filter((level) =>
    ALL_THINKING_LEVELS.includes(level as ThinkingLevel)
  );
  return supported.length > 0 ? supported : [...ALL_THINKING_LEVELS];
}

function modelHasThinking(model: { reasoning?: boolean; thinkingLevels?: string[] }): boolean {
  return !!model.reasoning && thinkingLevelsFor(model).length > 0;
}

async function focusThinkingPanel(model: { provider: string; id: string; reasoning?: boolean; thinkingLevels?: string[] }): Promise<void> {
  if (!modelHasThinking(model)) return;
  openThinkingForModel.value = modelKey(model);
  if (!isCurrentModel(model)) {
    await rpc.setModel(model.provider, model.id);
  }
}

async function selectModelThinking(model: { provider: string; id: string }, level: string): Promise<void> {
  await rpc.setModel(model.provider, model.id);
  if (ALL_THINKING_LEVELS.includes(level as ThinkingLevel)) {
    await rpc.setThinkingLevel(level as ThinkingLevel);
  }
  openThinkingForModel.value = null;
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

watch([currentModel, allModels], () => {
  if (openThinkingForModel.value) return;
  const model = allModels.value.find((m) =>
    currentModel.value?.provider === m.provider && currentModel.value?.id === m.id
  );
  if (model && modelHasThinking(model)) {
    openThinkingForModel.value = modelKey(model);
  }
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
            <div
              v-for="model in models"
              :key="`${model.provider}/${model.id}`"
              class="model-option-wrap"
            >
              <div class="model-option-row">
                <button
                  class="model-option"
                  :class="{ active: isCurrentModel(model), 'thinking-open': openThinkingForModel === modelKey(model) }"
                  @click="selectModel(model)"
                >
                  <div class="model-main">
                    <span class="model-id">{{ model.id }}</span>
                    <div class="model-tags">
                      <span v-if="model.contextWindow" class="model-tag ctx">{{ formatContext(model.contextWindow) }}</span>
                      <span v-if="model.reasoning" class="model-tag reasoning">思考</span>
                    </div>
                  </div>
                  <span class="model-check" v-if="isCurrentModel(model)">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                  </span>
                  <span
                    v-else-if="!getAuthStatus(model.provider).configured"
                    class="model-auth-warn"
                    title="提供商未配置"
                  >!</span>
                </button>
                <button
                  v-if="model.reasoning"
                  class="model-thinking-trigger"
                  :class="{ active: openThinkingForModel === modelKey(model) }"
                  title="选择这个模型的思考深度"
                  @click.stop="focusThinkingPanel(model)"
                >
                  <span class="sr-only">选择思考深度</span>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"/></svg>
                </button>
              </div>
            </div>
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
    <div v-if="openThinkingModel" class="thinking-side-panel">
      <div class="thinking-side-header">
        <span>选择思考深度</span>
        <button class="thinking-close-btn" title="关闭" @click="openThinkingForModel = null">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <div class="thinking-model-name">{{ openThinkingModel.provider }}/{{ openThinkingModel.id }}</div>
      <div class="thinking-side-options">
        <button
          v-for="level in thinkingLevelsFor(openThinkingModel)"
          :key="level"
          class="thinking-side-choice"
          :class="{ active: isCurrentModel(openThinkingModel) && currentThinkingLevel === level }"
          @click="selectModelThinking(openThinkingModel, level)"
        >
          <span class="thinking-radio"></span>
          <span class="thinking-choice-text">
            <span class="thinking-choice-label">{{ thinkingLabel(level) }}</span>
            <span class="thinking-choice-desc">{{ thinkingDescription(level) }}</span>
          </span>
        </button>
      </div>
      <div class="thinking-side-note">
        <span class="thinking-note-icon">i</span>
        <span>思考深度仅影响模型思考过程，不会改变输出格式。</span>
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
  display: flex;
  align-items: flex-start;
  gap: 18px;
}

.model-panel {
  position: relative;
  z-index: 101;
  background: rgba(255, 255, 255, 0.97);
  border: 1px solid var(--pix-border-light);
  border-radius: var(--pix-radius-xl);
  box-shadow: var(--pix-shadow-xl);
  min-width: 382px;
  max-width: 420px;
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
  border-radius: var(--pix-radius-md);
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
  height: 38px;
  padding: 8px var(--pix-space-sm) 8px 30px;
  border: 1px solid var(--pix-border-light);
  border-radius: var(--pix-radius-lg);
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
  box-shadow: 0 0 0 3px rgba(98, 84, 243, 0.12);
}

/* ── Thinking level ── */
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
  border-radius: 999px;
  background: var(--pix-bg-hover);
  color: var(--pix-text-secondary);
}

.provider-auth.configured {
  background: var(--pix-success-bg);
  color: var(--pix-success);
}

.model-option-wrap {
  margin: 1px var(--pix-space-xs);
}

.model-option-row {
  display: flex;
  align-items: stretch;
  gap: 6px;
}

/* Model option */
.model-option {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex: 1;
  min-width: 0;
  padding: var(--pix-space-sm) var(--pix-space-md);
  border-radius: var(--pix-radius-lg);
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
  box-shadow: inset 3px 0 0 var(--pix-accent);
}

.model-option.thinking-open {
  background: rgba(98, 84, 243, 0.08);
  box-shadow:
    inset 3px 0 0 var(--pix-accent),
    0 0 0 1px rgba(98, 84, 243, 0.35);
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
  border-radius: 999px;
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

.model-thinking-trigger {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  min-width: 36px;
  padding: 0;
  border: 1px solid #dde2ee;
  border-radius: var(--pix-radius-lg);
  background: rgba(255, 255, 255, 0.94);
  color: var(--pix-text-secondary);
  font-size: var(--pix-text-xs);
  font-weight: var(--pix-weight-medium);
  cursor: pointer;
  transition:
    background var(--pix-transition-fast),
    border-color var(--pix-transition-fast),
    color var(--pix-transition-fast);
}

.model-thinking-trigger:hover,
.model-thinking-trigger.active {
  background: var(--pix-accent-light);
  border-color: rgba(98, 84, 243, 0.45);
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
  border-radius: var(--pix-radius-md);
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
.thinking-side-panel {
  position: relative;
  z-index: 101;
  width: 270px;
  padding: var(--pix-space-md);
  border: 1px solid var(--pix-border-light);
  border-radius: var(--pix-radius-xl);
  background: rgba(255, 255, 255, 0.98);
  box-shadow: 0 18px 46px rgba(24, 32, 56, 0.16), 0 3px 12px rgba(24, 32, 56, 0.08);
}

.thinking-side-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 4px;
  color: #000000;
  font-size: var(--pix-text-base);
  font-weight: var(--pix-weight-semibold);
}

.thinking-model-name {
  margin-bottom: var(--pix-space-md);
  color: var(--pix-text-muted);
  font-size: var(--pix-text-xs);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.thinking-close-btn {
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--pix-radius-md);
  color: var(--pix-text-secondary);
  transition: background var(--pix-transition-fast), color var(--pix-transition-fast);
}

.thinking-close-btn:hover {
  background: var(--pix-bg-hover);
  color: #000000;
}

.thinking-side-options {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.thinking-side-choice {
  display: flex;
  align-items: flex-start;
  gap: var(--pix-space-sm);
  width: 100%;
  padding: 10px 8px;
  text-align: left;
  border-radius: var(--pix-radius-lg);
  color: #000000;
  transition: background var(--pix-transition-fast);
}

.thinking-side-choice:hover {
  background: #f7f8ff;
}

.thinking-radio {
  position: relative;
  width: 18px;
  height: 18px;
  margin-top: 2px;
  border: 1.5px solid #c8cede;
  border-radius: 50%;
  background: #ffffff;
  flex-shrink: 0;
}

.thinking-side-choice.active .thinking-radio {
  border-color: var(--pix-accent);
  box-shadow: 0 0 0 3px rgba(98, 84, 243, 0.12);
}

.thinking-side-choice.active .thinking-radio::after {
  content: "";
  position: absolute;
  inset: 3px;
  border-radius: 50%;
  background: var(--pix-accent);
}

.thinking-choice-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.thinking-choice-label {
  color: #000000;
  font-size: var(--pix-text-sm);
  font-weight: var(--pix-weight-semibold);
}

.thinking-choice-desc {
  color: var(--pix-text-muted);
  font-size: var(--pix-text-xs);
  line-height: var(--pix-leading-tight);
}

.thinking-side-note {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin-top: var(--pix-space-md);
  padding-top: var(--pix-space-md);
  color: var(--pix-text-muted);
  font-size: var(--pix-text-xs);
  line-height: var(--pix-leading-base);
}

.thinking-note-icon {
  width: 15px;
  height: 15px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin-top: 1px;
  border: 1px solid var(--pix-text-muted);
  border-radius: 50%;
  font-size: 10px;
  font-family: var(--pix-font-mono);
  flex-shrink: 0;
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

.dropdown-backdrop {
  position: fixed;
  inset: 0;
  z-index: 100;
}
</style>
