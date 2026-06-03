<script setup lang="ts">
/**
 * Home Page
 */
import { ref, onMounted, computed } from "vue";
import { useRouter } from "vue-router";
import { useSettingsStore } from "../stores/settings-store";
import { useProjectStore } from "../stores/project-store";
import { useRpc } from "../composables/useRpc";
import type { ProjectInfo } from "@/types/session";

const router = useRouter();
const settingsStore = useSettingsStore();
const projectStore = useProjectStore();
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

async function openProject(): Promise<void> {
  const dirPath = await window.pixApi.selectProject();
  if (!dirPath) return;
  if (await rpc.startPi(dirPath)) {
    await projectStore.openProject(dirPath);
    router.push("/workspace");
  } else {
    alert(`Failed to start Pi: ${rpc.lastError.value || "Unknown error"}`);
  }
}

async function openRecentProject(project: ProjectInfo): Promise<void> {
  if (await rpc.startPi(project.path)) {
    await projectStore.openProject(project.path);
    router.push("/workspace");
  } else {
    alert(`Failed to start Pi: ${rpc.lastError.value || "Unknown error"}`);
  }
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
        <h1 class="home-title">PiX</h1>
        <p class="home-subtitle">AI 编程工作区</p>
      </header>

      <div class="pi-status-row">
        <v-chip
          size="small"
          :color="piDetection?.found ? 'success' : undefined"
          variant="tonal"
        >
          {{ piDetection?.found ? 'Pi 就绪' : 'Pi 未检测到' }}
        </v-chip>
      </div>

      <div class="home-actions">
        <v-btn
          variant="outlined"
          color="primary"
          size="large"
          block
          @click="openProject"
        >
          打开项目...
        </v-btn>
      </div>

      <section v-if="recentProjects.length > 0" class="home-section">
        <h2 class="section-title">最近</h2>
        <v-card variant="flat" border>
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
                <span class="project-path-mono">{{ project.path }}</span>
              </template>
            </v-list-item>
          </v-list>
        </v-card>
      </section>

      <section v-else class="home-section home-empty">
        <p class="empty-text">暂无最近项目。打开项目目录以开始。</p>
      </section>

      <footer class="home-footer">
        <router-link to="/settings" class="footer-link">Settings</router-link>
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
  background: var(--pix-bg-app);
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
}

.home-container {
  width: 100%;
  max-width: 520px;
  padding: var(--pix-space-2xl);
}

.home-header {
  text-align: center;
  margin-bottom: var(--pix-space-xl);
}

.home-title {
  font-size: 32px;
  font-weight: 600;
  color: var(--pix-text-primary);
  letter-spacing: -0.3px;
}

.home-subtitle {
  margin-top: var(--pix-space-xs);
  color: var(--pix-text-muted);
  font-size: var(--pix-text-md);
}

.pi-status-row {
  display: flex;
  justify-content: center;
  margin-bottom: var(--pix-space-xl);
}

.home-actions {
  display: flex;
  justify-content: center;
  margin-bottom: var(--pix-space-2xl);
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
}

.project-list-item {
  cursor: pointer;
}

.project-path-mono {
  font-family: var(--pix-font-mono);
  font-size: var(--pix-text-xs);
  color: var(--pix-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 200px;
}

.home-empty {
  text-align: center;
  padding: var(--pix-space-xl) 0;
}

.empty-text {
  color: var(--pix-text-muted);
  font-size: var(--pix-text-sm);
}

.home-footer {
  text-align: center;
  margin-top: var(--pix-space-2xl);
}

.footer-link {
  color: var(--pix-text-muted);
  font-size: var(--pix-text-sm);
}

.footer-link:hover {
  color: var(--pix-text-secondary);
}
</style>
