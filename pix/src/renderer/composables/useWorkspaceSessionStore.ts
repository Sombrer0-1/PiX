import { computed } from "vue";
import { useSessionStore } from "../stores/session-store";
import type { AgentMessage } from "@/types/rpc";

/**
 * The workspace's session conversation store.
 *
 * This is the **solo** conversation: the host SessionBridge that used to back
 * team mode is not a discussion participant any more (dev plan §9), so it is
 * never selected here. In team mode the discussion surface is the roundtable
 * (`useTeamStore()`: timeline + attention + deliverables) — this composable
 * keeps serving the solo pane and the BottomBar-style input only.
 */
export function useWorkspaceSessionStore() {
  const store = useSessionStore();

  return {
    displayBlocks: computed(() => store.displayBlocks),
    isStreaming: computed(() => store.isStreaming),
    errorMessage: computed(() => store.errorMessage),
    lastRetryableError: computed(() => store.lastRetryableError),
    appendOptimisticUserMessage: (
      text: string,
      filePaths?: string[],
      clipboardImages?: Array<{ mimeType: string }>,
    ): string | null =>
      store.appendOptimisticUserMessage(text, filePaths, clipboardImages),
    failOptimisticUserMessage: (blockId: string | null, message: string): void =>
      store.failOptimisticUserMessage(blockId, message),
    loadMessages: (messages: AgentMessage[]): void => store.loadMessages(messages),
    clearSession: (): void => store.clearSession(),
  };
}
