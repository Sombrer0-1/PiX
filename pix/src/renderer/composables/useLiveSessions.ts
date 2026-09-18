import { computed, ref } from "vue";
import type { LiveSessionInfo } from "@shared/types";

/**
 * Background live-session state (Stage B D7): the map of sessions detached to
 * the background by the solo bridge, keyed by session path. Pushes arrive on
 * the pi-sessions-state channel (detach/attach/state-change/finalize);
 * `subscribeLiveSessions` also pulls the current snapshot once so a remount
 * converges without waiting for the next broadcast. App-wide singleton: the
 * active session is never listed, and the team bridge never backgrounds.
 */
const liveSessions = ref<Map<string, LiveSessionInfo>>(new Map());
let unsubscribe: (() => void) | null = null;

function applyPayload(sessions: LiveSessionInfo[]): void {
  const next = new Map<string, LiveSessionInfo>();
  for (const info of sessions) {
    next.set(info.path, info);
  }
  liveSessions.value = next;
}

/** Install the single pi-sessions-state subscription (idempotent). */
export function subscribeLiveSessions(): void {
  if (unsubscribe) {
    return;
  }
  unsubscribe = window.pixApi.onSessionsState((payload) => {
    applyPayload(payload.sessions);
  });
  void window.pixApi
    .getSessionsState()
    .then((payload) => {
      applyPayload(payload.sessions);
    })
    .catch((err: unknown) => {
      console.error("[useLiveSessions] Failed to query sessions state:", err);
    });
}

/** Drop the subscription and clear the map (workspace unmount). */
export function unsubscribeLiveSessions(): void {
  unsubscribe?.();
  unsubscribe = null;
  liveSessions.value = new Map();
}

export function useLiveSessions() {
  return {
    liveSessions: computed(() => liveSessions.value),
    /** Liveness state of one session path, or undefined when it is not backgrounded. */
    liveStateFor(path: string): LiveSessionInfo["state"] | undefined {
      return liveSessions.value.get(path)?.state;
    },
  };
}
