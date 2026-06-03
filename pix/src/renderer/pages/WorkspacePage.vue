<script setup lang="ts">
/**
 * Workspace Page
 *
 * Three-panel layout:
 * - Left: session navigation
 * - Center: session content + composer
 * - Right: inspector (status, tokens, errors)
 */
import { onMounted, onUnmounted } from "vue";
import { useRouter } from "vue-router";
import { useSessionStore } from "../stores/session-store";
import { useRpc } from "../composables/useRpc";
import { useProjectStore } from "../stores/project-store";
import { useAuthStore } from "../stores/auth-store";
import AppLayout from "../components/layout/AppLayout.vue";
import LeftPanel from "../components/layout/LeftPanel.vue";
import CenterPanel from "../components/layout/CenterPanel.vue";
import RightPanel from "../components/layout/RightPanel.vue";

const router = useRouter();
const sessionStore = useSessionStore();
const projectStore = useProjectStore();
const authStore = useAuthStore();
const rpc = useRpc();
let unsubscribeEvent: (() => void) | null = null;

onMounted(async () => {
  if (!rpc.isConnected.value) {
    const attached = await rpc.attachToRunningSession();
    if (!attached) {
      router.push("/");
      return;
    }
  }

  // Always start a fresh session when first entering the workspace.
  // The backend may have restored a previous session (continueRecent),
  // but the UI expectation is a clean slate — matching every AI app convention.
  await rpc.newSession();
  sessionStore.clearSession();

  // Fetch provider auth status so the model selector shows correct badges.
  try { await authStore.refreshStatus(); } catch { /* non-fatal */ }

  await projectStore.listSessions();

  unsubscribeEvent = window.pixApi.onPiEvent((event) => {
    sessionStore.addEvent(event);
    if (event.type === "agent_end") {
      void projectStore.listSessions();
    }
  });
});

onUnmounted(() => {
  if (unsubscribeEvent) {
    unsubscribeEvent();
    unsubscribeEvent = null;
  }
});
</script>

<template>
  <AppLayout>
    <template #left>
      <LeftPanel />
    </template>
    <template #center>
      <CenterPanel />
    </template>
    <template #right>
      <RightPanel />
    </template>
  </AppLayout>
</template>
