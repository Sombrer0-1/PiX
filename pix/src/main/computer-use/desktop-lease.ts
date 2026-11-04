/**
 * Desktop lease.
 *
 * One holder at a time may drive the desktop. The lease is memory-only (never
 * persisted), keyed by the foreground session controller id, and auto-released
 * after `idleReleaseMs` without a `tryAcquire`, so an abandoned or crashed
 * session cannot keep a stale lock on the desktop forever. `tryAcquire` by the
 * current holder is the heartbeat: it returns true and touches `lastUsedAt`.
 */

import { unrefTimer, type DesktopLease, type DesktopLeaseState } from "./contracts.js";

const DEFAULT_IDLE_RELEASE_MS = 60_000;

export function createDesktopLease(opts: {
	idleReleaseMs?: number;
	now?: () => number;
	setTimer?: typeof setTimeout;
	clearTimer?: typeof clearTimeout;
} = {}): DesktopLease {
	const idleReleaseMs = opts.idleReleaseMs ?? DEFAULT_IDLE_RELEASE_MS;
	const now = opts.now ?? Date.now;
	const setTimer = opts.setTimer ?? setTimeout;
	const clearTimer = opts.clearTimer ?? clearTimeout;
	const listeners = new Set<(state: DesktopLeaseState) => void>();

	let holderId: string | null = null;
	let acquiredAt: number | null = null;
	let lastUsedAt: number | null = null;
	let idleTimer: ReturnType<typeof setTimer> | null = null;

	function snapshot(): DesktopLeaseState {
		return { holderId, acquiredAt, lastUsedAt };
	}

	function notify(): void {
		for (const listener of [...listeners]) listener(snapshot());
	}

	function clearIdleTimer(): void {
		if (idleTimer === null) return;
		clearTimer(idleTimer);
		idleTimer = null;
	}

	function armIdleTimer(): void {
		clearIdleTimer();
		idleTimer = setTimer(() => {
			idleTimer = null;
			releaseHolder();
		}, idleReleaseMs);
		// A ref'd timer would hold a short-lived Node process (tests, CLI) open for
		// idleReleaseMs after its last action; Electron's main process is unaffected.
		unrefTimer(idleTimer);
	}

	function releaseHolder(): void {
		clearIdleTimer();
		if (holderId === null) return;
		holderId = null;
		acquiredAt = null;
		lastUsedAt = null;
		notify();
	}

	return {
		tryAcquire(nextHolderId: string): boolean {
			if (holderId !== null && holderId !== nextHolderId) return false;
			const at = now();
			if (holderId === null) acquiredAt = at;
			holderId = nextHolderId;
			lastUsedAt = at;
			armIdleTimer();
			notify();
			return true;
		},

		release(id: string): void {
			if (holderId !== id) return;
			releaseHolder();
		},

		forceRelease(): void {
			releaseHolder();
		},

		getState(): DesktopLeaseState {
			return snapshot();
		},

		onChange(listener: (state: DesktopLeaseState) => void): () => void {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
}
