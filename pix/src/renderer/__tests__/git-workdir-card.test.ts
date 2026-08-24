/**
 * GitWorkdirCard / useGitStatus tests (PiX 1.5, stage S4A, SDD §4.3.6/§4.3.7).
 *
 * Acceptance: top-line format (branch / upstream / ahead-behind / detached /
 * empty repo / nested annotation), stats zero-value hiding, 100-item
 * truncation with the tail hint, complete=false degradation (stats line
 * replaced + fuzzy "100+" total), clean workdir, not-repository renders null,
 * stale marker keeps old data, first-failure error card (errorCode copy +
 * retry). useGitStatus logic: generation discard (a late old response never
 * overwrites the new one), result landing rules (unavailable keeps a
 * repository snapshot of the SAME project and marks stale; without one, or
 * when the snapshot belongs to a different project, it overwrites),
 * failure resets the 2s manual-refresh merge window so the error-card retry
 * is never swallowed, 2s manual-refresh merge with fake timers.
 *
 * The real project store runs on Pinia (window.pixApi stubbed) so the
 * currentProject.physicalPath watch is reactive; useWorkspaceRpc is mocked
 * with plain { value } objects per the repo's existing test pattern.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import type { PixApi } from "../../main/preload";
import type { GitChangedFile, GitWorkdirSnapshot } from "@shared/types";
import type { ProjectInfo } from "@/types/session";
import { useProjectStore } from "../stores/project-store";
import { useGitStatus } from "../composables/useGitStatus";
import GitWorkdirCard from "../components/git/GitWorkdirCard.vue";

// ============================================================================
// Mocks (module-level, hoisted)
// ============================================================================

const rpcMock = vi.hoisted(() => ({
  state: {
    sessionState: { value: null as { sessionId: string } | null },
    isStreaming: { value: false },
  },
}));

vi.mock("../composables/useWorkspaceRpc", () => ({
  useWorkspaceRpc: () => ({
    sessionState: rpcMock.state.sessionState,
    isStreaming: rpcMock.state.isStreaming,
  }),
}));

// ============================================================================
// Fixtures
// ============================================================================

const PROJECT: ProjectInfo = {
  path: "E:/projects/pi",
  physicalPath: "E:\\projects\\pi",
  name: "pi",
  environment: { kind: "windows" },
  lastOpened: 1,
  sessionCount: 0,
};

function makeFile(overrides?: Partial<GitChangedFile>): GitChangedFile {
  return {
    path: "src/foo.ts",
    staged: false,
    unstaged: false,
    untracked: false,
    conflict: false,
    renamed: false,
    deleted: false,
    additions: null,
    deletions: null,
    ...overrides,
  };
}

function makeSnapshot(overrides?: Partial<GitWorkdirSnapshot>): GitWorkdirSnapshot {
  return {
    kind: "repository",
    repositoryName: "pi",
    scopedToProject: false,
    branch: "master",
    upstream: { ref: "origin/master", ahead: 2, behind: 1 },
    counts: { staged: 1, unstaged: 2, untracked: 3, conflicts: 0, additions: 5, deletions: 3 },
    files: [],
    complete: true,
    observedAt: new Date(2026, 7, 23, 9, 5).getTime(),
    ...overrides,
  };
}

function zeroCounts() {
  return { staged: 0, unstaged: 0, untracked: 0, conflicts: 0, additions: 0, deletions: 0 };
}

// ============================================================================
// Harness: real project store + stubbed window.pixApi
// ============================================================================

let gitGetStatus: ReturnType<typeof vi.fn>;
let gitOpenFolder: ReturnType<typeof vi.fn>;
let wrapper: ReturnType<typeof mount> | undefined;
let pinia: ReturnType<typeof createPinia>;
let projectStore: ReturnType<typeof useProjectStore>;

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  projectStore = useProjectStore();
  gitGetStatus = vi.fn();
  gitOpenFolder = vi.fn();
  window.pixApi = { gitGetStatus, gitOpenFolder } as unknown as PixApi;
  rpcMock.state.sessionState.value = null;
  rpcMock.state.isStreaming.value = false;
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
  vi.useRealTimers();
});

function mountWithPinia(): ReturnType<typeof mount> {
  wrapper = mount(GitWorkdirCard, { global: { plugins: [pinia] } });
  return wrapper;
}

/** Flush the async fetch started by mount / watchers. */
async function settle(): Promise<void> {
  await flushPromises();
}

