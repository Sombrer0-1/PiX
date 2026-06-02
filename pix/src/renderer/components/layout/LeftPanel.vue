<script setup lang="ts">
/**
 * LeftPanel - Navigation panel
 *
 * Manages:
 * - Project info
 * - New session button
 * - Session list
 * - Slash commands & skills list
 * - Settings link
 */
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import { useRpc } from "../../composables/useRpc";
import { useProjectStore } from "../../stores/project-store";
import { useCommandsStore } from "../../stores/commands-store";
import { useSessionStore } from "../../stores/session-store";
import type { AgentMessage } from "@/types/rpc";
import type { SessionInfo } from "@/types/session";

const router = useRouter();
const rpc = useRpc();
const projectStore = useProjectStore();
const commandsStore = useCommandsStore();
const sessionStore = useSessionStore();

const searchQuery = ref("");
const showCommands = ref(false);
const showSkills = ref(false);
const showExtensions = ref(false);

const projectName = computed(() => projectStore.currentProject?.name || "No Project");
const projectPath = computed(() => projectStore.currentProject?.path || "");

const filteredCommands = computed(() => {
  if (!searchQuery.value) return commandsStore.allCommands;
  const q = searchQuery.value.toLowerCase();
  return commandsStore.allCommands.filter(
    (c) => c.name.toLowerCase().includes(q) || (c.description && c.description.toLowerCase().includes(q))
  );
});

const filteredSessions = computed(() => {
  if (!searchQuery.value) return projectStore.sessions;
  const query = searchQuery.value.toLowerCase();
  return projectStore.sessions.filter((session) => {
    const name = session.name || session.id;
    return (
      name.toLowerCase().includes(query) ||
      session.firstMessage.toLowerCase().includes(query) ||
      session.path.toLowerCase().includes(query)
    );
  });
});

const extensionCommands = computed(() => commandsStore.extensionCommands);
const builtinSkills = computed(() => commandsStore.skills);
const promptTemplates = computed(() => commandsStore.promptTemplates);

async function newSession(): Promise<void> {
  const result = await rpc.newSession();
  if (result && !result.cancelled) {
    sessionStore.clearSession();
    projectStore.setCurrentSession(null);
    await rpc.refreshState();
    await projectStore.listSessions();
  }
}

async function handleSelectSession(session: SessionInfo): Promise<void> {
  projectStore.setCurrentSession(session);
  const result = await rpc.switchSession(session.path);
  if (!result || result.cancelled) return;

  const messages = await rpc.getMessages();
  if (messages) {
    sessionStore.loadMessages(messages as AgentMessage[]);
  }
  await rpc.refreshState();
}

function goHome(): void {
  router.push("/");
}

function goSettings(): void {
  router.push("/settings");
}

function getSourceLabel(source: string): string {
  switch (source) {
    case "skill": return "Skill";
    case "prompt": return "Template";
    case "extension": return "Ext";
    default: return "";
  }
}

function getSourceClass(source: string): string {
  switch (source) {
    case "skill": return "badge-skill";
    case "prompt": return "badge-prompt";
    case "extension": return "badge-ext";
    default: return "";
  }
}
</script>

