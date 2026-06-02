<script setup lang="ts">
/**
 * Home Page
 *
 * Landing page showing recent projects, pi status, and getting started.
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
  console.log("[HomePage] openProject() called");
  console.log("[HomePage] window.pixApi exists:", !!window.pixApi);
  console.log("[HomePage] typeof pixApi.selectProject:", typeof window.pixApi?.selectProject);
  const dirPath = await window.pixApi.selectProject();
  console.log("[HomePage] selectProject returned:", dirPath);
  if (!dirPath) return;

  console.log("[HomePage] calling rpc.startPi with:", dirPath);
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
  if (diff < 86400000) return "Today";
  if (diff < 172800000) return "Yesterday";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
</script>

<template>
  <div class="home-page">
    <div class="home-container">
      <!-- Header -->
      <header class="home-header">
        <h1 class="home-title">PiX</h1>
        <p class="home-subtitle">Desktop interface for Pi AI coding agent</p>
      </header>

      <!-- Pi Status -->
      <div class="pi-status" :class="{ 'pi-found': piDetection?.found, 'pi-not-found': !piDetection?.found }">
        <div class="pi-status-indicator">
          <span class="pi-status-dot"></span>
          <span v-if="piDetection?.found">Pi detected</span>
          <span v-else>Pi not detected</span>
        </div>
        <span class="pi-status-path">{{ piDetection?.path || 'Not configured' }}</span>
        <button class="btn btn-sm" @click="router.push('/settings')">Configure</button>
      </div>

      <!-- Quick Actions -->
      <div class="home-actions">
        <button class="btn btn-primary btn-lg" @click="openProject">
          <span class="btn-icon">+</span>
          Open Project
        </button>
      </div>

      <!-- Recent Projects -->
      <section v-if="recentProjects.length > 0" class="home-section">
        <h2 class="section-title">Recent Projects</h2>
        <div class="project-grid">
          <button
            v-for="project in recentProjects"
            :key="project.path"
            class="project-card"
            @click="openRecentProject(project)"
          >
            <div class="project-card-icon" aria-hidden="true"></div>
            <div class="project-card-info">
              <div class="project-card-name">{{ project.name }}</div>
              <div class="project-card-meta">
                <span class="project-card-path">{{ project.path }}</span>
                <span class="project-card-separator">|</span>
                <span>{{ formatDate(project.lastOpened) }}</span>
              </div>
            </div>
          </button>
        </div>
      </section>

      <!-- Empty State -->
      <section v-else class="home-section home-empty">
        <p class="empty-text">No recent projects.</p>
        <p class="empty-hint">Open a project directory to get started with Pi.</p>
      </section>

      <!-- Footer -->
      <footer class="home-footer">
        <router-link to="/settings" class="footer-link">Settings</router-link>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.home-page {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--pix-bg-app);
}

.home-container {
  width: 100%;
  max-width: 560px;
  padding: var(--pix-space-2xl);
}

.home-header {
  text-align: center;
  margin-bottom: var(--pix-space-2xl);
}

.home-title {
  font-size: 32px;
  font-weight: 600;
  color: var(--pix-text-primary);
  letter-spacing: -0.5px;
}

.home-subtitle {
  margin-top: var(--pix-space-sm);
  color: var(--pix-text-secondary);
  font-size: var(--pix-text-md);
}

/* Pi Status */
.pi-status {
  display: flex;
  align-items: center;
  gap: var(--pix-space-md);
  padding: var(--pix-space-md) var(--pix-space-lg);
  border-radius: var(--pix-radius-md);
  font-size: var(--pix-text-sm);
  margin-bottom: var(--pix-space-xl);
}

.pi-found {
  background: var(--pix-success-bg);
  border: 1px solid #d0e5d8;
}

.pi-not-found {
  background: var(--pix-warning-bg);
  border: 1px solid #ede0c0;
}

