/**
 * RPC Store
 *
 * Central Pinia store for Pi RPC communication state.
 * Wraps the useRpc composable for app-wide access.
 */

import { defineStore } from "pinia";
import { useRpc } from "@/composables/useRpc";

export const useRpcStore = defineStore("rpc", () => {
  const rpc = useRpc();
  return {
    ...rpc,
  };
});