// ============================================================================
// Top line
// ============================================================================

describe("top line", () => {
  it("renders repository, branch, upstream with ahead/behind and observed time", async () => {
    projectStore.setCurrentProject(PROJECT);
    gitGetStatus.mockResolvedValue(makeSnapshot());
    mountWithPinia();
    await settle();

    expect(gitGetStatus).toHaveBeenCalledTimes(1);
    expect(wrapper!.find(".git-top-line").text()).toBe(
      "pi · master · origin/master · ahead 2 · behind 1 · 更新于 09:05",
    );
  });

  it("omits zero-width segments: no upstream, no ahead/behind", async () => {
    projectStore.setCurrentProject(PROJECT);
    gitGetStatus.mockResolvedValue(
      makeSnapshot({ upstream: undefined, counts: zeroCounts(), files: [] }),
    );
    mountWithPinia();
    await settle();

    expect(wrapper!.find(".git-top-line").text()).toBe("pi · master · 更新于 09:05");
  });

  it("shows a detached HEAD oid and the nested-repo annotation", async () => {
    projectStore.setCurrentProject(PROJECT);
    gitGetStatus.mockResolvedValue(
      makeSnapshot({
        branch: undefined,
        detachedHeadOid: "abc1234",
        scopedToProject: true,
        upstream: { ref: "origin/main", ahead: 0, behind: 0 },
        counts: zeroCounts(),
        files: [],
      }),
    );
    mountWithPinia();
    await settle();

    const text = wrapper!.find(".git-top-line").text();
    expect(text).toContain("pi（仅限项目目录）");
    expect(text).toContain("HEAD 于 abc1234");
    expect(text).not.toContain("master");
  });

  it("shows the empty-repo marker with a clean workdir", async () => {
    projectStore.setCurrentProject(PROJECT);
    gitGetStatus.mockResolvedValue(
      makeSnapshot({ branch: undefined, emptyRepo: true, counts: zeroCounts(), files: [] }),
    );
    mountWithPinia();
    await settle();

    expect(wrapper!.find(".git-top-line").text()).toContain("(空仓库)");
    expect(wrapper!.find(".git-clean").text()).toBe("工作区干净");
  });
});

// ============================================================================
// Stats line
// ============================================================================

describe("stats line", () => {
  it("hides zero-value items and shows +A/-D only when non-zero", async () => {
    projectStore.setCurrentProject(PROJECT);
    gitGetStatus.mockResolvedValue(
      makeSnapshot({
        counts: { staged: 1, unstaged: 0, untracked: 0, conflicts: 2, additions: 5, deletions: 3 },
        files: [makeFile({ staged: true, additions: 5, deletions: 3 })],
      }),
    );
    mountWithPinia();
    await settle();

    const stats = wrapper!.find(".git-stats").text();
    expect(stats).toContain("已暂存 1");
    expect(stats).toContain("冲突 2");
    expect(stats).toContain("+5/-3");
    expect(stats).not.toContain("未暂存");
    expect(stats).not.toContain("未跟踪");
  });

  it("replaces the whole stats line and fuzzes totals when complete=false", async () => {
    projectStore.setCurrentProject(PROJECT);
    const files = Array.from({ length: 120 }, (_, i) =>
      makeFile({ path: `src/mod-${String(i).padStart(3, "0")}.ts`, staged: true, additions: 1, deletions: 0 }),
    );
    gitGetStatus.mockResolvedValue(
      makeSnapshot({
        complete: false,
        counts: { staged: 120, unstaged: 0, untracked: 0, conflicts: 0, additions: 120, deletions: 0 },
        files,
      }),
    );
    mountWithPinia();
    await settle();

    expect(wrapper!.find(".git-stats").exists()).toBe(false);
    expect(wrapper!.find(".git-incomplete").text()).toBe("状态数据过大，结果不完整");
    expect(wrapper!.findAll(".git-file-row")).toHaveLength(100);
    expect(wrapper!.find(".git-more").text()).toBe("仅显示前 100 项，共 100+ 项");
  });
});

// ============================================================================
// File list
// ============================================================================