.pi-status-indicator {
  display: flex;
  align-items: center;
  gap: var(--pix-space-sm);
  font-weight: 500;
}

.pi-status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.pi-found .pi-status-dot {
  background: var(--pix-success);
}

.pi-not-found .pi-status-dot {
  background: var(--pix-warning);
}

.pi-status-path {
  flex: 1;
  color: var(--pix-text-muted);
  font-family: var(--pix-font-mono);
  font-size: var(--pix-text-xs);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Actions */
.home-actions {
  display: flex;
  justify-content: center;
  margin-bottom: var(--pix-space-2xl);
}

.btn {
  display: inline-flex;
  align-items: center;
  gap: var(--pix-space-sm);
  padding: var(--pix-space-sm) var(--pix-space-lg);
  border-radius: var(--pix-radius-md);
  font-size: var(--pix-text-md);
  font-weight: 500;
  transition: all var(--pix-transition-fast);
}

.btn-sm {
  padding: var(--pix-space-xs) var(--pix-space-md);
  font-size: var(--pix-text-sm);
  border: 1px solid var(--pix-border);
  border-radius: var(--pix-radius-sm);
}

.btn-sm:hover {
  background: var(--pix-bg-hover);
}

.btn-primary {
  background: var(--pix-accent);
  color: var(--pix-text-inverse);
}

.btn-primary:hover {
  opacity: 0.9;
}

.btn-lg {
  padding: var(--pix-space-md) var(--pix-space-xl);
  font-size: var(--pix-text-md);
}

.btn-icon {
  font-size: var(--pix-text-lg);
  font-weight: 300;
}

/* Sections */
.home-section {
  margin-bottom: var(--pix-space-xl);
}

.section-title {
  font-size: var(--pix-text-sm);
  font-weight: 600;
  color: var(--pix-text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: var(--pix-space-md);
}

/* Project Grid */
.project-grid {
  display: flex;
  flex-direction: column;
  gap: var(--pix-space-sm);
}

.project-card {
  display: flex;
  align-items: center;
  gap: var(--pix-space-md);
  padding: var(--pix-space-md) var(--pix-space-lg);
  background: var(--pix-bg-content);
  border: 1px solid var(--pix-border-light);
  border-radius: var(--pix-radius-md);
  text-align: left;
  width: 100%;
  transition: all var(--pix-transition-fast);
}

.project-card:hover {
  border-color: var(--pix-border-focus);
  box-shadow: var(--pix-shadow-sm);
}

.project-card-icon {
  position: relative;
  width: 24px;
  height: 17px;
  border: 1px solid var(--pix-border);
  border-radius: 3px;
  background: var(--pix-bg-code);
  flex-shrink: 0;
}

.project-card-icon::before {
  content: "";
  position: absolute;
  top: -5px;
  left: 2px;
  width: 10px;
  height: 5px;
  border: 1px solid var(--pix-border);
  border-bottom: 0;
  border-radius: 3px 3px 0 0;
  background: var(--pix-bg-code);
}

.project-card-info {
  flex: 1;
  min-width: 0;
}

.project-card-name {
  font-weight: 500;
  color: var(--pix-text-primary);
}

.project-card-meta {
  display: flex;
  align-items: center;
  gap: var(--pix-space-sm);
  margin-top: 2px;
  font-size: var(--pix-text-xs);
  color: var(--pix-text-muted);
}

.project-card-path {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 300px;
  font-family: var(--pix-font-mono);
}

.project-card-separator {
  color: var(--pix-border);
}

/* Empty */
.home-empty {
  text-align: center;
  padding: var(--pix-space-2xl) 0;
}

.empty-text {
  color: var(--pix-text-secondary);
  font-size: var(--pix-text-md);
}

.empty-hint {
  color: var(--pix-text-muted);
  font-size: var(--pix-text-sm);
  margin-top: var(--pix-space-xs);
}

/* Footer */
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
