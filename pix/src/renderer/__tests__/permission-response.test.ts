import { afterEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createVuetify, components, directives } from "vuetify/dist/vuetify.js";
import TeamProtocolPanel from "../components/team/TeamProtocolPanel.vue";

const team = vi.hoisted(() => ({
  pendingPermissions: [{ id: "permission-1", tool: "bash", reason: "执行本地命令", args: {} }],
  seats: [],
  lastError: "提交失败",
  respondPermission: vi.fn(),
}));
vi.mock("../stores/team-store", () => ({ useTeamStore: () => team }));
let wrapper: VueWrapper | undefined;
afterEach(() => { wrapper?.unmount(); vi.clearAllMocks(); });
function mountPanel(): VueWrapper {
  wrapper = mount(TeamProtocolPanel, { global: { plugins: [createVuetify({ components, directives })] } });
  return wrapper;
}

describe("permission response recovery", () => {
  it("keeps the request actionable after rejection by the transport", async () => {
    team.respondPermission.mockResolvedValue(false);
    const panel = mountPanel();
    await panel.findAll('button').find(button => button.text() === '允许')!.trigger('click');
    await flushPromises();
    expect(panel.get('[role="alert"]').text()).toBe('提交失败');
    expect(panel.get('[data-test="protocol-permission"]').text()).toContain('bash');
    expect(panel.findAll('button').every(button => button.attributes('disabled') === undefined)).toBe(true);
  });

  it("blocks repeated answers until the first response completes", async () => {
    let resolveResponse: (accepted: boolean) => void = () => {};
    team.respondPermission.mockReturnValue(new Promise<boolean>(resolve => { resolveResponse = resolve; }));
    const panel = mountPanel();
    const buttons = panel.findAll('button');
    await buttons[0].trigger('click');
    await buttons[1].trigger('click');
    expect(team.respondPermission).toHaveBeenCalledTimes(1);
    expect(team.respondPermission).toHaveBeenCalledWith('permission-1', true, undefined);
    resolveResponse(false);
    await flushPromises();
    await buttons[1].trigger('click');
    expect(team.respondPermission).toHaveBeenLastCalledWith('permission-1', false, '用户拒绝');
  });
});
