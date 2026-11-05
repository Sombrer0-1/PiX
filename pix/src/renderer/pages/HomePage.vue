<script setup lang="ts">
/**
 * Home Page
 */
import { ref, onMounted, computed, watch } from "vue";
import { useRouter } from "vue-router";
import { useSettingsStore } from "../stores/settings-store";
import { useProjectStore } from "../stores/project-store";
import { useSessionStore, useTeamLeaderSessionStore } from "../stores/session-store";
import { useRpc } from "../composables/useRpc";
import { useTeamStore } from "../stores/team-store";
import ProjectOpenDialog from "../components/project/ProjectOpenDialog.vue";
import WindowTitlebar from "../components/layout/WindowTitlebar.vue";
import { toPlain } from "../utils/plain";
import { formatRelativeDay } from "../utils/relative-day";
import { DESKTOP_API_UNAVAILABLE, isDesktopApiAvailable, mapDesktopApiError } from "../utils/desktop-api";
import type {
  ProjectEnvironment,
  ProjectInfo,
  ProjectLocation,
  ProjectLocationInput,
} from "@/types/session";

const router = useRouter();
const settingsStore = useSettingsStore();
const projectStore = useProjectStore();
const sessionStore = useSessionStore();
const teamLeaderSessionStore = useTeamLeaderSessionStore();
const teamStore = useTeamStore();
const rpc = useRpc();

const piDetection = ref<{ found: boolean; path: string; note?: string } | null>(null);
const piDetecting = ref(true);
const showOpenDialog = ref(false);
const opening = ref(false);
const openError = ref<string | null>(null);
const bootError = ref<string | null>(null);

/** 旧快照提示状态（AC-13）：一次确认即 ack，并与本次会话的记名表对齐。 */
const showLegacyDialog = ref(false);
const legacyNoticeLocation = ref<ProjectLocation | null>(null);
/** 同一会话内的快速缓存；权威判定在主进程（ack.json，见 shouldPromptLegacyNotice）。 */
const legacyNoticeAcked = new Set<string>();

/** 旧快照 ack 是工作区级的，键与最近项目行一致（环境 + 物理路径）。 */
function workspaceKey(location: ProjectLocation): string {
  return `${location.environment.kind}:${location.physicalPath}`;
}

/**
 * 「这个工作区要不要弹旧快照提示」完全依赖 IPC：`has-legacy-team-snapshot` 会读
 * 工作区级 ack.json，确认过之后直接回 false（重启/换会话都算数）。本地 Set 只是
 * 同一会话的快速缓存——ack 写盘与下一次探针之间总有窗口，缓存挡住重复弹框。
 */
async function shouldPromptLegacyNotice(target: ProjectLocation): Promise<boolean> {
  if (!(await window.pixApi.hasLegacyTeamSnapshot(target))) return false;
  return !legacyNoticeAcked.has(workspaceKey(target));
}

onMounted(async () => {
  bootError.value = null;
  piDetecting.value = true;
  try {
    await projectStore.loadSettings();
    await settingsStore.load();
  } catch (err) {
    bootError.value = mapDesktopApiError(err, "应用启动失败，请从 PiX 桌面端打开");
  }
  // Probe WSL distros so the open-project dialog can offer them; failures land
  // in wslDiagnostic and only disable the WSL option, never the Windows path.
  void settingsStore.loadWslDistros();
  try {
    piDetection.value = await settingsStore.detectPi();
  } catch {
    piDetection.value = { found: true, path: "direct", note: "AgentSession 进程内直连" };
  } finally {
    piDetecting.value = false;
  }
});

const recentProjects = computed(() => projectStore.recentProjects);

// Global WSL defaults seed the dialog's initial environment/cwd. The persisted
// per-project environment remains authoritative when reopening a recent project.
const defaultEnvironment = computed<ProjectEnvironment>(() => {
  const wsl = settingsStore.wslSettings;
  if (
    wsl.enabled &&
    !!wsl.distro &&
    settingsStore.wslDistros.some((d) => d.name === wsl.distro)
  ) {
    return { kind: "wsl", distro: wsl.distro };
  }
  return { kind: "windows" };
});

const defaultCwd = computed(() => settingsStore.wslSettings.defaultCwd || "/home");

