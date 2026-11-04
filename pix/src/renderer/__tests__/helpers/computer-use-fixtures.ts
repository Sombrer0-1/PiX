/**
 * Shared computer-use test fixtures (PiX 1.5.0).
 *
 * makeComputerUseSnapshot: store.start() 首查 get_snapshot 的应答快照
 * （默认全局关、无会话：开关与活动条都不显示）；computerUseApiMocks:
 * window.pixApi 上的 computer-use IPC 表面两件套（CenterPanel 挂载
 * ComputerUseToggle/ActivityBar → store.start() 走到的 mock）。
 */

import { vi } from "vitest";
import type { ComputerUseSessionSnapshot, ComputerUseSnapshot } from "@shared/computer-use-types.js";

export function makeComputerUseSnapshot(overrides?: Partial<ComputerUseSnapshot>): ComputerUseSnapshot {
  return {
    platform: "win32-x64",
    availability: "disabled",
    driver: { version: null, source: null, path: null, expectedVersion: "0.34.1" },
    install: null,
    emergencyShortcut: null,
    session: null,
    updatedAt: 0,
    ...overrides,
  };
}

export function makeComputerUseSession(overrides?: Partial<ComputerUseSessionSnapshot>): ComputerUseSessionSnapshot {
  return {
    sessionId: "session-1",
    sessionEnabled: false,
    grant: "none",
    holdsLease: false,
    halted: false,
    toolsActive: false,
    inactiveReason: "session_disabled",
    activity: null,
    ...overrides,
  };
}

export function makeStoppedComputerUseSnapshot(overrides?: Partial<ComputerUseSnapshot>): ComputerUseSnapshot {
  return makeComputerUseSnapshot({
    availability: "stopped",
    driver: { version: "0.34.1", source: "managed", path: "C:\\agents\\cua-driver.exe", expectedVersion: "0.34.1" },
    emergencyShortcut: "Control+Alt+Escape",
    session: makeComputerUseSession(),
    updatedAt: 1,
    ...overrides,
  });
}

export function computerUseApiMocks(snapshotOverrides?: Partial<ComputerUseSnapshot>): {
  sendComputerUseCommand: ReturnType<typeof vi.fn>;
  onComputerUseEvent: ReturnType<typeof vi.fn>;
} {
  return {
    sendComputerUseCommand: vi.fn().mockResolvedValue({ success: true, data: makeComputerUseSnapshot(snapshotOverrides) }),
    onComputerUseEvent: vi.fn(() => () => {}),
  };
}
