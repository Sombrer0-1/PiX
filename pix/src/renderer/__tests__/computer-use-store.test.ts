/**
 * Computer-use store tests.
 *
 * Acceptance: subscription (subscribe before the get_snapshot catch-up,
 * idempotent start, stop), event merging (snapshot replaces the mirror;
 * install_progress / snapshot.install interplay; activity only applies to the
 * mirrored session and is reset on a session switch) and the closed
 * computeToggleState mapping - one case per table row (1-12).
 * The store talks to main only through the injected transport, so no Electron
 * runtime and no window.pixApi stub are needed.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import type { PixCommandResult } from "@shared/types.js";
import type {
  ComputerUseCommand,
  ComputerUseEvent,
  ComputerUseSnapshot,
} from "@shared/computer-use-types.js";
import { computeToggleState, useComputerUseStore } from "../stores/computer-use-store";
import { makeComputerUseSession as makeSession, makeStoppedComputerUseSnapshot as makeSnapshot } from "./helpers/computer-use-fixtures";

// ============================================================================
// Fixtures
// ============================================================================

/** Transport double: records commands, lets tests emit events and replace responses. */
function makeTransport(response?: ComputerUseSnapshot) {
  const commands: ComputerUseCommand[] = [];
  let listener: ((event: ComputerUseEvent) => void) | null = null;
  let listeners = 0;
  const sendComputerUseCommand = vi.fn(
    async (command: ComputerUseCommand): Promise<PixCommandResult<ComputerUseSnapshot>> => {
      commands.push(command);
      return response ? { success: true, data: response } : { success: true };
    },
  );
  const onComputerUseEvent = vi.fn((callback: (event: ComputerUseEvent) => void) => {
    listeners += 1;
    listener = callback;
    return () => {
      listeners -= 1;
      if (listener === callback) listener = null;
    };
  });
  return {
    commands,
    emit: (event: ComputerUseEvent) => listener?.(event),
    listenerCount: () => listeners,
    sendComputerUseCommand,
    onComputerUseEvent,
  };
}

beforeEach(() => {
  setActivePinia(createPinia());
});

// ============================================================================
// computeToggleState - closed mapping, one case per table row
// ============================================================================

describe("computeToggleState (表格逐行)", () => {
  it("row 1: null snapshot -> connecting", () => {
    expect(computeToggleState(null)).toEqual({ canToggle: false, reason: "正在连接…", warning: null });
  });

  it("row 2: disabled", () => {
    const state = computeToggleState(makeSnapshot({ availability: "disabled" }));
    expect(state).toEqual({ canToggle: false, reason: "请先在 设置 › 电脑操控 中开启", warning: null });
  });

  it("row 3: unsupported_platform", () => {
    const state = computeToggleState(makeSnapshot({ availability: "unsupported_platform", platform: null }));
    expect(state).toEqual({ canToggle: false, reason: "当前平台不支持电脑操控", warning: null });
  });

  it("row 4: installing", () => {
    const state = computeToggleState(
      makeSnapshot({ availability: "installing", install: { phase: "downloading", receivedBytes: 1, totalBytes: 2 } }),
    );
    expect(state).toEqual({ canToggle: false, reason: "操控驱动安装中…", warning: null });
  });

  it("row 5: driver_missing", () => {
    const state = computeToggleState(makeSnapshot({ availability: "driver_missing" }));
    expect(state).toEqual({ canToggle: false, reason: "未安装操控驱动，请在设置中安装", warning: null });
  });

  it("row 6: driver_incompatible", () => {
    const state = computeToggleState(makeSnapshot({ availability: "driver_incompatible" }));
    expect(state).toEqual({ canToggle: false, reason: "驱动版本不兼容，请在设置中重新安装", warning: null });
  });

  it("row 7: failed", () => {
    const state = computeToggleState(makeSnapshot({ availability: "failed" }));
    expect(state).toEqual({ canToggle: false, reason: "驱动异常，请在设置中重试", warning: null });
  });

  it("row 8: no foreground session", () => {
    const state = computeToggleState(makeSnapshot({ session: null }));
    expect(state).toEqual({
      canToggle: false,
      reason: "当前会话未挂载电脑操控，新建或切换会话后生效",
      warning: null,
    });
  });

  it("row 9: read-only mode", () => {
    const state = computeToggleState(makeSnapshot({ session: makeSession({ inactiveReason: "read_only_mode" }) }));
    expect(state).toEqual({ canToggle: false, reason: "只读模式下不可用", warning: null });
  });

  it("row 10: plan mode", () => {
    const state = computeToggleState(makeSnapshot({ session: makeSession({ inactiveReason: "plan_mode" }) }));
    expect(state).toEqual({ canToggle: false, reason: "规划阶段不可用", warning: null });
  });

  it("row 11: permission_required is toggleable and carries the missing-permission warning", () => {
    const state = computeToggleState(
      makeSnapshot({
        availability: "permission_required",
        platform: "darwin-universal",
        missingPermissions: ["accessibility", "screen_recording"],
      }),
    );
    expect(state).toEqual({
      canToggle: true,
      reason: null,
      warning: "缺少系统权限：辅助功能、屏幕录制，请在设置中授权",
    });
  });

  it("row 12: stopped/starting/ready stay toggleable - warning only for degraded capabilities", () => {
    for (const availability of ["stopped", "starting", "ready"] as const) {
      expect(computeToggleState(makeSnapshot({ availability }))).toEqual({ canToggle: true, reason: null, warning: null });
    }
    expect(
      computeToggleState(makeSnapshot({ session: makeSession({ inactiveReason: undefined }), degradedCapabilities: ["background_input"] })),
    ).toEqual({ canToggle: true, reason: null, warning: "能力受限：Wayland 下无法后台输入（改用前台需要授权）" });
    expect(computeToggleState(makeSnapshot({ availability: "ready", degradedCapabilities: ["accessibility_tree"] })).warning).toContain(
      "可访问性树不可用",
    );
  });
});