describe("file list", () => {
  it("truncates the list at 100 entries with an exact tail hint", async () => {
    projectStore.setCurrentProject(PROJECT);
    const files = Array.from({ length: 120 }, (_, i) =>
      makeFile({ path: `src/mod-${String(i).padStart(3, "0")}.ts`, staged: true, additions: 1, deletions: 0 }),
    );
    gitGetStatus.mockResolvedValue(makeSnapshot({ files }));
    mountWithPinia();
    await settle();

    expect(wrapper!.findAll(".git-file-row")).toHaveLength(100);
    expect(wrapper!.find(".git-more").text()).toBe("仅显示前 100 项，共 120 项");
  });

  it("renders chips (double staged/unstaged, conflict, deleted/renamed extras) and diff numbers", async () => {
    projectStore.setCurrentProject(PROJECT);
    const longPath =
      "very/long/directory/name/that/would/overflow/the/card/width/src/components/ModuleWithAReallyLongName.vue";
    gitGetStatus.mockResolvedValue(
      makeSnapshot({
        counts: { staged: 3, unstaged: 1, untracked: 1, conflicts: 1, additions: 2, deletions: 1 },
        files: [
          makeFile({ path: "a.txt", staged: true, unstaged: true, additions: 1, deletions: 0 }),
          makeFile({ path: "b.txt", conflict: true }),
          makeFile({ path: "c.txt", staged: true, deleted: true }),
          makeFile({ path: "d.txt", staged: true, renamed: true, origPath: "old.txt" }),
          makeFile({ path: "e.txt", untracked: true }),
          makeFile({ path: "bin.dat", additions: null, deletions: null }),
          makeFile({ path: longPath, unstaged: true, additions: 10, deletions: 2 }),
        ],
      }),
    );
    mountWithPinia();
    await settle();

    const rows = wrapper!.findAll(".git-file-row");
    const chipsOf = (row: Element): string[] =>
      Array.from(row.querySelectorAll(".git-chip")).map((c) => c.textContent ?? "");

    expect(chipsOf(rows[0].element)).toEqual(["已暂存", "未暂存"]);
    expect(chipsOf(rows[1].element)).toEqual(["冲突"]);
    expect(chipsOf(rows[2].element)).toEqual(["已暂存", "已删除"]);
    expect(chipsOf(rows[3].element)).toEqual(["已暂存", "重命名"]);
    expect(chipsOf(rows[4].element)).toEqual(["未跟踪"]);
    // Binary/unstatable → "—"; counted files right-aligned +N/-M.
    expect(rows[5].find(".git-file-diff").text()).toBe("—");
    expect(rows[6].find(".git-file-diff").text()).toBe("+10/-2");
    // Middle-truncated path with full-path tooltip.
    const pathCell = rows[6].find(".git-file-path");
    expect(pathCell.attributes("title")).toBe(longPath);
    expect(pathCell.text().length).toBeLessThan(longPath.length);
    expect(pathCell.text()).toContain("…");
    // Renamed rows keep the new path visible.
    expect(rows[3].find(".git-file-path").text()).toBe("d.txt");
  });
});

// ============================================================================
// Visibility: clean workdir / not-repository / no data
// ============================================================================

describe("visibility", () => {
  it("renders a clean workdir as repository line + 工作区干净", async () => {
    projectStore.setCurrentProject(PROJECT);
    gitGetStatus.mockResolvedValue(makeSnapshot({ counts: zeroCounts(), files: [] }));
    mountWithPinia();
    await settle();

    expect(wrapper!.find(".git-top-line").exists()).toBe(true);
    expect(wrapper!.find(".git-clean").text()).toBe("工作区干净");
    expect(wrapper!.find(".git-stats").exists()).toBe(false);
    expect(wrapper!.find(".git-file-list").exists()).toBe(false);
  });

  it("renders null for a not-repository snapshot (no placeholder)", async () => {
    projectStore.setCurrentProject(PROJECT);
    gitGetStatus.mockResolvedValue(makeSnapshot({ kind: "not-repository", files: [], complete: true }));
    mountWithPinia();
    await settle();

    expect(wrapper!.find(".info-card").exists()).toBe(false);
    expect(wrapper!.find(".git-card").exists()).toBe(false);
  });

  it("renders null while no snapshot has landed yet", async () => {
    projectStore.setCurrentProject(PROJECT);
    gitGetStatus.mockReturnValue(new Promise(() => {}));
    mountWithPinia();
    await settle();

    expect(wrapper!.find(".info-card").exists()).toBe(false);
  });
});

// ============================================================================
// Failure states
// ============================================================================

