import { afterEach, describe, expect, it } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { components, createVuetify, directives } from 'vuetify/dist/vuetify.js';
import type { TreeEntry } from '../types/rpc';
import SessionTreeItem from '../components/session/SessionTreeItem.vue';

let wrapper: VueWrapper | undefined;
afterEach(() => wrapper?.unmount());

const leaf: TreeEntry = {
  id: 'leaf', parentId: 'branch', type: 'message', messagePreview: '叶子消息', timestamp: '2026-10-04T08:00:00Z',
};
const branch: TreeEntry = {
  id: 'branch', parentId: 'root', type: 'message', label: '嵌套分支', timestamp: leaf.timestamp, children: [leaf],
};
const root: TreeEntry = {
  id: 'root', parentId: null, type: 'message', label: '根节点', timestamp: leaf.timestamp, children: [branch],
};

describe('compiled recursive session tree', () => {
  it('renders nested nodes and forwards child collapse without navigating', async () => {
    wrapper = mount(SessionTreeItem, {
      props: { node: root, depth: 0, expanded: new Set(['root', 'branch', 'leaf']) },
      global: { plugins: [createVuetify({ components, directives })] },
    });
    expect(wrapper.findAll('.tree-row')).toHaveLength(3);
    expect(wrapper.text()).toContain('叶子消息');
    await wrapper.get('button[aria-label="收起嵌套分支"]').trigger('click');
    expect(wrapper.emitted('toggle')).toEqual([['branch']]);
    expect(wrapper.emitted('navigate')).toBeUndefined();
    await wrapper.setProps({ expanded: new Set(['root']) });
    expect(wrapper.findAll('.tree-row')).toHaveLength(2);
    expect(wrapper.find('button[aria-label="展开嵌套分支"]').attributes('aria-expanded')).toBe('false');
  });

  it('forwards navigation from a nested leaf to the tree owner', async () => {
    wrapper = mount(SessionTreeItem, {
      props: { node: root, depth: 0, expanded: new Set(['root', 'branch', 'leaf']) },
      global: { plugins: [createVuetify({ components, directives })] },
    });
    await wrapper.findAll('.tree-row')[2].trigger('click');
    expect(wrapper.emitted('navigate')).toEqual([['leaf']]);
  });
});
