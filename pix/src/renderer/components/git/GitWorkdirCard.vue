<script setup lang="ts">
/**
 * GitWorkdirCard - Git 工作区卡片（PiX 1.5, SDD §4.3.7）。
 *
 * 右面板常驻卡（solo/team 双分支共用，替换原「会话信息」卡）：展示当前
 * 项目所在仓库的分支/upstream/统计/文件列表，提供刷新与在文件夹中打开。
 * 触发接线（架构决策，逐条）：mount → notifyTrigger；项目身份
 * （physicalPath）或会话（sessionId）切换 → notifyTrigger；isStreaming
 * 下降沿（当前视图 agent 一轮结束）→ notifyTrigger；窗口恢复可见 →
 * notifyTrigger。RightPanel 常驻、mount 仅一次，故切换必须用 watch。
 */
import { computed, onMounted, onUnmounted, watch } from "vue";
import { useWorkspaceRpc } from "../../composables/useWorkspaceRpc";
import { useProjectStore } from "../../stores/project-store";
import { useGitStatus } from "../../composables/useGitStatus";
import type { GitChangedFile } from "@shared/types";

const rpc = useWorkspaceRpc();
const projectStore = useProjectStore();
const git = useGitStatus();

// ---- 触发接线（SDD §4.3.6，逐条）----
function onVisibilityChange(): void {
  if (document.visibilityState === "visible") git.notifyTrigger();
}
onMounted(() => {
  git.notifyTrigger();
  document.addEventListener("visibilitychange", onVisibilityChange);
});
onUnmounted(() => document.removeEventListener("visibilitychange", onVisibilityChange));
watch(() => projectStore.currentProject?.physicalPath, () => git.notifyTrigger());
watch(() => rpc.sessionState.value?.sessionId, () => git.notifyTrigger());
watch(
  () => rpc.isStreaming.value,
  (cur, prev) => {
    if (prev && !cur) git.notifyTrigger();
  },
);

const snapshot = git.snapshot;

/** not-repository / 无数据 → 整卡不渲染（右面板无空位）。 */
const visible = computed(
  () =>
    snapshot.value?.kind === "repository" ||
    (snapshot.value?.kind === "unavailable" && !git.stale.value),
);

/** 首次失败错误文案（不透传 git stderr / 绝对路径）。 */
const errorText = computed(() => {
  switch (snapshot.value?.errorCode) {
    case "git_not_found":
      return "未检测到可用的 Git";
    case "timeout":
      return "Git 状态获取超时";
    case "execution_failed":
    case "invalid_location":
      return "Git 状态获取失败";
    default:
      return "Git 状态获取失败";
  }
});

// ---- 顶行：{仓库名} · HEAD 段 · upstream 段 · 更新于 HH:mm（零宽段省略）----
function formatTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

const topSegments = computed(() => {
  const s = snapshot.value;
  if (!s) return [];
  const segs: string[] = [];
  if (s.repositoryName) {
    segs.push(`${s.repositoryName}${s.scopedToProject ? "（仅限项目目录）" : ""}`);
  }
  if (s.branch) {
    segs.push(s.branch);
  } else if (s.detachedHeadOid) {
    segs.push(`HEAD 于 ${s.detachedHeadOid}`);
  } else if (s.emptyRepo) {
    segs.push("(空仓库)");
  }
  if (s.upstream) {
    segs.push(s.upstream.ref);
    if (s.upstream.ahead > 0) segs.push(`ahead ${s.upstream.ahead}`);
    if (s.upstream.behind > 0) segs.push(`behind ${s.upstream.behind}`);
  }
  segs.push(`更新于 ${formatTime(s.observedAt)}`);
  return segs;
});

// ---- 统计行：零值项不显示；complete=false 时整行替换为截断说明 ----
const incomplete = computed(() => snapshot.value?.complete === false);
const counts = computed(() => snapshot.value?.counts);
const statsSegments = computed(() => {
  const c = counts.value;
  if (!c) return [];
  const segs: string[] = [];
  if (c.staged > 0) segs.push(`已暂存 ${c.staged}`);
  if (c.unstaged > 0) segs.push(`未暂存 ${c.unstaged}`);
  if (c.untracked > 0) segs.push(`未跟踪 ${c.untracked}`);
  if (c.conflicts > 0) segs.push(`冲突 ${c.conflicts}`);
  if (c.additions > 0 || c.deletions > 0) segs.push(`+${c.additions}/-${c.deletions}`);
  return segs;
});