// ============================================================================
// Subscription
// ============================================================================

describe("subscription", () => {
  it("start subscribes before the get_snapshot catch-up and mirrors the response", async () => {
    const store = useComputerUseStore();
    const transport = makeTransport(makeSnapshot({ updatedAt: 7 }));

    store.start(transport);

    expect(store.started).toBe(true);
    expect(transport.onComputerUseEvent).toHaveBeenCalledTimes(1);
    expect(transport.commands).toEqual([{ type: "get_snapshot" }]);
    // Subscription is installed before the query so an early push can never be
    // overwritten by the (older) snapshot response.
    expect(transport.onComputerUseEvent.mock.invocationCallOrder[0]).toBeLessThan(
      transport.sendComputerUseCommand.mock.invocationCallOrder[0],
    );

    await vi.waitFor(() => {
      expect(store.snapshot?.updatedAt).toBe(7);
    });
  });

  it("is idempotent: a second start neither re-subscribes nor re-queries", () => {
    const store = useComputerUseStore();
    const transport = makeTransport(makeSnapshot());

    store.start(transport);
    store.start(transport);
    store.start();

    expect(transport.onComputerUseEvent).toHaveBeenCalledTimes(1);
    expect(transport.commands).toHaveLength(1);
    expect(transport.listenerCount()).toBe(1);
  });

  it("stop unsubscribes; start after stop subscribes again", () => {
    const store = useComputerUseStore();
    const transport = makeTransport(makeSnapshot());

    store.start(transport);
    store.stop();

    expect(store.started).toBe(false);
    expect(transport.listenerCount()).toBe(0);

    store.start();
    expect(transport.listenerCount()).toBe(1);
    expect(transport.onComputerUseEvent).toHaveBeenCalledTimes(2);
  });
});

// ============================================================================
// Event merging
// ============================================================================