describe("failure states", () => {
  it("keeps the last repository data and marks 数据异常 when a same-project fetch is unavailable", async () => {
    projectStore.setCurrentProject(PROJECT);
    gitGetStatus
      .mockResolvedValueOnce(makeSnapshot({ branch: "main", upstream: { ref: "origin/main", ahead: 0, behind: 0 } }))
      .mockResolvedValueOnce(makeSnapshot({ kind: "unavailable", errorCode: "timeout", files: [], complete: false }));
    mountWithPinia();
    await settle();

    expect(wrapper!.find(".git-top-line").text()).toContain("main");
    expect(wrapper!.find(".git-stale-badge").exists()).toBe(false);

    // Same-project re-fetch (刷新按钮) unavailable → keep snapshot, mark stale.
    await wrapper!.findAll(".card-action-btn")[0].trigger("click");
    await settle();

    expect(gitGetStatus).toHaveBeenCalledTimes(2);
    expect(wrapper!.find(".git-stale-badge").text()).toBe("数据异常");
    expect(wrapper!.find(".git-top-line").text()).toContain("main");
    expect(wrapper!.find(".git-top-line").text()).toContain("更新于");
  });

  it("shows the error card (not the previous project's data) when a switched project's fetch is unavailable", async () => {
    projectStore.setCurrentProject(PROJECT);
    gitGetStatus
      .mockResolvedValueOnce(makeSnapshot({ branch: "main", upstream: { ref: "origin/main", ahead: 0, behind: 0 } }))
      .mockResolvedValueOnce(makeSnapshot({ kind: "unavailable", errorCode: "timeout", files: [], complete: false }));
    mountWithPinia();
    await settle();

    expect(wrapper!.find(".git-top-line").text()).toContain("main");

    // Project switch (physicalPath) triggers a re-fetch; the unavailable
    // result comes from a different project, so the old snapshot must NOT be
    // kept as stale — it is overwritten into the first-failure error card.
    projectStore.setCurrentProject({ ...PROJECT, path: "E:/projects/other", physicalPath: "E:\\projects\\other" });
    await settle();

    expect(gitGetStatus).toHaveBeenCalledTimes(2);
    expect(wrapper!.find(".git-stale-badge").exists()).toBe(false);
    expect(wrapper!.find(".git-top-line").exists()).toBe(false);
    expect(wrapper!.text()).toContain("Git 状态获取超时");
    expect(wrapper!.find(".git-retry-btn").exists()).toBe(true);
  });

  it("shows the first-failure error card with errorCode copy and a retry button", async () => {
    projectStore.setCurrentProject(PROJECT);
    gitGetStatus
      .mockResolvedValueOnce(makeSnapshot({ kind: "unavailable", errorCode: "git_not_found", files: [], complete: false }))
      .mockResolvedValueOnce(makeSnapshot());
    mountWithPinia();
    await settle();

    expect(wrapper!.text()).toContain("未检测到可用的 Git");
    const retry = wrapper!.find(".git-retry-btn");
    expect(retry.exists()).toBe(true);

    await retry.trigger("click");
    await settle();

    expect(gitGetStatus).toHaveBeenCalledTimes(2);
    expect(wrapper!.find(".git-top-line").exists()).toBe(true);
    expect(wrapper!.find(".git-error-text").exists()).toBe(false);
  });

  it("maps timeout and execution_failed error codes", async () => {
    projectStore.setCurrentProject(PROJECT);
    gitGetStatus.mockResolvedValue(makeSnapshot({ kind: "unavailable", errorCode: "timeout", files: [], complete: false }));
    mountWithPinia();
    await settle();
    expect(wrapper!.text()).toContain("Git 状态获取超时");
    wrapper!.unmount();

    gitGetStatus.mockResolvedValue(
      makeSnapshot({ kind: "unavailable", errorCode: "execution_failed", files: [], complete: false }),
    );
    mountWithPinia();
    await settle();
    expect(wrapper!.text()).toContain("Git 状态获取失败");
  });
});

// ============================================================================
// Actions / aria
// ============================================================================

