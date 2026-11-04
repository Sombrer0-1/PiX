/**
 * Computer-use store
 *
 * Renderer mirror of the main-process ComputerUseService state. The store is
 * the single subscriber of the `computer-use-event` channel and the single
 * caller of `computer-use-command`; components never touch the preload API or
 * subscribe to events themselves (they read this store and call its actions).
 *
 * Event merging:
 * - `snapshot` events replace the mirror; they carry `install`, so a snapshot
 *   without an install clears an in-flight progress but keeps a terminal one
 *   (done/failed/cancelled) visible for the user.
 * - `install_progress` events are the fine-grained channel and win on arrival.
 * - `activity` events only apply to the mirrored (foreground) session; a
 *   session switch resets the retained activity so one session's summary can
 *   never be shown for another.
 *
 * `computeToggleState` is the closed mapping (rules top-down, first hit
 * wins); the canToggle / toggleDisabledReason / toggleWarning getters are thin
 * wrappers so button state, tooltip and settings copy stay in lockstep.
 */

import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { useComputerUseRpc, type ComputerUseTransport } from "../composables/useComputerUseRpc";
import {
  computerUseDegradedLabel,
  computerUsePermissionLabel,
  type ComputerGrantLevel,
  type ComputerUseActivity,
  type ComputerUseCommand,
  type ComputerUseEvent,
  type ComputerUseSnapshot,
  type InstallProgress,
} from "@shared/computer-use-types.js";

// ============================================================================
// Toggle availability (closed mapping)
// ============================================================================

interface ToggleState {
  canToggle: boolean;
  reason: string | null;
  warning: string | null;
}

/** 文案：缺少系统权限：<missingPermissions 中文>，请在设置中授权。 */
function permissionWarning(missing: string[] | undefined): string {
  if (!missing || missing.length === 0) return "缺少系统权限，请在设置中授权";
  return `缺少系统权限：${missing.map(computerUsePermissionLabel).join("、")}，请在设置中授权`;
}

/** degradedCapabilities 非空 → warning，否则 null。 */
function degradedWarning(capabilities: string[] | undefined): string | null {
  if (!capabilities || capabilities.length === 0) return null;
  return `能力受限：${capabilities.map(computerUseDegradedLabel).join("、")}`;
}

/**
 * Pure; input domain = the whole snapshot (or null before first fetch).
 * Rules evaluated top-down, first hit wins.
 */
export function computeToggleState(s: ComputerUseSnapshot | null): ToggleState {
  if (s === null) return { canToggle: false, reason: "正在连接…", warning: null };
  switch (s.availability) {
    case "disabled":
      return { canToggle: false, reason: "请先在 设置 › 电脑操控 中开启", warning: null };
    case "unsupported_platform":
      return { canToggle: false, reason: "当前平台不支持电脑操控", warning: null };
    case "installing":
      return { canToggle: false, reason: "操控驱动安装中…", warning: null };
    case "driver_missing":
      return { canToggle: false, reason: "未安装操控驱动，请在设置中安装", warning: null };
    case "driver_incompatible":
      return { canToggle: false, reason: "驱动版本不兼容，请在设置中重新安装", warning: null };
    case "failed":
      return { canToggle: false, reason: "驱动异常，请在设置中重试", warning: null };
  }
  // 输入框旁的开关只在有活动会话时渲染；session === null 实际对应
  // “会话创建时全局开关未开、controller 未挂载”，而非“没有会话”。
  if (s.session === null)
    return { canToggle: false, reason: "当前会话未挂载电脑操控，新建或切换会话后生效", warning: null };
  if (s.session.inactiveReason === "read_only_mode") {
    return { canToggle: false, reason: "只读模式下不可用", warning: null };
  }
  if (s.session.inactiveReason === "plan_mode") {
    return { canToggle: false, reason: "规划阶段不可用", warning: null };
  }
  if (s.availability === "permission_required") {
    return { canToggle: true, reason: null, warning: permissionWarning(s.missingPermissions) };
  }
  return { canToggle: true, reason: null, warning: degradedWarning(s.degradedCapabilities) };
}

// ============================================================================
// Store
// ============================================================================

/** 安装阶段的终态：快照不再携带 install 时保留展示，让用户看到结果/错误。 */
function isTerminalInstallPhase(phase: InstallProgress["phase"]): boolean {
  return phase === "done" || phase === "failed" || phase === "cancelled";
}

