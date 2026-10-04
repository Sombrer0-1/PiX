import { describe, expect, it } from "vitest";
import { createRpcClient, type RpcTransport } from "../composables/useRpc";

function rejectedClient() {
  const transport: RpcTransport = {
    sendCommand: async () => ({ success: false, error: "配置写入失败" }),
    sendCommandAsync: async () => ({ success: false }),
    startRuntime: async () => ({ success: false }),
    stopRuntime: async () => ({ success: true }),
    isRuntimeRunning: async () => false,
    onEvent: () => () => {}, onReady: () => () => {}, onExit: () => () => {},
    onError: () => () => {}, onUserInputRequest: () => () => {},
    getBackgroundTasks: async () => [], stopBackgroundTask: async () => ({ found: false }),
    mcpGetServers: async () => [], mcpGetConfig: async () => ({ configPaths: [], errors: [] }),
    mcpListResources: async () => [], mcpReadResource: async () => ({ server: "", contents: [] }),
    setGuiSettings: async () => ({ success: true }), getExecutionEnvironment: async () => null,
  };
  return createRpcClient(transport, "settings-test");
}

describe("settings RPC failures", () => {
  it("rejects key saves instead of acknowledging a failed command", async () => {
    const rpc = rejectedClient();
    await expect(rpc.setApiKey('provider', 'test-key')).rejects.toThrow('配置写入失败');
    expect(rpc.lastError.value).toBe('配置写入失败');
  });
  it("rejects key removal failures", async () => {
    await expect(rejectedClient().removeAuth('provider')).rejects.toThrow('配置写入失败');
  });
  it("rejects resource reload failures", async () => {
    await expect(rejectedClient().reloadResources()).rejects.toThrow('配置写入失败');
  });
});
