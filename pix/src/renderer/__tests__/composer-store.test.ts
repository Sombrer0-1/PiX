/**
 * Composer draft store: per-session slots so switching session / project /
 * solo-team does not leak the previous input, while CenterPanel unmount
 * (task-center v-if) keeps the current slot.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useComposerStore } from "../stores/composer-store";

describe("composer draft store", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("keeps drafts isolated per session file", () => {
    const store = useComposerStore();
    store.bindSession("/proj/a.jsonl", "a");
    store.inputText = "draft-a";
    store.attachments = [{ path: "/a.txt", name: "a.txt" }];

    store.bindSession("/proj/b.jsonl", "b");
    expect(store.inputText).toBe("");
    expect(store.attachments).toEqual([]);
    store.inputText = "draft-b";

    store.bindSession("/proj/a.jsonl", "a");
    expect(store.inputText).toBe("draft-a");
    expect(store.attachments).toEqual([{ path: "/a.txt", name: "a.txt" }]);

    store.bindSession("/proj/b.jsonl", "b");
    expect(store.inputText).toBe("draft-b");
  });

  it("treats the same path with different separators as one slot", () => {
    const store = useComposerStore();
    store.bindSession("C:\\proj\\a.jsonl", "a");
    store.inputText = "win-path";
    store.bindSession("C:/proj/a.jsonl", "a");
    expect(store.inputText).toBe("win-path");
  });

  it("clearDraft only wipes the active slot", () => {
    const store = useComposerStore();
    store.bindSession("/proj/a.jsonl", "a");
    store.inputText = "keep-me";
    store.bindSession("/proj/b.jsonl", "b");
    store.inputText = "drop-me";
    store.clearDraft();
    expect(store.inputText).toBe("");

    store.bindSession("/proj/a.jsonl", "a");
    expect(store.inputText).toBe("keep-me");
  });

  it("does not snapshot an empty composer, so a send-then-switch cannot revive the old draft", () => {
    const store = useComposerStore();
    store.bindSession("/proj/a.jsonl", "a");
    store.inputText = "sent-already";
    store.attachments = [{ path: "/a.txt", name: "a.txt", base64: "QUJD" }];
    store.clearDraft();
    store.bindSession("/proj/b.jsonl", "b");
    store.bindSession("/proj/a.jsonl", "a");
    expect(store.inputText).toBe("");
    expect(store.attachments).toEqual([]);
  });

  it("evicts the oldest idle slot past 16 sessions", () => {
    const store = useComposerStore();
    for (let i = 0; i < 16; i++) {
      store.bindSession(`/proj/${i}.jsonl`, String(i));
      store.inputText = `draft-${i}`;
    }
    store.bindSession("/proj/16.jsonl", "16");
    store.inputText = "draft-16";
    store.bindSession("/proj/0.jsonl", "0");
    expect(store.inputText).toBe("");
    store.bindSession("/proj/1.jsonl", "1");
    expect(store.inputText).toBe("draft-1");
  });
});