<template>
  <div class="left-panel">
    <!-- Project Info -->
    <div class="panel-section project-section">
      <div class="project-info">
        <div class="project-name">{{ projectName }}</div>
        <div class="project-path" :title="projectPath">{{ projectPath }}</div>
      </div>
    </div>

    <!-- Actions -->
    <div class="panel-section actions-section">
      <button class="panel-btn primary-btn" @click="newSession" :disabled="!rpc.isConnected.value">
        + New Session
      </button>
    </div>

    <!-- Search -->
    <div class="panel-section search-section">
      <input
        v-model="searchQuery"
        type="text"
        class="search-input"
        placeholder="Search sessions..."
        spellcheck="false"
      />
    </div>

    <!-- Session List -->
    <div class="panel-section sessions-section">
      <div class="section-header">
        <span class="section-label">Sessions</span>
      </div>
      <div class="session-list">
        <button
          v-for="session in filteredSessions"
          :key="session.id"
          class="session-item"
          :class="{ active: projectStore.currentSession?.id === session.id }"
          @click="handleSelectSession(session)"
        >
          <div class="session-name">{{ session.name || session.id.slice(0, 8) }}</div>
          <div class="session-meta">{{ session.messageCount }} messages</div>
        </button>
        <div v-if="filteredSessions.length === 0" class="empty-list">
          No sessions yet
        </div>
      </div>
    </div>

    <!-- Slash Commands -->
    <div class="panel-section commands-section">
      <button class="section-header toggle-header" @click="showCommands = !showCommands">
        <span class="section-label">Commands</span>
        <span class="toggle-icon">{{ showCommands ? 'v' : '>' }}</span>
      </button>
      <div v-if="showCommands" class="commands-list">
        <div
          v-for="cmd in filteredCommands"
          :key="cmd.name"
          class="command-item"
        >
          <span class="command-name">/{{ cmd.name }}</span>
          <span v-if="cmd.description" class="command-desc">{{ cmd.description }}</span>
          <span class="badge" :class="getSourceClass(cmd.source)">{{ getSourceLabel(cmd.source) }}</span>
        </div>
      </div>
    </div>

    <!-- Extensions -->
    <div v-if="extensionCommands.length > 0" class="panel-section extensions-section">
      <button class="section-header toggle-header" @click="showExtensions = !showExtensions">
        <span class="section-label">Extensions</span>
        <span class="toggle-icon">{{ showExtensions ? 'v' : '>' }}</span>
      </button>
      <div v-if="showExtensions" class="commands-list">
        <div
          v-for="ext in extensionCommands"
          :key="ext.name"
          class="command-item"
        >
          <span class="command-name">/{{ ext.name }}</span>
          <span v-if="ext.description" class="command-desc">{{ ext.description }}</span>
          <span class="badge badge-ext">Ext</span>
        </div>
      </div>
    </div>

    <!-- Skills -->
    <div v-if="builtinSkills.length > 0" class="panel-section skills-section">
      <button class="section-header toggle-header" @click="showSkills = !showSkills">
        <span class="section-label">Skills</span>
        <span class="toggle-icon">{{ showSkills ? 'v' : '>' }}</span>
      </button>
      <div v-if="showSkills" class="commands-list">
        <div
          v-for="skill in builtinSkills"
          :key="skill.name"
          class="command-item"
        >
          <span class="command-name">/{{ skill.name }}</span>
          <span v-if="skill.description" class="command-desc">{{ skill.description }}</span>
          <span class="badge badge-skill">Skill</span>
        </div>
      </div>
    </div>

    <!-- Settings -->
    <div class="panel-section footer-section">
      <button class="panel-btn secondary-btn" @click="goSettings">
        Settings
      </button>
      <button class="panel-btn secondary-btn" @click="goHome">
        Home
      </button>
    </div>
  </div>
</template>

<style scoped>
.left-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: var(--pix-space-sm) 0;
}

.panel-section {
  padding: var(--pix-space-sm) var(--pix-space-md);
}

.project-info {
  padding: var(--pix-space-xs) 0;
}

.project-name {
  font-weight: 600;
  font-size: var(--pix-text-md);
  color: var(--pix-text-primary);
}