// ---- 文件列表：服务端已排序，只切片 ----
const MAX_FILES = 100;
const files = computed(() => snapshot.value?.files ?? []);
const visibleFiles = computed(() => files.value.slice(0, MAX_FILES));
const truncated = computed(() => files.value.length > MAX_FILES);
const cleanWorkdir = computed(() => files.value.length === 0 && !incomplete.value);

/** 中间截断路径（title 全路径 tooltip）。 */
function middleTruncate(path: string, maxLen = 40): string {
  if (path.length <= maxLen) return path;
  const head = Math.ceil(maxLen * 0.45);
  const tail = maxLen - head - 1;
  return `${path.slice(0, head)}…${path.slice(-tail)}`;
}

/** 状态章：冲突 > 未跟踪 > 已暂存/未暂存（双章并列）> 已删除/重命名（附加）。 */
interface GitChip {
  label: string;
  cls: string;
}
function fileChips(file: GitChangedFile): GitChip[] {
  const chips: GitChip[] = [];
  if (file.conflict) chips.push({ label: "冲突", cls: "conflict" });
  if (file.untracked) chips.push({ label: "未跟踪", cls: "untracked" });
  if (file.staged) chips.push({ label: "已暂存", cls: "staged" });
  if (file.unstaged) chips.push({ label: "未暂存", cls: "unstaged" });
  if (file.deleted) chips.push({ label: "已删除", cls: "deleted" });
  if (file.renamed) chips.push({ label: "重命名", cls: "renamed" });
  return chips;
}

/** 右对齐 +N/-M（null → —）。 */
function diffText(file: GitChangedFile): string {
  if (file.additions == null || file.deletions == null) return "—";
  return `+${file.additions}/-${file.deletions}`;
}
</script>

<template>
  <div v-if="visible" class="info-card git-card">
    <div class="card-title-row">
      <span class="card-title">
        Git 工作区
        <span
          v-if="git.stale.value"
          class="git-stale-badge"
          title="Git 状态获取失败，显示上次数据"
          >数据异常</span
        >
      </span>
      <div class="git-actions">
        <button
          class="card-action-btn"
          :class="{ spinning: git.loading.value }"
          :disabled="git.loading.value"
          title="刷新"
          aria-label="刷新 Git 状态"
          @click="git.refresh"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
        </button>
        <button
          class="card-action-btn"
          title="在文件夹中打开"
          aria-label="在文件夹中打开"
          @click="git.openFolder"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
        </button>
      </div>
    </div>

    <!-- 首次失败错误卡（无旧数据）：错误文案 + 重试 -->
    <template v-if="snapshot?.kind === 'unavailable'">
      <div class="git-error-text">{{ errorText }}</div>
      <button class="git-retry-btn" type="button" @click="git.refresh">重试</button>
    </template>

    <!-- 常态 / stale（保留旧数据 + 数据异常标记） -->
    <template v-else>
      <div class="git-top-line">{{ topSegments.join(" · ") }}</div>
      <div v-if="incomplete" class="git-incomplete">状态数据过大，结果不完整</div>
      <div v-else-if="cleanWorkdir" class="git-clean">工作区干净</div>
      <div v-else-if="statsSegments.length > 0" class="git-stats">
        {{ statsSegments.join(" · ") }}
      </div>

      <div v-if="visibleFiles.length > 0" class="git-file-list">
        <div
          v-for="file in visibleFiles"
          :key="`${file.path}${file.origPath ?? ''}`"
          class="git-file-row"
        >
          <span class="git-file-path" :title="file.path">{{ middleTruncate(file.path) }}</span>
          <span class="git-file-chips">
            <span v-for="chip in fileChips(file)" :key="chip.label" class="git-chip" :class="chip.cls">{{ chip.label }}</span>
          </span>
          <span class="git-file-diff">{{ diffText(file) }}</span>
        </div>
        <div v-if="truncated" class="git-more">
          仅显示前 100 项，共 {{ incomplete ? "100+" : files.length }} 项
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
/* 卡片壳/标题/操作按钮沿用 RightPanel 的 .info-card / .card-title /
   .card-action-btn 语言（组件内复制语义，不改 RightPanel 既有样式类）。 */
