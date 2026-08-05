import { computed } from "vue";
import { useSessionStore, useTeamLeaderSessionStore } from "../stores/session-store";
import { useTeamStore } from "../stores/team-store";
import type { AgentMessage, AgentSessionEvent } from "@/types/rpc";

/**
 * Selects one of the two independent conversation stores for workspace UI.
 * The stores themselves never share events or mutable session data.
 */
export function useWorkspaceSessionStore() {
  const teamStore = useTeamStore();
  const singleStore = useSessionStore();
  const teamLeaderStore = useTeamLeaderSessionStore();
  const activeStore = computed(() => (teamStore.teamMode ? teamLeaderStore : singleStore));

  return {
    events: computed(() => activeStore.value.events),
    displayBlocks: computed(() => activeStore.value.displayBlocks),
    isStreaming: computed(() => activeStore.value.isStreaming),
    errorMessage: computed(() => activeStore.value.errorMessage),
    lastRetryableError: computed(() => activeStore.value.lastRetryableError),
    addEvent: (event: AgentSessionEvent): void => activeStore.value.addEvent(event),
    addEvents: (events: AgentSessionEvent[]): void => activeStore.value.addEvents(events),
    appendOptimisticUserMessage: (text: string, filePaths?: string[]): string | null =>
      activeStore.value.appendOptimisticUserMessage(text, filePaths),
    failOptimisticUserMessage: (blockId: string | null, message: string): void =>
      activeStore.value.failOptimisticUserMessage(blockId, message),
    loadMessages: (messages: AgentMessage[]): void => activeStore.value.loadMessages(messages),
    clearSession: (): void => activeStore.value.clearSession(),
    getRawEventsJson: (): string => activeStore.value.getRawEventsJson(),
  };
}