export const useComputerUseStore = defineStore("computer-use", () => {
  // ==========================================================================
  // State
  // ==========================================================================

  /** 主进程权威快照；null = 尚未收到（首次 get_snapshot 之前）。 */
  const snapshot = ref<ComputerUseSnapshot | null>(null);

  /** 托管驱动安装进度（事件流；快照 install 字段为准）。 */
  const installProgress = ref<InstallProgress | null>(null);

  /** 当前（前台）会话最近一次电脑操控活动；会话切换即清除。 */
  const lastActivity = ref<ComputerUseActivity | null>(null);

  /** 最近一次命令失败的原因（快照事件不清除）。 */
  const lastError = ref<string | null>(null);

  /** 事件订阅是否已建立（start/stop 的幂等依据）。 */
  const started = ref(false);

  // ==========================================================================
  // Getters
  // ==========================================================================

  const toggleState = computed(() => computeToggleState(snapshot.value));

  /** 全局功能开关是否已开启（availability "disabled" 即全局关）。 */
  const globallyEnabled = computed(() => snapshot.value !== null && snapshot.value.availability !== "disabled");

  const sessionEnabled = computed(() => snapshot.value?.session?.sessionEnabled ?? false);

  const canToggle = computed(() => toggleState.value.canToggle);

  const toggleDisabledReason = computed(() => toggleState.value.reason);

  const toggleWarning = computed(() => toggleState.value.warning);

  /** 本会话是否正在执行电脑动作（活动条“操作中”标识）。 */
  const isActing = computed(() => snapshot.value?.session?.activity?.state === "running");

  const grant = computed<ComputerGrantLevel>(() => snapshot.value?.session?.grant ?? "none");

  // ==========================================================================
  // Transport / subscription
  // ==========================================================================

  let transport: ComputerUseTransport = useComputerUseRpc();
  let unsubscribeEvents: (() => void) | null = null;

  /** 订阅 computer-use 事件并追平当前快照。幂等：已订阅时重复调用不叠加监听。 */
  function start(injected?: ComputerUseTransport): void {
    if (injected) transport = injected;
    if (started.value) return;
    try {
      unsubscribeEvents = transport.onComputerUseEvent((event) => {
        handleEvent(event);
      });
    } catch (err) {
      // 预加载表面缺失（例如测试桩不完整）：保持未启动，下一次 start 可重试。
      console.warn("[ComputerUseStore] Failed to subscribe to computer-use events:", err);
      return;
    }
    started.value = true;
    // 订阅生效后再查询权威快照，窗口内先到的推送不会被更旧的快照响应覆盖。
    void refresh();
  }

  /** 退订事件（不丢弃已镜像的快照）。 */
  function stop(): void {
    unsubscribeEvents?.();
    unsubscribeEvents = null;
    started.value = false;
  }

  // ==========================================================================
  // Event handling
  // ==========================================================================

  function handleEvent(event: ComputerUseEvent): void {
    switch (event.type) {
      case "snapshot":
        applySnapshot(event.snapshot);
        break;
      case "install_progress":
        installProgress.value = event.progress;
        break;
      case "activity":
        applyActivity(event.sessionId, event.activity);
        break;
    }
  }

  /** 权威快照整包替换（服务端 50ms 合并节流后的结果）。 */
  function applySnapshot(next: ComputerUseSnapshot): void {
    const previous = snapshot.value;
    if (previous?.session?.sessionId !== next.session?.sessionId) {
      // 会话切换（含切到无前台会话）：上一会话的活动摘要立即失效。
      lastActivity.value = null;
    }
    snapshot.value = next;
    if (next.install) {
      installProgress.value = next.install;
    } else if (installProgress.value && !isTerminalInstallPhase(installProgress.value.phase)) {
      // 安装已结束但没有终态事件（例如被取消）：以快照为准清除进度。
      installProgress.value = null;
    }
  }

  /** 活动推送：仅当它属于当前镜像的会话（或快照尚未到达）时采纳。 */
  function applyActivity(sessionId: string, activity: ComputerUseActivity): void {
    const current = snapshot.value;
    if (current?.session && current.session.sessionId !== sessionId) return;
    lastActivity.value = activity;
    if (current?.session) {
      snapshot.value = { ...current, session: { ...current.session, activity } };
    }
  }

  // ==========================================================================
  // Commands
  // ==========================================================================

  /** 发送一条命令并把返回的权威快照并入镜像；失败只记录 lastError。 */
  async function sendCommand(command: ComputerUseCommand): Promise<ComputerUseSnapshot | null> {
    try {
      const result = await transport.sendComputerUseCommand(command);
      if (result.success) {
        if (result.data) {
          applySnapshot(result.data);
          lastError.value = null;
          return result.data;
        }
        lastError.value = `电脑操控命令 ${command.type} 未返回快照`;
        return null;
      }
      lastError.value = result.error;
      return null;
    } catch (err) {
      lastError.value = err instanceof Error ? err.message : String(err);
      return null;
    }
  }

  /** get_snapshot；会话切换时由 CenterPanel watch 当前 sessionId 调用。 */
  function refresh(): Promise<ComputerUseSnapshot | null> {
    return sendCommand({ type: "get_snapshot" });
  }

  function setSessionEnabled(enabled: boolean): Promise<ComputerUseSnapshot | null> {
    return sendCommand({ type: "set_session_enabled", enabled });
  }

  function revokeGrants(): Promise<ComputerUseSnapshot | null> {
    return sendCommand({ type: "revoke_grants" });
  }

  function emergencyStop(): Promise<ComputerUseSnapshot | null> {
    return sendCommand({ type: "emergency_stop" });
  }

  function installDriver(): Promise<ComputerUseSnapshot | null> {
    return sendCommand({ type: "install_driver" });
  }

  function cancelInstall(): Promise<ComputerUseSnapshot | null> {
    return sendCommand({ type: "cancel_install" });
  }

  function recheckDriver(): Promise<ComputerUseSnapshot | null> {
    return sendCommand({ type: "recheck_driver" });
  }

  function openPermissionSettings(permission: "accessibility" | "screen_recording"): Promise<ComputerUseSnapshot | null> {
    return sendCommand({ type: "open_permission_settings", permission });
  }

  // ==========================================================================
  // Expose
  // ==========================================================================

  return {
    // State
    snapshot,
    installProgress,
    lastActivity,
    lastError,
    started,
    // Getters
    globallyEnabled,
    sessionEnabled,
    canToggle,
    toggleDisabledReason,
    toggleWarning,
    isActing,
    grant,
    // Subscription
    start,
    stop,
    // Commands
    refresh,
    setSessionEnabled,
    revokeGrants,
    emergencyStop,
    installDriver,
    cancelInstall,
    recheckDriver,
    openPermissionSettings,
  };
});