async function finishSoloStartup(location: ProjectLocation): Promise<void> {
  await projectStore.openProject(location);
  const result = await rpc.newSession();
  if (!result || result.cancelled) {
    alert(`新建会话失败：${rpc.lastError.value || "未知错误"}`);
    return;
  }
  sessionStore.clearSession();
  // newSession ran after openProject's list, so the list does not yet contain
  // the new file. Refresh before syncCurrentSession so the current-session
  // highlight is set on the jump; workspace mount's syncWorkspaceState will
  // list again (S1 cache makes the second scan cheap).
  await projectStore.listSessions();
  projectStore.syncCurrentSession(
    rpc.sessionState.value?.sessionFile,
    rpc.sessionState.value?.sessionId,
  );
  await router.push("/workspace");
}

async function startFreshWorkspace(location: ProjectLocation): Promise<void> {
  if (opening.value) return;
  opening.value = true;
  openError.value = null;
  try {
    await startFreshWorkspaceInner(location);
  } finally {
    opening.value = false;
  }
}

async function startFreshWorkspaceInner(location: ProjectLocation): Promise<void> {
  // Store objects (recent projects, current project) are Vue reactive proxies;
  // strip reactivity before they cross the contextBridge/IPC boundary.
  const target = toPlain(location);
  // Determine the target mode from persisted state BEFORE touching runtimes,
  // so a fire-and-forget setWorkspaceMode from a prior toggle cannot leave a
  // stale mode.json read here. Snapshot/mode keys use physicalPath on the main
  // process side; here we only pass the full location object.
  const hasTeamSnapshot = await window.pixApi.hasTeamSnapshot(target);
  const lastMode = await window.pixApi.getWorkspaceMode(target);
  const targetTeam = lastMode === "team" && hasTeamSnapshot;

  // AC-13 / H14：旧 team.json 永远不是可恢复的场（has-team-snapshot 只认
  // roundtables/<sha1>/current.json），但也不能静默丢掉——仅旧快照存在时提示
  // 一次，确认后才继续打开工作区。
  if (!targetTeam) {
    if (await shouldPromptLegacyNotice(target)) {
      legacyNoticeLocation.value = target;
      showLegacyDialog.value = true;
      return;
    }
  }

  await launchWorkspace(target, targetTeam);
}

/** 打开工作区：按已决定的前台模式启动运行时并进入 workspace。 */
async function launchWorkspace(target: ProjectLocation, targetTeam: boolean): Promise<void> {
  const sameProject = projectStore.isCurrentProject(target);

  if (targetTeam) {
    // Only (re)start the team when we are not already in team mode for this
    // same project: a stop+restart would discard in-flight seat work for no
    // reason. A different project still gets a fresh team via the toggle.
    const needsTeamStart = !teamStore.teamMode || !sameProject;
    if (needsTeamStart) {
      const started = await teamStore.toggleTeamMode(target);
      if (!started) {
        alert(`Pi 启动失败：${teamStore.lastError || "未知错误"}`);
        return;
      }
    }
    await projectStore.openProject(target, { loadSessions: false });
    if (needsTeamStart) {
      teamLeaderSessionStore.clearSession();
    }
    await router.push("/workspace");
    return;
  }

  // Solo target. If a team is active, toggle to solo (which starts the solo
  // runtime) and skip rpc.startPi below so the solo runtime is not started
  // twice on the same singleton.
  if (teamStore.teamMode) {
    const switched = await teamStore.toggleTeamMode(target);
    if (!switched) {
      alert(`Pi 启动失败：${teamStore.lastError || "未知错误"}`);
      return;
    }
    await finishSoloStartup(target);
    return;
  }

  // Already solo: start the solo runtime directly, then open the project.
  if (!(await rpc.startPi(target))) {
    alert(`Pi 启动失败：${rpc.lastError.value || "未知错误"}`);
    return;
  }
  await finishSoloStartup(target);
}

/** 旧快照提示只确认一次：ack 落盘（团队路径不会再提示）+ 本次会话记名。 */
async function confirmLegacyNotice(): Promise<void> {
  const target = legacyNoticeLocation.value;
  showLegacyDialog.value = false;
  legacyNoticeLocation.value = null;
  if (!target) return;
  legacyNoticeAcked.add(workspaceKey(target));
  await window.pixApi.ackLegacyTeamSnapshot(target);
  if (opening.value) return;
  opening.value = true;
  try {
    await launchWorkspace(target, false);
  } finally {
    opening.value = false;
  }
}


