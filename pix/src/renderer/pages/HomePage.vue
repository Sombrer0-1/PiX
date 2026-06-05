<script setup lang="ts">
/**
 * Home Page
 */
import { ref, onMounted, computed } from "vue";
import { useRouter } from "vue-router";
import { useSettingsStore } from "../stores/settings-store";
import { useProjectStore } from "../stores/project-store";
import { useSessionStore } from "../stores/session-store";
import { useRpc } from "../composables/useRpc";
import type { ProjectInfo } from "@/types/session";

const router = useRouter();
const settingsStore = useSettingsStore();
const projectStore = useProjectStore();
const sessionStore = useSessionStore();
const rpc = useRpc();

const piDetection = ref<{ found: boolean; path: string; note?: string } | null>(null);

onMounted(async () => {
  await projectStore.loadSettings();
  try {
    piDetection.value = await settingsStore.detectPi();
  } catch {
    piDetection.value = { found: true, path: "direct", note: "Direct AgentSession integration" };
  }
});

const recentProjects = computed(() => projectStore.recentProjects);

async function startFreshWorkspace(dirPath: string): Promise<void> {
  if (await rpc.startPi(dirPath)) {
    await projectStore.openProject(dirPath);
    const result = await rpc.newSession();
    if (!result || result.cancelled) {
      alert(`Failed to create a new session: ${rpc.lastError.value || "Unknown error"}`);
      return;
    }
    sessionStore.clearSession();
    await projectStore.listSessions();
    projectStore.syncCurrentSession(
      rpc.sessionState.value?.sessionFile,
      rpc.sessionState.value?.sessionId
    );
    router.push("/workspace");
  } else {
    alert(`Failed to start Pi: ${rpc.lastError.value || "Unknown error"}`);
  }
}

async function openProject(): Promise<void> {
  const dirPath = await window.pixApi.selectProject();
  if (!dirPath) return;
  await startFreshWorkspace(dirPath);
}

async function openRecentProject(project: ProjectInfo): Promise<void> {
  await startFreshWorkspace(project.path);
}

async function removeRecentProject(project: ProjectInfo): Promise<void> {
  await projectStore.removeRecentProject(project.path);
}

function formatDate(timestamp: number): string {
  const d = new Date(timestamp);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  if (diff < 86400000) return "今天";
  if (diff < 172800000) return "昨天";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
</script>

<template>
  <div class="home-page">
    <div class="drag-bar"></div>
    <div class="home-container-wrapper">
      <div class="home-container">
        <header class="home-header">
          <div class="home-logo">Pi</div>
          <div class="home-heading">
            <h1 class="home-title">PiX</h1>
            <p class="home-subtitle">AI 编程工作区</p>
          </div>
        </header>

        <div class="home-card">
          <div class="pi-status-row">
            <span class="pi-status-dot" :class="{ ready: piDetection?.found }"></span>
            <span>{{ piDetection?.found ? 'Pi 就绪' : 'Pi 未检测到' }}</span>
          </div>

          <div class="home-actions">
            <v-btn
              class="open-project-btn"
              variant="flat"
              color="primary"
              size="large"
              block
              prepend-icon="mdi-folder-open-outline"
              @click="openProject"
            >
              打开项目文件夹
            </v-btn>
          </div>
        </div>

        <section v-if="recentProjects.length > 0" class="home-section">
          <h2 class="section-title">最近项目</h2>
          <v-card class="recent-card" variant="flat">
          <v-list density="default" bg-color="transparent">
            <v-list-item
              v-for="project in recentProjects"
              :key="project.path"
              :title="project.name"
              :subtitle="formatDate(project.lastOpened)"
              @click="openRecentProject(project)"
              class="project-list-item"
            >
              <template #append>
                <div class="project-list-actions">
                  <span class="project-path-mono">{{ project.path }}</span>
                  <button
                    class="project-delete-btn"
                    type="button"
                    title="从最近项目中移除"
                    aria-label="从最近项目中移除"
                    @click.stop="removeRecentProject(project)"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <polyline points="3 6 5 6 21 6" />
                      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                    </svg>
                  </button>
                </div>
              </template>
            </v-list-item>
          </v-list>
          </v-card>
        </section>

        <section v-else class="home-section home-empty">
          <p class="empty-text">暂无最近项目。打开项目目录以开始。</p>
        </section>

        <footer class="home-footer">
          <router-link to="/settings" class="footer-link">设置</router-link>
        </footer>
      </div>
    </div>
  </div>
</template>

<style scoped>
.home-page {
  height: 100%;
  display: flex;
  flex-direction: column;
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.7), rgba(247, 248, 252, 0.96)),
    var(--pix-bg-app);
}

