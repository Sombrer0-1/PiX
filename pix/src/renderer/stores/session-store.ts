/**
 * Session Store
 *
 * Manages the current session's event stream and display blocks.
 * Transforms raw AgentSessionEvents into organized DisplayBlocks for rendering.
 *
 * Tool executions are aggregated into a single "work-status" block instead of
 * individual inline blocks. This keeps the chat mainline clean.
 *
 * The folding logic itself lives in the framework-free display-blocks
 * assembler (utils/display-blocks.ts): it is injected with the reactive
 * displayBlocks array and mutates it in place, so the two views (main chat /
 * task transcript) share identical folding semantics.
 */

import { defineStore } from "pinia";
import { ref } from "vue";
import type { AgentMessage, AgentSessionEvent } from "@/types/rpc";
import type { DisplayBlock } from "@/types/session";
import { createDisplayBlockAssembler } from "@/utils/display-blocks";

const MAX_EVENTS = 50000;
const MAX_DISPLAY_BLOCKS = 20000;

export function createSessionStore(id: string, options: { teamLeader?: boolean } = {}) {
  return defineStore(id, () => {
    const events = ref<AgentSessionEvent[]>([]);
    const displayBlocks = ref<DisplayBlock[]>([]);
    const isStreaming = ref(false);
    const errorMessage = ref<string | null>(null);
    // Mirrors the assembler's internal lastRetryableError (updated after every
    // assembler call); the assembler is framework-free, so the store re-syncs
    // the reactive ref instead of passing Vue state into it.
    const lastRetryableError = ref<{ blockId: string } | null>(null);

    const assembler = createDisplayBlockAssembler({
      teamLeader: options.teamLeader === true,
      blocks: displayBlocks.value,
    });

    function syncLastRetryableError(): void {
      lastRetryableError.value = assembler.lastRetryableError;
    }

    function addEvent(event: AgentSessionEvent): void {
      if (events.value.length >= MAX_EVENTS) {
        events.value = events.value.slice(-Math.floor(MAX_EVENTS / 2));
      }
      if (displayBlocks.value.length >= MAX_DISPLAY_BLOCKS) {
        // Cap in place: the assembler holds the same array reference, so a
        // reassignment would leave the assembler mutating a detached array.
        displayBlocks.value.splice(0, displayBlocks.value.length - Math.floor(MAX_DISPLAY_BLOCKS / 2));
      }
      events.value.push(event);
      if (event.type === "agent_start") {
        isStreaming.value = true;
        errorMessage.value = null;
      } else if (event.type === "agent_end") {
        isStreaming.value = false;
      }
      assembler.applyEvent(event);
      syncLastRetryableError();
    }

    function addEvents(newEvents: AgentSessionEvent[]): void {
      for (const event of newEvents) {
        addEvent(event);
      }
    }

    function appendOptimisticUserMessage(text: string, filePaths: string[] = []): string | null {
      const blockId = assembler.appendOptimisticUserMessage(text, filePaths);
      syncLastRetryableError();
      return blockId;
    }

    function failOptimisticUserMessage(blockId: string | null, message: string): void {
      assembler.failOptimisticUserMessage(blockId, message);
      syncLastRetryableError();
    }

    /**
     * Load messages from history. The store keeps the raw AgentMessage[]
     * public API and shims them into type==="message" entries so the
     * assembler folds them through the same entry path as disk replay.
     */
    function loadMessages(messages: AgentMessage[]): void {
      clearSession();
      assembler.loadEntries(messages.map((message) => ({ type: "message", message })));
      syncLastRetryableError();
    }

    function clearSession(): void {
      events.value = [];
      isStreaming.value = false;
      errorMessage.value = null;
      assembler.clear();
      syncLastRetryableError();
    }

    function getRawEventsJson(): string {
      return JSON.stringify(events.value, null, 2);
    }

    return {
      events,
      displayBlocks,
      isStreaming,
      errorMessage,
      lastRetryableError,
      addEvent,
      addEvents,
      appendOptimisticUserMessage,
      failOptimisticUserMessage,
      loadMessages,
      clearSession,
      getRawEventsJson,
    };
  });
}

export const useSessionStore = createSessionStore("session");
export const useTeamLeaderSessionStore = createSessionStore("team-leader-session", { teamLeader: true });
