import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { components, createVuetify, directives } from 'vuetify/dist/vuetify.js';
import McpSettings from '../components/settings/McpSettings.vue';

const rpc = vi.hoisted(() => ({
  mcpGetServers: vi.fn(), mcpGetConfig: vi.fn(), reloadResources: vi.fn(),
}));
vi.mock('../composables/useWorkspaceRpc', () => ({
  useWorkspaceRpc: () => ({ ...rpc, isConnected: { value: true } }),
}));
let wrapper: VueWrapper | undefined;
afterEach(() => { wrapper?.unmount(); vi.resetAllMocks(); });

describe('MCP refresh', () => {
  it('refreshes server state even when runtime resource reloading fails', async () => {
    rpc.mcpGetServers.mockResolvedValue([]);
    rpc.mcpGetConfig.mockResolvedValue({ configPaths: [], errors: [] });
    rpc.reloadResources.mockRejectedValue(new Error('会话重建中'));
    wrapper = mount(McpSettings, { global: { plugins: [createVuetify({ components, directives })] } });
    await flushPromises();
    rpc.mcpGetServers.mockResolvedValue([{ name: 'refreshed-server', status: 'connected', transport: 'stdio', toolCount: 3, tools: [] }]);
    await wrapper.get('button').trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('重新加载失败：会话重建中');
    expect(wrapper.text()).toContain('refreshed-server');
    expect(wrapper.text()).toContain('3 个工具');
    expect(rpc.mcpGetServers).toHaveBeenCalledTimes(2);
  });
});
