/**
 * useGitStatus - Git 工作区快照拉取状态机（PiX 1.5, SDD §4.3.6）。
 *
 * 组件级状态（卡片卸载即弃，无缓存层、无 watcher）：依赖
 * projectStore.currentProject，notifyTrigger 在 mount/项目或会话切换/
 * isStreaming 下降沿/窗口恢复可见时调用。generation 计数保证旧会话/旧项目
 * 的晚到结果整包丢弃；手动刷新 2s 合并（仅作用于 refresh 点击）。
 * 结果落地：快照绑定来源项目（snapshotProjectPath = fetch 时的
 * currentProject.physicalPath）；repository/not-repository 覆盖快照并清除
 * stale；unavailable 在持有「来源为当前项目」的 repository 快照时仅置
 * stale，否则（无快照、快照非 repository、或快照来自其它项目——跨项目
 * 切换后新项目采集失败时不残留旧项目快照）直接覆盖且 stale = false。
 * 失败（unavailable 或抛异常，且 generation 匹配）时重置手动刷新合并
 * 窗口：错误卡「重试」按钮（调 refresh）在失败后立即可用，合并窗口仅
 * 用于防成功请求连点。
 */
import { ref, type Ref } from "vue";
import { useProjectStore } from "../stores/project-store";
import { toPlain } from "../utils/plain";
import type { GitWorkdirSnapshot } from "@shared/types";

/** 手动刷新合并窗口（仅作用于 refresh 点击，notifyTrigger 不受限）。 */
const REFRESH_MERGE_WINDOW_MS = 2000;

export function useGitStatus(): {
  snapshot: Ref<GitWorkdirSnapshot | null>; // 最近一次成功或 not-repository 结果
  loading: Ref<boolean>;
  stale: Ref<boolean>; // 有快照但最近一次采集 unavailable
  /** 手动刷新（2s 内重复点击合并为一次）。 */
  refresh: () => void;
  openFolder: () => Promise<void>;
  /** 组件在 mount/项目或会话切换/isStreaming 下降沿/visibilitychange 时调用。 */
  notifyTrigger: () => void;
} {
  const projectStore = useProjectStore();
  const snapshot = ref<GitWorkdirSnapshot | null>(null);
  const loading = ref(false);
  const stale = ref(false);
  let generation = 0;
  let lastRefreshAt = -Infinity;
  /** 快照来源项目（fetch 时 currentProject.physicalPath），防止跨项目残留。 */
  let snapshotProjectPath: string | null = null;

  async function fetch(): Promise<void> {
    const project = projectStore.currentProject;
    if (!project) return;
    const gen = ++generation;
    loading.value = true;
    try {
      // currentProject 是 Vue reactive proxy，过 IPC 前先转 plain。
      const result = await window.pixApi.gitGetStatus(toPlain(project));
      if (gen !== generation) return; // 旧会话/旧项目晚到结果整包丢弃
      if (result.kind === "repository" || result.kind === "not-repository") {
        snapshot.value = result;
        snapshotProjectPath = project.physicalPath;
        stale.value = false;
      } else {
        // kind === "unavailable"
        if (
          snapshot.value?.kind === "repository" &&
          snapshotProjectPath === project.physicalPath
        ) {
          stale.value = true; // 同项目：保留上次快照，仅标 stale
        } else {
          // 无 repository 快照，或快照来自其它项目 → 直接覆盖，不保留 stale
          snapshot.value = result;
          snapshotProjectPath = project.physicalPath;
          stale.value = false;
        }
        // 失败后合并窗口失效：错误卡「重试」按钮立即可用（防成功请求连点除外）
        lastRefreshAt = -Infinity;
      }
    } catch (err) {
      console.warn("[useGitStatus] Failed to get git status:", err);
      if (gen === generation) lastRefreshAt = -Infinity; // 失败后合并窗口失效
    } finally {
      if (gen === generation) loading.value = false;
    }
  }

  function notifyTrigger(): void {
    void fetch();
  }

  function refresh(): void {
    const now = Date.now();
    if (now - lastRefreshAt < REFRESH_MERGE_WINDOW_MS) return;
    lastRefreshAt = now;
    void fetch();
  }

  async function openFolder(): Promise<void> {
    const project = projectStore.currentProject;
    if (!project) return;
    try {
      const result = await window.pixApi.gitOpenFolder(toPlain(project));
      if (!result.success) {
        console.warn("[useGitStatus] Open folder failed:", result.error);
      }
    } catch (err) {
      console.warn("[useGitStatus] Open folder failed:", err);
    }
  }

  return { snapshot, loading, stale, refresh, openFolder, notifyTrigger };
}
