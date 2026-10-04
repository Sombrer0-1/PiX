import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import SessionView from '../components/session/SessionView.vue';
import type { DisplayBlock } from '../../shared/types';

vi.mock('../composables/useWorkspaceRpc', () => ({
  useWorkspaceRpc: () => ({ sessionState: { value: null }, availableModels: { value: [] } }),
}));
let wrapper: VueWrapper | undefined;
afterEach(() => { wrapper?.unmount(); });

function mountSession(blocks: DisplayBlock[], windowed = false) {
  wrapper = mount(SessionView, {
    props: { blocks, windowed },
    global: { stubs: { VIcon: true, MessageBlock: true, AgentMessageView: true, ThinkingBlock: true } },
  });
  return wrapper;
}

describe('session Agent headings', () => {
  it('does not create a new turn at a truncated window boundary', async () => {
    const blocks: DisplayBlock[] = Array.from({ length: 161 }, (_, index) => ({
      id: `agent-${index}`, type: 'agent-message', content: 'continued', isStreaming: false, timestamp: index,
    }));
    const session = mountSession(blocks, true);
    expect(session.find('.session-window-placeholder').exists()).toBe(true);
    expect(session.findAll('.agent-heading')).toHaveLength(0);
    const view = session.vm as unknown as { revealOlderWindow(): void };
    view.revealOlderWindow();
    await session.vm.$nextTick();
    expect(session.findAll('.agent-heading')).toHaveLength(0);
    view.revealOlderWindow();
    await session.vm.$nextTick();
    expect(session.findAll('.agent-heading')).toHaveLength(1);
  });

  it('recognizes a real turn whose user message is outside the visible window', () => {
    const blocks: DisplayBlock[] = Array.from({ length: 161 }, (_, index) => ({
      id: `agent-${index}`, type: 'agent-message', content: 'continued', isStreaming: false, timestamp: index,
    }));
    blocks[80] = { id: 'user', type: 'user-message', text: 'next turn', timestamp: 80 };
    expect(mountSession(blocks, true).findAll('.agent-heading')).toHaveLength(1);
  });

  it('adds one heading for a vision-led turn before thinking and text', () => {
    const session = mountSession([
      { id: 'user', type: 'user-message', text: 'image', timestamp: 1 },
      { id: 'vision', type: 'vision-status', provider: 'test', modelId: 'vision', imageCount: 1, status: 'success', timestamp: 2 },
      { id: 'thinking', type: 'thinking', content: 'thinking', phase: 'ended', superseded: true, timestamp: 3 },
      { id: 'answer', type: 'agent-message', content: 'answer', isStreaming: false, timestamp: 4 },
    ]);
    expect(session.findAll('.agent-heading')).toHaveLength(1);
    expect(session.get('.agent-heading').element.nextElementSibling?.classList.contains('vision-status-block')).toBe(true);
  });
});