.project-path {
  font-size: var(--pix-text-xs);
  color: var(--pix-text-muted);
  font-family: var(--pix-font-mono);
  margin-top: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.actions-section {
  display: flex;
  gap: var(--pix-space-sm);
}

.panel-btn {
  flex: 1;
  padding: var(--pix-space-sm) var(--pix-space-md);
  border-radius: var(--pix-radius-sm);
  font-size: var(--pix-text-sm);
  font-weight: 500;
  text-align: center;
}

.primary-btn {
  background: var(--pix-accent);
  color: var(--pix-text-inverse);
}

.primary-btn:hover:not(:disabled) {
  opacity: 0.9;
}

.primary-btn:disabled {
  opacity: 0.5;
}

.secondary-btn {
  background: none;
  color: var(--pix-text-secondary);
  border: 1px solid var(--pix-border);
}

.secondary-btn:hover {
  background: var(--pix-bg-hover);
}

.search-section {
  padding-bottom: var(--pix-space-xs);
}

.search-input {
  width: 100%;
  padding: var(--pix-space-xs) var(--pix-space-sm);
  border: 1px solid var(--pix-border);
  border-radius: var(--pix-radius-sm);
  font-size: var(--pix-text-sm);
  background: var(--pix-bg-input);
  color: var(--pix-text-primary);
}

.search-input:focus {
  outline: none;
  border-color: var(--pix-border-focus);
}

.search-input::placeholder {
  color: var(--pix-text-muted);
}

.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: var(--pix-space-xs) 0;
  cursor: default;
}

.toggle-header {
  cursor: pointer;
  background: none;
  border: none;
  padding: var(--pix-space-xs) var(--pix-space-md);
  margin: 0 calc(-1 * var(--pix-space-md));
  width: calc(100% + 2 * var(--pix-space-md));
  border-radius: 0;
}

.toggle-header:hover {
  background: var(--pix-bg-hover);
}

.section-label {
  font-size: var(--pix-text-xs);
  font-weight: 600;
  color: var(--pix-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.toggle-icon {
  font-size: 8px;
  color: var(--pix-text-muted);
}

.session-list {
  margin-top: var(--pix-space-xs);
}

.session-item {
  display: block;
  width: 100%;
  text-align: left;
  padding: var(--pix-space-sm) var(--pix-space-md);
  border-radius: var(--pix-radius-sm);
  font-size: var(--pix-text-sm);
  margin: 0 calc(-1 * var(--pix-space-md));
  width: calc(100% + 2 * var(--pix-space-md));
}

.session-item:hover {
  background: var(--pix-bg-hover);
}

.session-item.active {
  background: var(--pix-bg-active);
}

.session-name {
  font-weight: 500;
  color: var(--pix-text-primary);
}

.session-meta {
  font-size: var(--pix-text-xs);
  color: var(--pix-text-muted);
  margin-top: 1px;
}

.empty-list {
  font-size: var(--pix-text-sm);
  color: var(--pix-text-muted);
  padding: var(--pix-space-md) 0;
  text-align: center;
}

.commands-list {
  margin-top: var(--pix-space-xs);
  max-height: 200px;
  overflow-y: auto;
}

.command-item {
  display: flex;
  align-items: baseline;
  gap: var(--pix-space-xs);
  padding: var(--pix-space-xs) var(--pix-space-md);
  margin: 0 calc(-1 * var(--pix-space-md));
  font-size: var(--pix-text-sm);
}

.command-item:hover {
  background: var(--pix-bg-hover);
}

.command-name {
  font-family: var(--pix-font-mono);
  font-size: var(--pix-text-xs);
  color: var(--pix-accent);
  font-weight: 500;
  flex-shrink: 0;
}

.command-desc {
  color: var(--pix-text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.badge {
  font-size: 9px;
  font-weight: 600;
  padding: 1px 4px;
  border-radius: 3px;
  flex-shrink: 0;
  margin-left: auto;
}

.badge-skill {
  background: #e8f0f8;
  color: var(--pix-accent);
}

.badge-prompt {
  background: #f0e8f8;
  color: #7c4a9e;
}

.badge-ext {
  background: #e8f4e8;
  color: var(--pix-success);
}

.footer-section {
  margin-top: auto;
  display: flex;
  gap: var(--pix-space-sm);
  padding-bottom: var(--pix-space-md);
  border-top: 1px solid var(--pix-border-light);
  padding-top: var(--pix-space-md);
}
</style>
