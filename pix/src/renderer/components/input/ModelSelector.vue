<script setup lang="ts">
/**
 * ModelSelector - Dropdown to select or cycle models
 *
 * Shows available models with auth status, search, and provider grouping.
 */
import { computed, ref } from "vue";
import { useRpc } from "../../composables/useRpc";
import { useAuthStore } from "../../stores/auth-store";

const emit = defineEmits<{
  close: [];
}>();

const rpc = useRpc();
const authStore = useAuthStore();

const searchQuery = ref("");
const showOnlyConfigured = ref(false);

const allModels = computed(() => rpc.availableModels.value);
const currentModel = computed(() => rpc.sessionState.value?.model);

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

async function selectModel(model: { provider: string; id: string }): Promise<void> {
  await rpc.setModel(model.provider, model.id);
  emit("close");
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
</script>

<template>
  <div class="model-selector">
    <div class="model-dropdown">
      <div class="dropdown-header">
        <span class="dropdown-title">Select Model</span>
        <div class="header-actions">
          <label class="configured-toggle" title="Show only configured providers">
            <input v-model="showOnlyConfigured" type="checkbox" />
            <span>Configured only</span>
          </label>
          <button class="dropdown-close" @click="emit('close')">&times;</button>
        </div>
      </div>

      <div class="dropdown-search">
        <input
          v-model="searchQuery"
          type="text"
          class="search-input"
          placeholder="Search models..."
          spellcheck="false"
        />
      </div>

      <div class="dropdown-list">
        <template v-if="filteredModels.length === 0">
          <div class="empty-message">No models found</div>
        </template>
        <template v-else>
          <div v-for="[provider, models] in groupedModels" :key="provider" class="provider-group">
            <div class="provider-header">
              <span class="provider-name">{{ provider }}</span>
              <span
                class="provider-auth"
                :class="{ configured: getAuthStatus(provider).configured }"
              >
                {{ getAuthStatus(provider).configured ? '✓' : 'Login required' }}
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
                  <span v-if="model.reasoning" class="model-thinking">thinking</span>
                </span>
              </div>
              <span
                v-if="!getAuthStatus(model.provider).configured"
                class="model-auth-warn"
                title="Provider not configured"
              >!</span>
            </button>
          </div>
        </template>
      </div>

      <div class="dropdown-footer">
        <button class="cycle-btn" @click="cycleModel('backward')">&larr; Prev</button>
        <span class="cycle-separator"></span>
        <button class="cycle-btn" @click="cycleModel('forward')">Next &rarr;</button>
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

/* Backdrop */
.dropdown-backdrop {
  position: fixed;
  inset: 0;
  z-index: 100;
}
</style>