.drag-bar {
  height: 32px;
  min-height: 32px;
  -webkit-app-region: drag;
  flex-shrink: 0;
  margin-right: 64px;
}

.home-container-wrapper {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--pix-space-xl);
}

.home-container {
  width: 100%;
  max-width: 640px;
  padding: var(--pix-space-xl);
}

.home-header {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--pix-space-md);
  margin-bottom: var(--pix-space-lg);
}

.home-logo {
  width: 52px;
  height: 52px;
  border-radius: 14px;
  background: linear-gradient(135deg, #7567f5 0%, #5142df 100%);
  color: var(--pix-text-inverse);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: var(--pix-text-xl);
  font-weight: var(--pix-weight-bold);
  box-shadow: 0 16px 34px rgba(98, 84, 243, 0.28);
}

.home-heading {
  min-width: 0;
}

.home-title {
  font-size: 34px;
  font-weight: 700;
  color: var(--pix-text-primary);
  letter-spacing: 0;
  line-height: 1.1;
}

.home-subtitle {
  margin-top: var(--pix-space-xs);
  color: var(--pix-text-muted);
  font-size: var(--pix-text-base);
}

.home-card,
.recent-card {
  background: rgba(255, 255, 255, 0.94) !important;
  border: 1px solid var(--pix-border-light);
  border-radius: var(--pix-radius-xl);
  box-shadow: var(--pix-shadow-md);
}

.home-card {
  padding: var(--pix-space-lg);
  margin-bottom: var(--pix-space-xl);
}

.pi-status-row {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  height: 28px;
  padding: 0 10px;
  border-radius: 999px;
  background: var(--pix-bg-hover);
  color: var(--pix-text-secondary);
  font-size: var(--pix-text-xs);
  font-weight: var(--pix-weight-medium);
  margin-bottom: var(--pix-space-md);
}

.pi-status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--pix-text-muted);
}

.pi-status-dot.ready {
  background: var(--pix-success);
}

.home-actions {
  display: flex;
  justify-content: center;
}

.open-project-btn {
  min-height: 44px;
  border-radius: var(--pix-radius-lg) !important;
  background: linear-gradient(135deg, #7567f5 0%, #5142df 100%) !important;
  box-shadow: 0 14px 28px rgba(98, 84, 243, 0.24) !important;
  font-weight: var(--pix-weight-semibold);
}

.open-project-btn:hover {
  box-shadow: 0 17px 34px rgba(98, 84, 243, 0.3) !important;
}

.home-section {
  margin-bottom: var(--pix-space-xl);
}

.section-title {
  font-size: var(--pix-text-xs);
  font-weight: 600;
  color: var(--pix-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.3px;
  margin-bottom: var(--pix-space-sm);
  padding-left: 2px;
}

.recent-card {
  overflow: hidden;
}

.project-list-item {
  cursor: pointer;
  border-radius: var(--pix-radius-md);
  margin: 4px 6px;
  min-height: 58px;
  transition: background var(--pix-transition-fast);
}

.project-list-item:hover {
  background: var(--pix-bg-hover);
}

.project-list-actions {
  display: inline-flex;
  align-items: center;
  gap: var(--pix-space-xs);
  min-width: 0;
}

.project-path-mono {
  font-family: var(--pix-font-mono);
  font-size: var(--pix-text-xs);
  color: var(--pix-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 250px;
}

.project-delete-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: var(--pix-radius-md);
  color: var(--pix-text-muted);
  transition: color var(--pix-transition-fast), background var(--pix-transition-fast);
}

.project-delete-btn:hover {
  color: var(--pix-error);
  background: var(--pix-error-bg);
}

.home-empty {
  text-align: center;
  padding: var(--pix-space-xl);
  border: 1px dashed var(--pix-border);
  border-radius: var(--pix-radius-xl);
  background: rgba(255, 255, 255, 0.7);
}

.empty-text {
  color: var(--pix-text-muted);
  font-size: var(--pix-text-sm);
}

.home-footer {
  text-align: center;
  margin-top: var(--pix-space-xl);
}

.footer-link {
  color: var(--pix-text-muted);
  font-size: var(--pix-text-sm);
}

.footer-link:hover {
  color: var(--pix-text-secondary);
}
</style>