describe("actions and aria", () => {
  it("exposes refresh and open-folder buttons with title/aria-label", async () => {
    projectStore.setCurrentProject(PROJECT);
    gitGetStatus.mockResolvedValue(makeSnapshot());
    mountWithPinia();
    await settle();

    const buttons = wrapper!.findAll(".card-action-btn");
    expect(buttons).toHaveLength(2);
    expect(buttons[0].attributes("title")).toBe("刷新");
    expect(buttons[0].attributes("aria-label")).toBe("刷新 Git 状态");
    expect(buttons[1].attributes("title")).toBe("在文件夹中打开");
    expect(buttons[1].attributes("aria-label")).toBe("在文件夹中打开");
  });

  it("opens the project folder through pixApi", async () => {
    projectStore.setCurrentProject(PROJECT);
    gitGetStatus.mockResolvedValue(makeSnapshot());
    gitOpenFolder.mockResolvedValue({ success: true });
    mountWithPinia();
    await settle();

    await wrapper!.findAll(".card-action-btn")[1].trigger("click");
    await settle();

    expect(gitOpenFolder).toHaveBeenCalledTimes(1);
    expect(gitOpenFolder.mock.calls[0][0]).toMatchObject({ physicalPath: PROJECT.physicalPath });
  });
});

// ============================================================================
// useGitStatus logic
// ============================================================================

describe("useGitStatus logic", () => {
  it("discards a late response from a previous fetch (generation guard)", async () => {
    projectStore.setCurrentProject(PROJECT);
    let resolveFirst!: (value: GitWorkdirSnapshot) => void;
    const first = new Promise<GitWorkdirSnapshot>((resolve) => {
      resolveFirst = resolve;
    });
    const second = Promise.resolve(makeSnapshot({ branch: "new-branch" }));
    gitGetStatus.mockReturnValueOnce(first).mockReturnValueOnce(second);

    const gs = useGitStatus();
    gs.notifyTrigger();
    gs.notifyTrigger();
    await settle();

    // The old fetch resolves late; its result must not overwrite the new one.
    resolveFirst(makeSnapshot({ branch: "old-branch" }));
    await settle();

    expect(gs.snapshot.value?.branch).toBe("new-branch");
    expect(gs.loading.value).toBe(false);
  });

  it("keeps a repository snapshot and marks stale when an unavailable result lands", async () => {
    projectStore.setCurrentProject(PROJECT);
    gitGetStatus
      .mockResolvedValueOnce(makeSnapshot({ branch: "main" }))
      .mockResolvedValueOnce(makeSnapshot({ kind: "unavailable", errorCode: "timeout", files: [], complete: false }));

    const gs = useGitStatus();
    gs.notifyTrigger();
    await settle();
    expect(gs.snapshot.value?.kind).toBe("repository");
    expect(gs.stale.value).toBe(false);

    gs.notifyTrigger();
    await settle();
    expect(gs.snapshot.value?.kind).toBe("repository");
    expect(gs.snapshot.value?.branch).toBe("main");
    expect(gs.stale.value).toBe(true);
  });

  it("overwrites with an unavailable result when no repository snapshot is held", async () => {
    projectStore.setCurrentProject(PROJECT);
    gitGetStatus.mockResolvedValue(makeSnapshot({ kind: "unavailable", errorCode: "git_not_found", files: [], complete: false }));

    const gs = useGitStatus();
    gs.notifyTrigger();
    await settle();
    expect(gs.snapshot.value?.kind).toBe("unavailable");
    expect(gs.stale.value).toBe(false);

    // A second unavailable result replaces the previous one, still not stale.
    gitGetStatus.mockResolvedValueOnce(makeSnapshot({ kind: "unavailable", errorCode: "timeout", files: [], complete: false }));
    gs.notifyTrigger();
    await settle();
    expect(gs.snapshot.value?.errorCode).toBe("timeout");
    expect(gs.stale.value).toBe(false);
  });

  it("overwrites the previous project's snapshot when the new project's fetch is unavailable", async () => {
    projectStore.setCurrentProject(PROJECT);
    gitGetStatus
      .mockResolvedValueOnce(makeSnapshot({ branch: "main" }))
      .mockResolvedValueOnce(makeSnapshot({ kind: "unavailable", errorCode: "timeout", files: [], complete: false }));

    const gs = useGitStatus();
    gs.notifyTrigger();
    await settle();
    expect(gs.snapshot.value?.branch).toBe("main");

    // 切到项目 B 后 B 采集失败：快照来源（项目 A）≠ 当前项目，旧快照不得
    // 保留为 stale，直接覆盖为 unavailable。
    projectStore.setCurrentProject({ ...PROJECT, path: "E:/projects/other", physicalPath: "E:\\projects\\other" });
    gs.notifyTrigger();
    await settle();
    expect(gs.snapshot.value?.kind).toBe("unavailable");
    expect(gs.snapshot.value?.errorCode).toBe("timeout");
    expect(gs.stale.value).toBe(false);

    // 切回项目 A 后成功恢复 → repository 快照，stale 仍为 false。
    projectStore.setCurrentProject(PROJECT);
    gitGetStatus.mockResolvedValueOnce(makeSnapshot({ branch: "main" }));
    gs.notifyTrigger();
    await settle();
    expect(gs.snapshot.value?.branch).toBe("main");
    expect(gs.stale.value).toBe(false);
  });

  it("lets a not-repository result overwrite a repository snapshot and clears stale", async () => {
    projectStore.setCurrentProject(PROJECT);
    gitGetStatus
      .mockResolvedValueOnce(makeSnapshot({ branch: "main" }))
      .mockResolvedValueOnce(makeSnapshot({ kind: "unavailable", errorCode: "timeout", files: [], complete: false }))
      .mockResolvedValueOnce(makeSnapshot({ kind: "not-repository", files: [], complete: true }));

    const gs = useGitStatus();
    gs.notifyTrigger();
    await settle();
    gs.notifyTrigger();
    await settle();
    expect(gs.stale.value).toBe(true);

    gs.notifyTrigger();
    await settle();
    expect(gs.snapshot.value?.kind).toBe("not-repository");
    expect(gs.stale.value).toBe(false);
  });

  it("does not fetch while no project is open", async () => {
    const gs = useGitStatus();
    gs.notifyTrigger();
    await settle();
    expect(gitGetStatus).not.toHaveBeenCalled();
  });
});