.info-card {
  background: rgba(255, 255, 255, 0.92);
  border: 1px solid var(--pix-border-light);
  border-radius: var(--pix-radius-xl);
  padding: var(--pix-space-lg);
  box-shadow: var(--pix-shadow-xs);
  transition:
    border-color var(--pix-transition-fast),
    box-shadow var(--pix-transition-fast);
}

.info-card:hover {
  border-color: #dfe2f0;
  box-shadow: var(--pix-shadow-sm);
}

.card-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--pix-text-sm);
  font-weight: var(--pix-weight-semibold);
  color: var(--pix-text-primary);
  text-transform: none;
  letter-spacing: 0;
  margin-bottom: var(--pix-space-md);
}

.card-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--pix-space-md);
}

.git-actions {
  display: flex;
  align-items: center;
  gap: 2px;
}

.card-action-btn {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--pix-radius-md);
  color: var(--pix-text-secondary);
  cursor: pointer;
  transition: color var(--pix-transition-fast), background var(--pix-transition-fast);
}

.card-action-btn:hover {
  color: var(--pix-text-primary);
  background: var(--pix-accent-light);
}

.card-action-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.card-action-btn:disabled:hover {
  background: transparent;
}

.card-action-btn.spinning svg {
  animation: pix-spin 0.8s linear infinite;
}

@keyframes pix-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

/* ── 顶行 / 统计行 ── */
.git-top-line,
.git-stats,
.git-clean,
.git-incomplete {
  font-size: var(--pix-text-xs);
  line-height: var(--pix-leading-base);
  margin-bottom: var(--pix-space-sm);
}

.git-top-line {
  color: var(--pix-text-primary);
  font-weight: var(--pix-weight-medium);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.git-stats {
  color: var(--pix-text-secondary);
}

.git-clean {
  color: var(--pix-success);
}

.git-incomplete {
  color: var(--pix-warning);
}

.git-stale-badge {
  display: inline-flex;
  align-items: center;
  padding: 1px 8px;
  border-radius: 10px;
  font-size: 10px;
  font-weight: var(--pix-weight-medium);
  color: var(--pix-warning);
  background: var(--pix-warning-bg);
  border: 1px solid var(--pix-warning-light);
}

/* ── 文件列表：固定高度滚动 ── */
.git-file-list {
  max-height: 280px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.git-file-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 24px;
  padding: 2px 0;
  font-size: 11px;
}

.git-file-path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--pix-font-mono);
  color: var(--pix-text-primary);
}

.git-file-chips {
  display: flex;
  align-items: center;
  gap: 3px;
  flex-shrink: 0;
}

.git-chip {
  display: inline-flex;
  align-items: center;
  padding: 0 6px;
  height: 16px;
  border-radius: 8px;
  font-size: 10px;
  font-weight: var(--pix-weight-medium);
  white-space: nowrap;
}

.git-chip.conflict {
  color: var(--pix-error);
  background: var(--pix-error-bg);
}

.git-chip.untracked {
  color: var(--pix-warning);
  background: var(--pix-warning-bg);
}

.git-chip.staged {
  color: var(--pix-success);
  background: rgba(22, 163, 74, 0.1);
}

.git-chip.unstaged {
  color: var(--pix-text-secondary);
  background: var(--pix-bg-hover);
}

.git-chip.deleted,
.git-chip.renamed {
  color: var(--pix-text-muted);
  background: transparent;
  border: 1px solid var(--pix-border-light);
}

.git-file-diff {
  flex-shrink: 0;
  min-width: 52px;
  text-align: right;
  font-family: var(--pix-font-mono);
  font-variant-numeric: tabular-nums;
  color: var(--pix-text-secondary);
}

.git-more {
  padding: 4px 0 2px;
  font-size: 10px;
  color: var(--pix-text-muted);
  text-align: center;
}

/* ── 首次失败错误卡 ── */
.git-error-text {
  font-size: var(--pix-text-sm);
  color: var(--pix-error);
  line-height: var(--pix-leading-base);
  margin-bottom: var(--pix-space-sm);
}

.git-retry-btn {
  display: inline-flex;
  align-items: center;
  padding: 3px 14px;
  border-radius: var(--pix-radius-md);
  border: 1px solid var(--pix-error-light);
  background: var(--pix-error-bg);
  color: var(--pix-error);
  font-size: var(--pix-text-xs);
  font-weight: var(--pix-weight-medium);
  cursor: pointer;
  transition: background var(--pix-transition-fast);
}

.git-retry-btn:hover {
  background: var(--pix-error-light);
}
</style>