describe("event merging", () => {
  it("snapshot events replace the whole mirror", () => {
    const store = useComputerUseStore();
    const transport = makeTransport();
    store.start(transport);

    transport.emit({ type: "snapshot", snapshot: makeSnapshot({ updatedAt: 11, availability: "ready" }) });
    expect(store.snapshot?.updatedAt).toBe(11);
    expect(store.globallyEnabled).toBe(true);

    transport.emit({ type: "snapshot", snapshot: makeSnapshot({ updatedAt: 12, availability: "disabled" }) });
    expect(store.snapshot?.updatedAt).toBe(12);
    expect(store.globallyEnabled).toBe(false);
  });

  it("install_progress events drive the progress bar; the snapshot install field wins", () => {
    const store = useComputerUseStore();
    const transport = makeTransport();
    store.start(transport);

    transport.emit({
      type: "install_progress",
      progress: { phase: "downloading", receivedBytes: 1_000, totalBytes: 10_000 },
    });
    expect(store.installProgress).toEqual({ phase: "downloading", receivedBytes: 1_000, totalBytes: 10_000 });

    const installing = makeSnapshot({
      availability: "installing",
      install: { phase: "extracting", receivedBytes: 10_000, totalBytes: 10_000 },
    });
    transport.emit({ type: "snapshot", snapshot: installing });
    expect(store.installProgress?.phase).toBe("extracting");
  });

  it("a snapshot without install clears an in-flight progress but keeps a terminal one", () => {
    const store = useComputerUseStore();
    const transport = makeTransport();
    store.start(transport);

    transport.emit({
      type: "install_progress",
      progress: { phase: "downloading", receivedBytes: 1_000, totalBytes: 10_000 },
    });
    transport.emit({ type: "snapshot", snapshot: makeSnapshot({ availability: "stopped" }) });
    expect(store.installProgress).toBeNull();

    transport.emit({
      type: "install_progress",
      progress: { phase: "failed", receivedBytes: 1_000, totalBytes: 10_000, error: "校验失败，已拒绝安装" },
    });
    transport.emit({ type: "snapshot", snapshot: makeSnapshot({ availability: "driver_missing" }) });
    expect(store.installProgress?.phase).toBe("failed");
    expect(store.installProgress?.error).toBe("校验失败，已拒绝安装");
  });

  it("activity events apply to the mirrored session and merge into the snapshot", () => {
    const store = useComputerUseStore();
    const transport = makeTransport();
    store.start(transport);

    transport.emit({
      type: "snapshot",
      snapshot: makeSnapshot({ session: makeSession({ sessionEnabled: true, grant: "background", holdsLease: true }) }),
    });

    const activity = { toolCallId: "t-1", tool: "act", summary: "点击 记事本 · 保存 按钮", startedAt: 5, state: "running" } as const;
    transport.emit({ type: "activity", sessionId: "session-1", activity });

    expect(store.lastActivity).toEqual(activity);
    expect(store.snapshot?.session?.activity).toEqual(activity);
    expect(store.isActing).toBe(true);
    expect(store.grant).toBe("background");
  });

  it("drops activity events of other sessions and resets the retained activity on a session switch", () => {
    const store = useComputerUseStore();
    const transport = makeTransport();
    store.start(transport);

    transport.emit({ type: "snapshot", snapshot: makeSnapshot({ session: makeSession({ sessionEnabled: true }) }) });
    transport.emit({
      type: "activity",
      sessionId: "session-1",
      activity: { toolCallId: "t-1", tool: "observe", summary: "观察 记事本", startedAt: 1, state: "succeeded" },
    });
    expect(store.lastActivity?.toolCallId).toBe("t-1");

    // Another (background) session's activity must not leak into the mirror.
    transport.emit({
      type: "activity",
      sessionId: "session-2",
      activity: { toolCallId: "t-2", tool: "act", summary: "点击 其它窗口", startedAt: 2, state: "running" },
    });
    expect(store.lastActivity?.toolCallId).toBe("t-1");

    // Switching to another session invalidates the previous summary.
    transport.emit({
      type: "snapshot",
      snapshot: makeSnapshot({ session: makeSession({ sessionId: "session-2", sessionEnabled: true }) }),
    });
    expect(store.lastActivity).toBeNull();
  });
});

// ============================================================================
// Commands
// ============================================================================

describe("commands", () => {
  it("setSessionEnabled sends the command and applies the returned snapshot", async () => {
    const store = useComputerUseStore();
    const transport = makeTransport(makeSnapshot({ session: makeSession({ sessionEnabled: true }) }));
    store.start(transport);
    transport.commands.length = 0;

    await store.setSessionEnabled(true);

    expect(transport.commands).toEqual([{ type: "set_session_enabled", enabled: true }]);
    expect(store.sessionEnabled).toBe(true);
    expect(store.lastError).toBeNull();
  });

  it("maps every action onto its ComputerUseCommand", async () => {
    const store = useComputerUseStore();
    const transport = makeTransport(makeSnapshot());
    store.start(transport);
    transport.commands.length = 0;

    await store.revokeGrants();
    await store.emergencyStop();
    await store.installDriver();
    await store.cancelInstall();
    await store.recheckDriver();
    await store.openPermissionSettings("screen_recording");
    await store.refresh();

    expect(transport.commands).toEqual([
      { type: "revoke_grants" },
      { type: "emergency_stop" },
      { type: "install_driver" },
      { type: "cancel_install" },
      { type: "recheck_driver" },
      { type: "open_permission_settings", permission: "screen_recording" },
      { type: "get_snapshot" },
    ]);
  });

  it("a failed command records lastError and keeps the previous mirror", async () => {
    const store = useComputerUseStore();
    const transport = makeTransport();
    store.start(transport);
    transport.emit({ type: "snapshot", snapshot: makeSnapshot({ updatedAt: 21 }) });

    transport.sendComputerUseCommand.mockResolvedValueOnce({
      success: false,
      error: "没有活动会话",
      code: "computer_use_unavailable",
    });
    const result = await store.setSessionEnabled(true);

    expect(result).toBeNull();
    expect(store.lastError).toBe("没有活动会话");
    expect(store.snapshot?.updatedAt).toBe(21);
  });

  it("a throwing transport records the message instead of rejecting", async () => {
    const store = useComputerUseStore();
    const transport = makeTransport();
    store.start(transport);
    transport.sendComputerUseCommand.mockRejectedValueOnce(new Error("预加载 API 不可用。"));

    await expect(store.refresh()).resolves.toBeNull();
    expect(store.lastError).toBe("预加载 API 不可用。");
  });
});
