/**
 * Commands Store
 *
 * Manages available slash commands, skills, and prompt templates.
 * Populated via pi's RPC get_commands.
 */

import { defineStore } from "pinia";
import { ref, computed } from "vue";
import type { RpcSlashCommand } from "@/types/rpc";

export const useCommandsStore = defineStore("commands", () => {
  const allCommands = ref<RpcSlashCommand[]>([]);

  const builtinCommands = computed(() =>
    allCommands.value.filter((c) => c.source !== "extension" && c.source !== "skill" && c.source !== "prompt")
  );

  const extensionCommands = computed(() =>
    allCommands.value.filter((c) => c.source === "extension")
  );

  const skills = computed(() =>
    allCommands.value.filter((c) => c.source === "skill")
  );

  const promptTemplates = computed(() =>
    allCommands.value.filter((c) => c.source === "prompt")
  );

  function setCommands(commands: RpcSlashCommand[]): void {
    allCommands.value = commands;
  }

  /**
   * Filter commands matching a query string.
   * Used by the command palette when user types "/".
   */
  function searchCommands(query: string): RpcSlashCommand[] {
    const q = query.toLowerCase().replace(/^\//, "");
    if (!q) return allCommands.value;
    return allCommands.value.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        (c.description && c.description.toLowerCase().includes(q))
    );
  }

  return {
    allCommands,
    builtinCommands,
    extensionCommands,
    skills,
    promptTemplates,
    setCommands,
    searchCommands,
  };
});