/** Open the project picker dialog (Windows folder browse or WSL distro + cwd). */
function openProject(): void {
  openError.value = null;
  showOpenDialog.value = true;
}

watch(showOpenDialog, (visible) => {
  if (!visible) openError.value = null;
});

/** Resolve the dialog's ProjectLocationInput via the main process and launch. */
async function handleOpenLocation(input: ProjectLocationInput): Promise<void> {
  if (opening.value) return;
  opening.value = true;
  openError.value = null;
  try {
    if (!isDesktopApiAvailable()) {
      openError.value = DESKTOP_API_UNAVAILABLE;
      return;
    }
    const result = await window.pixApi.resolveProjectLocation(input);
    if (!result.success) {
      // Keep the dialog open with the typed path; surface a readable error.
      openError.value = mapDesktopApiError(result.error || "无法解析项目路径");
      return;
    }
    showOpenDialog.value = false;
    await startFreshWorkspaceInner(result.location);
  } catch (err) {
    openError.value = mapDesktopApiError(err);
  } finally {
    opening.value = false;
  }
}

async function openRecentProject(project: ProjectInfo): Promise<void> {
  await startFreshWorkspace(project);
}

async function removeRecentProject(project: ProjectInfo): Promise<void> {
  await projectStore.removeRecentProject(project);
}

function envLabel(project: ProjectInfo): string {
  return project.environment.kind === "wsl" ? `WSL2 · ${project.environment.distro}` : "Windows";
}

function formatDate(timestamp: number): string {
  return formatRelativeDay(timestamp);
}

const piStatusLabel = computed(() => {
  if (piDetecting.value) return "正在检测 Pi…";
  if (piDetection.value?.found) return "Pi 就绪";
  return "Pi 未检测到";
});
</script>

<template>
  <div class="home-page">
    <WindowTitlebar />
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
          <div class="pi-status-row" role="status">
            <span class="pi-status-dot" :class="{ ready: !!piDetection?.found, detecting: piDetecting }"></span>
            <span>{{ piStatusLabel }}</span>
          </div>

          <p v-if="bootError" class="home-error" role="alert">加载失败：{{ bootError }}</p>
          <p v-if="opening" class="home-opening" role="status">正在打开项目…</p>

          <div class="home-actions">
            <v-btn
              class="open-project-btn"
              variant="flat"
              color="primary"
              size="large"
              block
              prepend-icon="mdi-folder-open-outline"
              :loading="opening"
              :disabled="opening || piDetecting"
              @click="openProject"
            >
              打开项目文件夹
            </v-btn>
          </div>
        </div>

        <section v-if="recentProjects.length > 0" class="home-section">
          <h2 class="section-title">最近项目</h2>
          <v-card class="recent-card" variant="flat">
          <v-list density="default" bg-color="transparent" class="recent-list">
            <v-list-item
              v-for="project in recentProjects"
              :key="`${project.environment.kind}:${project.physicalPath}`"
              :aria-label="`打开项目 ${project.name}`"
              :disabled="opening"
              class="project-list-item"
              @click="openRecentProject(project)"
            >
              <template #default>
                <div class="project-open-title">{{ project.name }}</div>
                <div class="project-meta">
                  <span class="project-open-subtitle">{{ formatDate(project.lastOpened) }}</span>
                  <span class="project-env" :class="{ 'env-wsl': project.environment.kind === 'wsl' }" :title="envLabel(project)">{{ envLabel(project) }}</span>
                </div>
                <div class="project-path-mono" :title="project.path">{{ project.path }}</div>
              </template>
              <template #append>
                <button
                  class="project-delete-btn"
                  type="button"
                  title="从最近列表移除（不会删除磁盘上的文件）"
                  aria-label="从最近列表移除，不会删除文件"
                  :disabled="opening"
                  @click.stop="removeRecentProject(project)"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <polyline points="3 6 5 6 21 6" />
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                    <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                  </svg>
                </button>
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

    <ProjectOpenDialog
      v-model="showOpenDialog"
      :default-environment="defaultEnvironment"
      :default-cwd="defaultCwd"
      :distros="settingsStore.wslDistros"
      :distros-loading="!settingsStore.wslDistrosLoaded"
      :wsl-diagnostic="settingsStore.wslDiagnostic ?? undefined"
      :submitting="opening"
      :error="openError"
      @open="handleOpenLocation"
    />

    <!-- 旧团队快照提示（AC-13 / H14）：只提示一次，确认后才打开工作区。 -->
    <v-dialog v-model="showLegacyDialog" max-width="440" persistent>
      <v-card class="legacy-dialog-card" data-test="legacy-snapshot-dialog">
        <div class="legacy-dialog-title">检测到旧版团队快照</div>
        <div class="legacy-dialog-text">
          这个工作区只有旧版 <code>team.json</code>：它不在可恢复列表里，圆桌讨论需要重新开始（旧文件保留，不会被删除）。将以单人模式打开项目。
        </div>
        <v-card-actions class="legacy-dialog-actions">
          <v-spacer />
          <v-btn color="primary" variant="tonal" @click="confirmLegacyNotice">知道了</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
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