describe("useGitStatus manual refresh merge (fake timers)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("merges refresh clicks within 2s and allows the next one after the window", async () => {
    projectStore.setCurrentProject(PROJECT);
    gitGetStatus.mockResolvedValue(makeSnapshot());

    const gs = useGitStatus();
    gs.refresh();
    gs.refresh();
    gs.refresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(gitGetStatus).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2000);
    gs.refresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(gitGetStatus).toHaveBeenCalledTimes(2);
    expect(gs.snapshot.value?.kind).toBe("repository");
    expect(gs.loading.value).toBe(false);
  });

  it("does not apply the merge window to notifyTrigger", async () => {
    projectStore.setCurrentProject(PROJECT);
    gitGetStatus.mockResolvedValue(makeSnapshot());

    const gs = useGitStatus();
    gs.refresh();
    gs.notifyTrigger();
    await vi.advanceTimersByTimeAsync(0);
    expect(gitGetStatus).toHaveBeenCalledTimes(2);
  });

  it("lets a retry right after a failed refresh go through (unavailable resets the merge window)", async () => {
    projectStore.setCurrentProject(PROJECT);
    gitGetStatus
      .mockResolvedValueOnce(makeSnapshot({ kind: "unavailable", errorCode: "timeout", files: [], complete: false }))
      .mockResolvedValueOnce(makeSnapshot());

    const gs = useGitStatus();
    gs.refresh(); // 本次采集失败 → 合并窗口重置
    await vi.advanceTimersByTimeAsync(0);
    expect(gs.snapshot.value?.kind).toBe("unavailable");

    gs.refresh(); // 2s 内重试（等同错误卡「重试」按钮），不得被合并吞掉
    await vi.advanceTimersByTimeAsync(0);
    expect(gitGetStatus).toHaveBeenCalledTimes(2);
    expect(gs.snapshot.value?.kind).toBe("repository");
  });

  it("lets a retry right after a throwing fetch go through (exception resets the merge window)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      projectStore.setCurrentProject(PROJECT);
      gitGetStatus.mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce(makeSnapshot());

      const gs = useGitStatus();
      gs.refresh();
      await vi.advanceTimersByTimeAsync(0);
      expect(gs.snapshot.value).toBeNull();
      expect(gs.loading.value).toBe(false);

      gs.refresh(); // 2s 内重试：抛异常同样重置合并窗口
      await vi.advanceTimersByTimeAsync(0);
      expect(gitGetStatus).toHaveBeenCalledTimes(2);
      expect(gs.snapshot.value?.kind).toBe("repository");
    } finally {
      warn.mockRestore();
    }
  });
});
