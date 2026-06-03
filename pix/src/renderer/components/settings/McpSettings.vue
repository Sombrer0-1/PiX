<script setup lang="ts">
/**
 * MCP Settings Panel
 *
 * Displays connected MCP server status, tools, errors, and config paths.
 * Read-only; server configuration is managed via mcp.json files.
 */
import { ref, onMounted } from "vue";
import type { McpServerInfo, McpConfigInfo } from "../../../shared/types";

const loading = ref(true);
const servers = ref<McpServerInfo[]>([]);
const configInfo = ref<McpConfigInfo>({ configPaths: [], errors: [] });
const error = ref("");

const statusColor: Record<string, string> = {
  connected: "success",
  connecting: "warning",
  failed: "error",
  disconnected: "",
};

const statusLabel: Record<string, string> = {
  connected: "Connected",
  connecting: "Connecting",
  failed: "Failed",
  disconnected: "Disconnected",
};

async function load(): Promise<void> {
  loading.value = true;
  error.value = "";
  try {
    const [s, c] = await Promise.all([
      window.pixApi.mcpGetServers(),
      window.pixApi.mcpGetConfig(),
    ]);
    servers.value = s;
    configInfo.value = c;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

async function refresh(): Promise<void> {
  try {
    await window.pixApi.sendCommand({ type: "reload_resources" });
    // Wait briefly for MCP servers to reconnect
    await new Promise((r) => setTimeout(r, 500));
  } catch {
    // reload may throw if session not ready; that's ok
  }
  await load();
}

function truncatedStderr(stderr: string): string {
  const max = 2000;
  return stderr.length > max ? stderr.slice(-max) + "\n... (truncated)" : stderr;
}

onMounted(load);
</script>

<template>
  <div class="section-panel">
    <div class="d-flex align-center justify-space-between mb-4">
      <div>
        <h2 class="section-title">MCP Servers</h2>
        <p class="section-desc">
          Model Context Protocol server status and diagnostics.
          Configure servers by editing
          <code>~/.pi/agent/mcp.json</code> or <code>.mcp.json</code>.
        </p>
      </div>
      <v-btn
        variant="outlined"
        prepend-icon="mdi-refresh"
        :loading="loading"
        @click="refresh"
      >
        Refresh
      </v-btn>
    </div>

    <v-alert
      v-if="error"
      type="error"
      closable
      class="mb-4"
      density="compact"
    >
      {{ error }}
    </v-alert>

    <!-- Loading skeleton -->
    <div v-if="loading && servers.length === 0" class="mb-4">
      <v-skeleton-loader
        v-for="i in 2"
        :key="i"
        type="card"
        class="mb-3"
      />
    </div>

    <!-- No servers -->
    <v-alert
      v-else-if="servers.length === 0"
      type="info"
      density="compact"
      class="mb-4"
    >
      No MCP servers configured.
      Add server entries to <code>~/.pi/agent/mcp.json</code>
      or a project-level <code>.mcp.json</code> file.
    </v-alert>

    <!-- Server list -->
    <v-expansion-panels
      v-if="servers.length > 0"
      variant="accordion"
      class="mb-4"
    >
      <v-expansion-panel
        v-for="server in servers"
        :key="server.name"
      >
        <v-expansion-panel-title>
          <div class="d-flex align-center ga-3 flex-wrap">
            <span class="font-weight-medium">{{ server.name }}</span>
            <v-chip
              :color="statusColor[server.status]"
              :text="statusLabel[server.status]"
              size="x-small"
              label
            />
            <v-chip
              v-if="server.required"
              text="required"
              size="x-small"
              color="warning"
              variant="tonal"
            />
            <span class="text-caption text-medium-emphasis">
              {{ server.transport }} &middot; {{ server.toolCount }} tools
            </span>
          </div>
        </v-expansion-panel-title>

        <v-expansion-panel-text>
          <!-- Error -->
          <v-alert
            v-if="server.error"
            type="error"
            density="compact"
            class="mb-3"
          >
            {{ server.error }}
          </v-alert>

          <!-- Tools list -->
          <div class="mb-3">
            <div class="text-caption font-weight-bold text-medium-emphasis mb-1">
              Tools
            </div>
            <div v-if="server.tools.length === 0" class="text-caption text-medium-emphasis">
              No tools exposed
            </div>
            <div v-else class="d-flex flex-wrap ga-1">
              <v-chip
                v-for="tool in server.tools"
                :key="tool"
                :text="tool"
                size="x-small"
                variant="flat"
                color="tool-chip"
              />
            </div>
          </div>

          <!-- Stderr (stdio only) -->
          <div v-if="server.stderr">
            <div class="text-caption font-weight-bold text-medium-emphasis mb-1">
              Stderr
            </div>
            <pre class="stderr-block text-caption">{{ truncatedStderr(server.stderr) }}</pre>
          </div>
        </v-expansion-panel-text>
      </v-expansion-panel>
    </v-expansion-panels>

    <!-- Config paths -->
    <div class="mb-2">
      <div class="text-caption font-weight-bold text-medium-emphasis mb-1">
        Configuration Files
      </div>
      <div v-if="configInfo.configPaths.length === 0" class="text-caption text-medium-emphasis">
        No MCP config files found. Default search paths:
        <code>~/.pi/agent/mcp.json</code>,
        <code>.mcp.json</code>,
        <code>.pi/mcp.json</code>
      </div>
      <v-list v-else density="compact" bg-color="transparent" class="config-list">
        <v-list-item
          v-for="path in configInfo.configPaths"
          :key="path"
          :title="path"
          density="compact"
        >
          <template #prepend>
            <v-icon size="small" icon="mdi-file-cog-outline" />
          </template>
        </v-list-item>
      </v-list>
    </div>

    <!-- Global errors -->
    <v-alert
      v-for="(err, i) in configInfo.errors"
      :key="'cfg-err-' + i"
      type="warning"
      density="compact"
      class="mb-2"
    >
      {{ err }}
    </v-alert>
  </div>
</template>

<style scoped>
.stderr-block {
  background: rgb(var(--v-theme-surface-variant));
  padding: 8px 12px;
  border-radius: 4px;
  max-height: 200px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-all;
}

.config-list {
  border: 1px solid rgb(var(--v-theme-border-light));
  border-radius: 4px;
}
</style>
