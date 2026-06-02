import { defineStore } from "pinia";
import { ref, computed } from "vue";
import type { AuthStatusMap } from "@/types/rpc";
import { useRpc } from "@/composables/useRpc";

/**
 * Auth Store
 *
 * Manages authentication status for model providers.
 * Reads auth state from the pi AuthStorage through SessionBridge.
 */
export const useAuthStore = defineStore("auth", () => {
  const authStatus = ref<AuthStatusMap>({});
  const isLoaded = ref(false);

  const configuredProviders = computed(() =>
    Object.entries(authStatus.value)
      .filter(([, status]) => status.configured)
      .map(([name]) => name)
  );

  const unconfiguredProviders = computed(() =>
    Object.entries(authStatus.value)
      .filter(([, status]) => !status.configured)
      .map(([name]) => name)
  );

  const providerCount = computed(() => Object.keys(authStatus.value).length);
  const configuredCount = computed(() => configuredProviders.value.length);

  async function refreshStatus(): Promise<void> {
    const rpc = useRpc();
    if (!rpc.isConnected.value) {
      authStatus.value = {};
      isLoaded.value = false;
      return;
    }
    try {
      const status = await rpc.getAuthStatus();
      if (status) {
        authStatus.value = status;
        isLoaded.value = true;
      }
    } catch (err) {
      console.error("[auth-store] Failed to get auth status:", err);
      isLoaded.value = false;
    }
  }

  function getProviderStatus(provider: string): { configured: boolean; source?: string; label?: string } {
    const status = authStatus.value[provider];
    if (!status) return { configured: false };
    return {
      configured: status.configured,
      source: status.source,
      label: status.label,
    };
  }

  return {
    authStatus,
    isLoaded,
    configuredProviders,
    unconfiguredProviders,
    providerCount,
    configuredCount,
    refreshStatus,
    getProviderStatus,
  };
});
