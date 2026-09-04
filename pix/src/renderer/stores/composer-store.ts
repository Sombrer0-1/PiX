/**
 * Composer draft store (PiX): hoists the composer input text and attachments
 * out of CenterPanel so they survive component unmounts (route switches to
 * settings/home and back, and the v-if swaps that recreate the textarea:
 * task center, plan clarification). The textarea binds v-model; nothing
 * writes its DOM value imperatively, so the visible draft can never desync
 * from the state sendMessage reads (the old uncontrolled textarea came back
 * empty from a v-if swap while the ref still held text, which made the send
 * button fire the invisible draft).
 *
 * Drafts are keyed by session file (fallback: session id). Switching session,
 * project, or solo/team loads that slot; unmounting CenterPanel keeps the
 * current slot so a task-center v-if does not wipe the draft. inputText and
 * attachments stay plain refs so storeToRefs / v-model keep working.
 */
import { defineStore } from "pinia";
import { ref } from "vue";

export interface ChatAttachment {
  path: string;
  name: string;
  base64?: string;
  mimeType?: string;
}

interface ComposerDraft {
  inputText: string;
  attachments: ChatAttachment[];
}

function draftKey(sessionFile: string | undefined, sessionId: string | undefined): string {
  const file = (sessionFile ?? "").replace(/\\/g, "/").toLowerCase();
  if (file) return `file:${file}`;
  const id = (sessionId ?? "").trim();
  if (id) return `id:${id}`;
  return "empty";
}

const COMPOSER_DRAFT_MAX_SLOTS = 16;

export const useComposerStore = defineStore("composer", () => {
  const inputText = ref("");
  const attachments = ref<ChatAttachment[]>([]);
  const drafts = ref<Record<string, ComposerDraft>>({});
  const lruKeys = ref<string[]>([]);
  const activeKey = ref("empty");

  function touchKey(key: string): void {
    lruKeys.value = lruKeys.value.filter((item) => item !== key);
    lruKeys.value.push(key);
    while (lruKeys.value.length > COMPOSER_DRAFT_MAX_SLOTS) {
      const oldest = lruKeys.value.shift();
      if (oldest !== undefined && oldest !== activeKey.value) {
        delete drafts.value[oldest];
      }
    }
  }

  function snapshotActive(): void {
    const hasText = inputText.value.length > 0;
    const hasAttachments = attachments.value.length > 0;
    if (!hasText && !hasAttachments) {
      delete drafts.value[activeKey.value];
      lruKeys.value = lruKeys.value.filter((item) => item !== activeKey.value);
      return;
    }
    drafts.value[activeKey.value] = {
      inputText: inputText.value,
      attachments: [...attachments.value],
    };
    touchKey(activeKey.value);
  }

  function loadKey(key: string): void {
    const draft = drafts.value[key];
    inputText.value = draft?.inputText ?? "";
    attachments.value = draft ? [...draft.attachments] : [];
    if (draft) touchKey(key);
  }

  function bindSession(sessionFile: string | undefined, sessionId: string | undefined): void {
    const next = draftKey(sessionFile, sessionId);
    if (next === activeKey.value) return;
    snapshotActive();
    activeKey.value = next;
    loadKey(next);
  }

  function clearDraft(): void {
    inputText.value = "";
    attachments.value = [];
    delete drafts.value[activeKey.value];
    lruKeys.value = lruKeys.value.filter((item) => item !== activeKey.value);
  }

  return { inputText, attachments, bindSession, clearDraft };
});
