<script setup lang="ts">
/**
 * AgentMessageView - agent-message block, pure display (perf SDD §3.6/§4.3)
 *
 * Extracted from SessionView's inline agent-message branch so each block owns
 * its own render scope: with primitive-type props (content / isStreaming) Vue
 * skips re-rendering blocks whose props are unchanged, so marked runs only on
 * blocks whose content actually changed. The emitted DOM is identical to the
 * former inline branch (.agent-block > .agent-content.markdown-body + the
 * streaming class); the code-copy button keeps working through the
 * container-level click delegation on .session-view, so no events are wired
 * here. No store / rpc / block-object references — content strings only.
 */
import { computed } from "vue";
import { renderMarkdown } from "@/utils/markdown";

const props = defineProps<{
  content: string;
  isStreaming: boolean;
}>();

const html = computed(() => renderMarkdown(props.content));
</script>

<template>
  <div class="agent-block">
    <div
      class="agent-content markdown-body"
      :class="{ streaming: isStreaming }"
      v-html="html"
    ></div>
  </div>
</template>

<style scoped>
/* Mirrors the agent-block / agent-content rules that used to reach this DOM
   from SessionView's scoped styles (only the child's root node keeps the
   parent scope attribute, so the inner rules travel with the component). */
.agent-block {
  margin-bottom: var(--pix-space-lg);
  animation: block-in 0.18s ease-out;
}

.agent-content {
  font-size: var(--pix-text-base);
  line-height: var(--pix-leading-relaxed);
  color: #000000;
  max-width: 100%;
}

.agent-content :deep(p) { margin-bottom: var(--pix-space-sm); }
.agent-content :deep(p:last-child) { margin-bottom: 0; }
.agent-content :deep(ul), .agent-content :deep(ol) { margin: var(--pix-space-sm) 0; padding-left: var(--pix-space-xl); }
.agent-content :deep(li) { margin-bottom: var(--pix-space-xs); }
.agent-content :deep(h1), .agent-content :deep(h2), .agent-content :deep(h3), .agent-content :deep(h4) { margin: var(--pix-space-lg) 0 var(--pix-space-sm); font-weight: var(--pix-weight-semibold); line-height: var(--pix-leading-tight); }
.agent-content :deep(h1) { font-size: var(--pix-text-xl); }
.agent-content :deep(h2) { font-size: var(--pix-text-lg); }
.agent-content :deep(h3) { font-size: var(--pix-text-md); }
.agent-content :deep(h4) { font-size: var(--pix-text-base); }
.agent-content :deep(blockquote) { border-left: 3px solid var(--pix-border); padding-left: var(--pix-space-md); color: var(--pix-text-secondary); margin: var(--pix-space-md) 0; }
.agent-content :deep(table) { border-collapse: collapse; margin: var(--pix-space-md) 0; font-size: var(--pix-text-sm); width: 100%; }
.agent-content :deep(th), .agent-content :deep(td) { border: 1px solid var(--pix-border-light); padding: var(--pix-space-xs) var(--pix-space-md); text-align: left; }
.agent-content :deep(th) { background: var(--pix-bg-code); font-weight: var(--pix-weight-semibold); }
.agent-content :deep(hr) { border: none; border-top: 1px solid var(--pix-border-light); margin: var(--pix-space-lg) 0; }
.agent-content :deep(strong) { font-weight: var(--pix-weight-semibold); }
.agent-content :deep(a) { color: var(--pix-accent); }
.agent-content :deep(code) {
  font-size: 0.94em;
}
.agent-content :deep(.code-block) {
  position: relative;
  margin: var(--pix-space-md) 0;
}
.agent-content :deep(.code-block pre) {
  margin: 0;
  padding: var(--pix-space-lg);
  padding-top: 38px;
  background: #f7f8fc;
  border-color: var(--pix-border-light);
  color: #000000;
  font-size: var(--pix-text-sm);
  line-height: 1.65;
}
.agent-content :deep(.code-block code) {
  font-size: inherit;
  color: inherit;
}
.agent-content :deep(.code-copy-btn) {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: var(--pix-radius-md);
  background: #ffffff;
  border: 1px solid var(--pix-border);
  color: var(--pix-text-secondary);
  box-shadow: var(--pix-shadow-xs);
}
.agent-content :deep(.code-copy-btn:hover) {
  color: var(--pix-text-primary);
  background: var(--pix-accent-light);
}
.agent-content :deep(.code-copy-btn.copied) {
  color: var(--pix-success);
  border-color: #bbf7d0;
}

.agent-content.streaming :deep(p:last-child::after) {
  content: '';
  display: inline-block;
  width: 6px;
  height: 14px;
  background: var(--pix-accent);
  margin-left: 2px;
  vertical-align: text-bottom;
  animation: cursor-blink 1s step-end infinite;
}

@keyframes cursor-blink {
  50% { opacity: 0; }
}

@keyframes block-in {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
</style>