.pi-status-dot.detecting {
  background: var(--pix-accent);
  animation: pix-pulse 1.1s ease-in-out infinite;
}

@keyframes pix-pulse {
  0%, 100% { opacity: 0.35; }
  50% { opacity: 1; }
}

.home-error,
.home-opening {
  margin: 0 0 var(--pix-space-md);
  font-size: var(--pix-text-sm);
  line-height: var(--pix-leading-base);
}

.home-error {
  color: var(--pix-error);
}

.home-opening {
  color: var(--pix-text-secondary);
}

.recent-list {
  max-height: min(42vh, 360px);
  overflow-y: auto;
}

.project-open-btn {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  min-width: 0;
  max-width: 220px;
  padding: 4px 2px;
  text-align: left;
  border-radius: var(--pix-radius-sm);
}

.project-open-btn:focus-visible {
  outline: 2px solid var(--pix-border-focus);
  outline-offset: 2px;
}

.project-open-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.project-open-title {
  color: var(--pix-text-primary);
  font-size: var(--pix-text-md);
  font-weight: var(--pix-weight-medium);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}

.project-open-subtitle {
  color: var(--pix-text-muted);
  font-size: var(--pix-text-xs);
}

.project-delete-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.project-delete-btn:focus-visible {
  outline: 2px solid var(--pix-border-focus);
  outline-offset: 2px;
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
  grid-template-columns: max-content minmax(0, 1fr) max-content;
  cursor: pointer;
  border-radius: var(--pix-radius-md);
  margin: 4px 6px;
  min-height: 58px;
  transition: background var(--pix-transition-fast);
}

.project-list-item:hover {
  background: var(--pix-bg-hover);
}

.project-meta {
  display: flex;
  align-items: center;
  gap: var(--pix-space-xs);
  min-width: 0;
  margin: 2px 0;
}

.project-meta .project-open-subtitle {
  flex-shrink: 0;
}

.project-path-mono {
  display: block;
  font-family: var(--pix-font-mono);
  font-size: var(--pix-text-xs);
  color: var(--pix-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}

.project-env {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--pix-text-xs);
  font-family: var(--pix-font-mono);
  color: var(--pix-text-muted);
  padding: 1px 6px;
  border-radius: var(--pix-radius-sm);
  background: var(--pix-bg-hover);
}

.project-env.env-wsl {
  color: var(--pix-text-inverse);
  background: linear-gradient(135deg, #7567f5 0%, #5142df 100%);
}

.project-delete-btn {
  display: inline-flex;
  flex-shrink: 0;
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

/* 旧快照提示：白玻璃、克制深度、安静蓝反馈。 */
.legacy-dialog-card {
  padding: var(--pix-space-lg);
  border-radius: var(--pix-radius-xl);
}

.legacy-dialog-title {
  color: var(--pix-text-primary);
  font-size: var(--pix-text-lg);
  font-weight: var(--pix-weight-semibold);
  line-height: 1.35;
  margin-bottom: var(--pix-space-md);
}

.legacy-dialog-text {
  color: var(--pix-text-secondary);
  font-size: var(--pix-text-sm);
  line-height: var(--pix-leading-base);
  word-break: break-word;
}

.legacy-dialog-text code {
  padding: 1px 5px;
  border-radius: var(--pix-radius-sm);
  background: var(--pix-bg-code);
  color: var(--pix-text-primary);
  font-family: var(--pix-font-mono);
  font-size: var(--pix-text-xs);
}

.legacy-dialog-actions {
  padding: var(--pix-space-lg) 0 0;
}
</style>
