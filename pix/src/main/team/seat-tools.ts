/**
 * 席位工具注册（plan §4.11）—— 圆桌席位能调用的全部工具，一个不多一个不少。
 *
 * 所有工具都经 `RoundtableToolHost`（§4.12b）回到 facade，这里不 import
 * TeamManager、不碰 session、不自己造时间线映射：
 * `send_team_message` 的 type 只由 `timelineTypeFromUtterance` 产生，
 * mentionIds 只由 seat-inbox 的 `parseMentions` 产生（S2a 实现，禁止再写一份）。
 *
 * 删除且不得再注册（§4.11）：`create_team_task` / `create_team_tasks` /
 * `assign_team_task` / `mark_task_complete`、任何 Leader 专属工具、
 * `<team-orchestrator-policy>`。
 *
 * `executionMode`：默认 "parallel"（§4.11）。只有写租约两条是真正协议
 * 顺序相关的：同一批次里 `claim_write_paths` 必须先于 `team_bash`/`edit`
 * 生效，否则租约校验会看到尚未登记的路径。标记为 sequential 会让整批工具
 * 按调用顺序执行（agent-loop 的既有语义），这正是写协议需要的。
 */

import { Type, type Static } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  USER_SEAT_ID,
  timelineTypeFromUtterance,
  type KnowledgeCard,
  type SeatInfo,
  type UtteranceKind,
} from "../../shared/team-types.js";
import { parseMentions } from "./seat-inbox.js";
import type { RoundtableToolHost, SendTeamMessageParams } from "./tool-host.js";

/** 席位工具名单（§4.11）。policy 的 `teamToolNames` 与 `tools` 白名单都用它。 */
export const SEAT_TOOL_NAMES: readonly string[] = [
  "send_team_message",
  "request_peer_explore",
  "claim_write_paths",
  "release_write_paths",
  "team_bash",
  "request_permission",
  "revise_deliverable",
  "stance_on_deliverable",
  "open_item",
  "claim_open_item",
  "resolve_open_item",
  "promote_thread",
  "request_exit",
];

/** 禁止注册的名字（§4.11 删除清单 + Leader 专属）。测试据此自检。 */
export const FORBIDDEN_SEAT_TOOL_NAMES: readonly string[] = [
  "create_team_task",
  "create_team_tasks",
  "assign_team_task",
  "mark_task_complete",
  "propose_task",
  "list_team_tasks",
  "update_task_status",
  "submit_plan",
  "respond_to_shutdown",
];

export interface RegisterSeatToolsArgs {
  seatId: string;
  host: RoundtableToolHost;
}

/**
 * 注意：union 的数组字面量必须在**调用点**写出来（这里用返回 union 的小函数
 * 兜住），不能放进共享的 `const X = [...]` 变量：TypeBox 靠上下文推断把数组
 * 字面量推成 tuple，变量一旦存在，tuple 信息就丢了，`Static<>` 会塌成 `never`
 * （文件底部的编译期自检会立刻抓到）。
 */
const STANCE_LITERALS = () =>
  Type.Union([Type.Literal("support"), Type.Literal("oppose"), Type.Literal("conditional")]);
const CONFIDENCE_LITERALS = () =>
  Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]);

/** §4.11 的 `knowledgeCard` 参数 = shared 的 KnowledgeCard（H16 依据规则）。 */
const KNOWLEDGE_CARD_SCHEMA = Type.Object({
  claim: Type.String({ description: "结论一句话。" }),
  claimKind: Type.Union([Type.Literal("evidenced"), Type.Literal("opinion")], {
    description: "给不出工作区路径/命令输出摘录/URL 三者之一时必须填 opinion（H16），禁止伪造依据。",
  }),
  confidence: CONFIDENCE_LITERALS(),
  evidence: Type.Array(
    Type.Object({
      kind: Type.Union([
        Type.Literal("path"),
        Type.Literal("command"),
        Type.Literal("url"),
        Type.Literal("timeline"),
      ]),
      ref: Type.String(),
      excerpt: Type.Optional(Type.String()),
    }),
  ),
  method: Type.Optional(Type.String()),
  uncertainty: Type.Optional(Type.String()),
});

/** 工具结果：`details` 就是 §4.11 写明的返回对象，正文给模型一份 JSON 文本。 */
function toolResult<T>(details: T): { content: Array<{ type: "text"; text: string }>; details: T } {
  return { content: [{ type: "text", text: JSON.stringify(details) }], details };
}

/**
 * 解析 `to`：展示名（精确，其次大小写不敏感）、seatId、slug、"*"、"user"。
 * 未命中返回错误文本，不猜。
 */
function resolveSeatTarget(
  to: string,
  seats: Record<string, SeatInfo>,
): { ok: true; target: string } | { ok: false; error: string } {
  const raw = to.trim();
  if (raw.length === 0) {
    return { ok: false, error: '`to` 不能为空：用展示名、seatId、"*" 或 "user"。' };
  }
  if (raw === "*" || raw === USER_SEAT_ID) {
    return { ok: true, target: raw };
  }
  const roster = Object.values(seats);
  const lowered = raw.toLowerCase();
  const seat =
    roster.find((candidate) => candidate.seatId === raw) ??
    roster.find((candidate) => candidate.name === raw) ??
    roster.find((candidate) => candidate.name.toLowerCase() === lowered) ??
    roster.find((candidate) => candidate.slug === raw) ??
    roster.find((candidate) => candidate.slug.toLowerCase() === lowered);
  if (seat !== undefined) {
    return { ok: true, target: seat.seatId };
  }
  const available = roster.map((candidate) => `${candidate.name}(${candidate.seatId})`).join("、");
  return { ok: false, error: `找不到收件席 "${to}"。可用：${available || "（无席位）"}、*、user。` };
}

/**
 * 注册一个席位的全部工具（§4.11）。返回 `customTools` 直接可用的定义数组。
 * 席位 session 必须用 `enableBuiltInEnhancementTools: false`（H29）与本清单的
 * `tools` 白名单（H35）一起创建。
 */
export function registerSeatTools(args: RegisterSeatToolsArgs): ToolDefinition[] {
  const { seatId, host } = args;

  return [
    // ---------------------------------------------------------------- 发言 --
    {
      name: "send_team_message",
      label: "Send roundtable message",
      description:
        "Speak to the roundtable: another seat, all seats, or the user. " +
        "This is the only channel other participants can see — plain assistant text is not delivered to anyone.",
      promptSnippet: "Use send_team_message to speak; nothing else is visible to the roundtable.",
      promptGuidelines: [
        'Use to="*" to speak to every seat; omit interrupt for a normal (L1) delivery.',
        "interrupt L2 interrupts another seat's current generation and must carry a public reason.",
        "Attach a knowledgeCard when you claim something is evidenced (H16).",
      ],
      parameters: Type.Object({
        to: Type.String({ description: '展示名、seatId、"*" 或 "user"。' }),
        text: Type.String({ description: "发言正文。" }),
        summary: Type.Optional(Type.String({ description: "一行摘要，供时间线 UI。" })),
        utteranceKind: Type.Optional(
          Type.Union(
            [
              Type.Literal("argument"),
              Type.Literal("note"),
              Type.Literal("knowledge_card"),
              Type.Literal("question"),
              Type.Literal("explore_result"),
              Type.Literal("challenge"),
            ],
            { description: "缺省 note。challenge 用 challenge；长论证用 argument。" },
          ),
        ),
        replyToId: Type.Optional(Type.String()),
        basedOnId: Type.Optional(Type.String()),
        interrupt: Type.Optional(Type.Union([Type.Literal("L1"), Type.Literal("L2")], {
          description: "缺省 L1；L2 会被预算与熔断限制，且必须给 reason。",
        })),
        reason: Type.Optional(Type.String({ description: "L2 的公开理由（必填）。" })),
        threadId: Type.Optional(Type.String()),
        knowledgeCard: Type.Optional(KNOWLEDGE_CARD_SCHEMA),
        private: Type.Optional(
          Type.Boolean({
            description:
              "席位之间禁止私聊（§5.15）：本参数恒为 false；传 true 会被直接拒绝且正文不落盘。",
          }),
        ),
      }),
      executionMode: "parallel" as const,
      execute: async (
        _toolCallId: string,
        params: {
          to: string;
          text: string;
          summary?: string;
          utteranceKind?: UtteranceKind;
          replyToId?: string;
          basedOnId?: string;
          interrupt?: "L1" | "L2";
          reason?: string;
          threadId?: string;
          knowledgeCard?: KnowledgeCard;
          private?: boolean;
        },
      ) => {
        // §5.15：席位之间 private → 工具返回错误且不落正文。
        if (params.private === true) {
          return toolResult({
            ok: false as const,
            error: "席位之间不能私密发言（private 只属于用户对单席）。请改用公开消息。",
          });
        }
        const interrupt = params.interrupt ?? "L1";
        const reason = params.reason?.trim() ?? "";
        if (interrupt === "L2" && reason.length === 0) {
          return toolResult({
            ok: false as const,
            error: "interrupt L2 必须给出公开理由（reason）。没有理由请用 L1。",
          });
        }
        const state = host.getState();
        if (state === null) {
          return toolResult({ ok: false as const, error: "当前没有活跃圆桌。" });
        }
        const resolved = resolveSeatTarget(params.to, state.seats);
        if (!resolved.ok) {
          return toolResult({ ok: false as const, error: resolved.error });
        }

        const utteranceKind: UtteranceKind = params.utteranceKind ?? "note";
        const roster = Object.values(state.seats);
        // H21：composer 的 to（具体席位）与正文 @ 取并集，顺序 = to 先、@ 后。
        const mentionIds: string[] = [];
        if (resolved.target !== "*" && resolved.target !== USER_SEAT_ID) {
          mentionIds.push(resolved.target);
        }
        for (const mentioned of parseMentions(params.text, roster)) {
          if (!mentionIds.includes(mentioned)) {
            mentionIds.push(mentioned);
          }
        }

        const payload: SendTeamMessageParams = {
          to: resolved.target,
          text: params.text,
          summary: params.summary,
          utteranceKind,
          type: timelineTypeFromUtterance(utteranceKind),
          replyToId: params.replyToId,
          basedOnId: params.basedOnId,
          interrupt,
          reason: reason.length > 0 ? reason : undefined,
          threadId: params.threadId,
          knowledgeCard: params.knowledgeCard,
          mentionIds,
        };
        const result = await host.postSeatMessage(seatId, payload);
        if (!result.ok) {
          return toolResult({ ok: false as const, error: result.error });
        }
        // H28：有序门收下 argument 时 queued=true（已记录，尚未进 inbox）。
        return toolResult(
          result.queued === true
            ? { ok: true as const, messageId: result.messageId, queued: true as const }
            : { ok: true as const, messageId: result.messageId },
        );
      },
    },

    {
      name: "request_peer_explore",
      label: "Request peer exploration",
      description:
        "Ask another seat to explore something. This is a peer request, not a work assignment: " +
        "that seat answers with send_team_message (accept, decline, or renegotiate the scope).",
      promptSnippet: "Use request_peer_explore to ask a peer to investigate something.",
      promptGuidelines: [
        "State exactly what you need verified and why it changes your conclusion.",
        "Peers are not obligated to accept; wait for their reply instead of assuming it.",
      ],
      parameters: Type.Object({
        to: Type.String({ description: '展示名、seatId 或 "*"。' }),
        ask: Type.String({ description: "请对方探索/核实的问题。" }),
        scope: Type.Optional(Type.String({ description: "建议范围（可选，对方可以改）。" })),
      }),
      executionMode: "parallel" as const,
      execute: async (_toolCallId: string, params: { to: string; ask: string; scope?: string }) => {
        const state = host.getState();
        if (state === null) {
          return toolResult({ ok: false as const, error: "当前没有活跃圆桌。" });
        }
        const resolved = resolveSeatTarget(params.to, state.seats);
        if (!resolved.ok) {
          return toolResult({ ok: false as const, error: resolved.error });
        }
        if (resolved.target === seatId || resolved.target === USER_SEAT_ID) {
          return toolResult({ ok: false as const, error: "对方必须是被点名的席位。" });
        }
        await host.requestPeerExplore(seatId, resolved.target, params.ask, params.scope);
        return toolResult({ ok: true as const });
      },
    },

    // -------------------------------------------------------------- 写租约 --
    {
      name: "claim_write_paths",
      label: "Claim write paths",
      description:
        "Claim the write lease for one or more workspace paths before editing them. " +
        "Another seat holding the same path blocks the claim; read a path another seat holds and you must re-read it before writing.",
      promptSnippet: "Use claim_write_paths before writing; paths must be leased before edit/write/team_bash.",
      promptGuidelines: [
        "Claim every path you are about to change, one call, before the change.",
        "If a claim fails, do not write: talk to the owner or pick another path.",
      ],
      parameters: Type.Object({
        paths: Type.Array(Type.String(), { description: "要申请的路径（相对 cwd 或绝对）。" }),
      }),
      // 协议顺序：同批次里 claim 必须先于 team_bash/edit 生效。
      executionMode: "sequential" as const,
      execute: async (_toolCallId: string, params: { paths: string[] }) => {
        const auth = host.getState()?.seats[seatId]?.auth;
        if (auth !== "write") {
          return toolResult({ ok: false as const, error: "只有可写档可以申请写租约。" });
        }
        return toolResult(host.claimWritePaths(seatId, params.paths));
      },
    },

    {
      name: "release_write_paths",
      label: "Release write paths",
      description: "Release write leases you hold. Without paths, every lease of this seat is released.",
      promptSnippet: "Use release_write_paths when you are done writing.",
      promptGuidelines: ["Release as soon as you no longer need the path so peers stop waiting."],
      parameters: Type.Object({
        paths: Type.Optional(Type.Array(Type.String(), { description: "缺省 = 释放本席全部租约。" })),
      }),
      executionMode: "sequential" as const,
      execute: async (_toolCallId: string, params: { paths?: string[] }) => {
        host.releaseWritePaths(seatId, params.paths);
        return toolResult({ ok: true as const });
      },
    },

    // ---------------------------------------------------------------- shell --
    {
      name: "team_bash",
      label: "Run shell command (roundtable)",
      description:
        "Run a shell command inside the workspace. This replaces the built-in bash for roundtable seats. " +
        "The write tier must list every path the command touches in `paths`, and all of them must already be leased to this seat.",
      promptSnippet: "Use team_bash for shell commands; the built-in bash is not available to seats.",
      promptGuidelines: [
        "Never assume a write: pass `paths` for every file the command may modify, leased first.",
        "Read-only exploration is usually done with read/grep/find/ls instead of shell.",
      ],
      parameters: Type.Object({
        command: Type.String({ description: "Bash command to execute." }),
        paths: Type.Optional(
          Type.Array(Type.String(), {
            description: "本次命令会触及的路径（write 档必填且必须全部已持约）。",
          }),
        ),
        timeout: Type.Optional(Type.Number({ description: "超时秒数（默认 120，0 = 不限）。" })),
      }),
      executionMode: "parallel" as const,
      execute: async (
        _toolCallId: string,
        params: { command: string; paths?: string[]; timeout?: number },
        signal?: AbortSignal,
      ) => {
        // host 契约里 signal 是必填：execute 没给信号时用一条永不 abort 的信号。
        const effectiveSignal = signal ?? new AbortController().signal;
        try {
          const output = await host.runTeamBash(
            seatId,
            params.command,
            params.paths,
            params.timeout,
            effectiveSignal,
          );
          if (output.exitCode !== 0 && output.exitCode !== null) {
            return toolResult({
              ok: false as const,
              exitCode: output.exitCode,
              stdout: output.stdout,
              stderr: output.stderr,
            });
          }
          return toolResult({ ok: true as const, stdout: output.stdout, stderr: output.stderr });
        } catch (error) {
          return toolResult({ ok: false as const, error: errorMessage(error) });
        }
      },
    },

    // ---------------------------------------------------------------- 权限 --
    {
      name: "request_permission",
      label: "Request permission",
      description:
        "Ask the user to approve something the seat policy refused. Returns immediately: the request is recorded " +
        "and the answer is delivered into your inbox later. Never wait for it — continue or explore instead.",
      promptSnippet: "Use request_permission to ask the user; it returns immediately.",
      promptGuidelines: [
        "Explain the exact operation you want to perform and why it is needed.",
        "Do not retry the blocked operation in this turn; the answer arrives as an inbox message.",
      ],
      parameters: Type.Object({
        tool: Type.String({ description: "被拒绝的工具名。" }),
        args: Type.Optional(Type.Record(Type.String(), Type.Unknown(), {
          description: "该工具的计划参数（供用户判断）。",
        })),
        reason: Type.Optional(Type.String({ description: "为什么需要这次授权。" })),
      }),
      executionMode: "parallel" as const,
      // H23：同步记录并返回 submitted，绝不 await 用户。
      execute: (_toolCallId: string, params: { tool: string; args?: Record<string, unknown>; reason?: string }) => {
        const submitted = host.requestPermission(seatId, params.tool, params.args ?? {}, params.reason);
        return Promise.resolve(
          toolResult({ ok: true as const, requestId: submitted.requestId, submitted: true as const }),
        );
      },
    },

    // -------------------------------------------------------------- 交付物 --
    {
      name: "revise_deliverable",
      label: "Revise deliverable",
      description:
        "Submit a revised version of a deliverable. If another seat revised it first the call fails with the current " +
        "version and revision instead of overwriting: rebase on that version and submit again.",
      promptSnippet: "Use revise_deliverable to publish an updated deliverable version.",
      promptGuidelines: [
        "On conflict, read the current version and rebase on currentRevision; never overwrite silently.",
      ],
      parameters: Type.Object({
        id: Type.String({ description: "交付物 id。" }),
        markdown: Type.String({ description: "完整的新版本 Markdown。" }),
        expectedRevision: Type.Number({ description: "读到的该版 revision（CAS 令牌）。冲突时用返回的 currentRevision 重投。" }),
      }),
      executionMode: "parallel" as const,
      execute: async (_toolCallId: string, params: { id: string; markdown: string; expectedRevision: number }) => {
        const result = host.reviseDeliverable(params.id, params.markdown, seatId, params.expectedRevision);
        // F2-3：冲突结果原样回给模型（含 currentVersion / currentRevision），它据此
        // 确认自己写的是哪一版、再基于最新 revision 重投。
        return toolResult(
          result.ok ? { ok: true as const } : { ...result, ok: false as const, conflict: true as const },
        );
      },
    },

    {
      name: "stance_on_deliverable",
      label: "Take a stance",
      description: "Record your stance on a deliverable version: support, oppose, or conditional.",
      promptSnippet: "Use stance_on_deliverable to record agreement or objection.",
      promptGuidelines: ["Give a reason when you oppose or attach conditions."],
      parameters: Type.Object({
        id: Type.String({ description: "交付物 id。" }),
        stance: STANCE_LITERALS(),
        reason: Type.Optional(Type.String()),
        confidence: Type.Optional(CONFIDENCE_LITERALS()),
      }),
      executionMode: "parallel" as const,
      execute: async (
        _toolCallId: string,
        params: {
          id: string;
          stance: "support" | "oppose" | "conditional";
          reason?: string;
          confidence?: "low" | "medium" | "high";
        },
      ) => {
        return toolResult(
          host.stanceOnDeliverable(params.id, seatId, params.stance, params.reason, params.confidence),
        );
      },
    },

    // -------------------------------------------------------------- 未决项 --
    {
      name: "open_item",
      label: "Open item",
      description:
        "Record an open question that must not be forgotten. Open items are not tasks: nobody is assigned, " +
        "any seat may claim one to work on it.",
      promptSnippet: "Use open_item for unresolved questions the roundtable must come back to.",
      promptGuidelines: ["Write the subject as a question that can be resolved or dropped."],
      parameters: Type.Object({
        subject: Type.String({ description: "未决问题一句话。" }),
        body: Type.String({ description: "背景、为什么未决、需要什么才能决。" }),
      }),
      executionMode: "parallel" as const,
      execute: async (_toolCallId: string, params: { subject: string; body: string }) => {
        const item = host.openItem(seatId, params.subject, params.body);
        return toolResult({ ok: true as const, id: item.id });
      },
    },

    {
      name: "claim_open_item",
      label: "Claim open item",
      description: "Volunteer to work on an open item. Claiming is voluntary: the system never assigns open items.",
      promptSnippet: "Use claim_open_item to take an unresolved question voluntarily.",
      promptGuidelines: ["Claim only what you will actually investigate this session."],
      parameters: Type.Object({
        id: Type.String({ description: "未决项 id。" }),
        note: Type.Optional(Type.String({ description: "打算怎么查（可选）。" })),
      }),
      executionMode: "parallel" as const,
      execute: async (_toolCallId: string, params: { id: string; note?: string }) => {
        const item = host.claimOpenItem(seatId, params.id, params.note);
        if (item === null) {
          return toolResult({ ok: false as const, error: `未决项 ${params.id} 不存在或已被他人认领。` });
        }
        return toolResult({ ok: true as const });
      },
    },

    {
      name: "resolve_open_item",
      label: "Resolve open item",
      description: "Mark an open item as resolved, with the conclusion.",
      promptSnippet: "Use resolve_open_item when the question is answered.",
      promptGuidelines: ["Say what resolved it (evidence beats opinion)."],
      parameters: Type.Object({
        id: Type.String({ description: "未决项 id。" }),
        note: Type.Optional(Type.String({ description: "结论/依据。" })),
      }),
      executionMode: "parallel" as const,
      execute: async (_toolCallId: string, params: { id: string; note?: string }) => {
        const item = host.resolveOpenItem(seatId, params.id, params.note);
        if (item === null) {
          return toolResult({ ok: false as const, error: `未决项 ${params.id} 不存在或已解决。` });
        }
        return toolResult({ ok: true as const });
      },
    },

    {
      name: "promote_thread",
      label: "Promote thread",
      description:
        "Promote a side thread's conclusion back to the main line so every seat sees it without reading the whole thread.",
      promptSnippet: "Use promote_thread to bring a thread conclusion back to the main line.",
      promptGuidelines: ["Summarize the conclusion; do not paste the whole thread."],
      parameters: Type.Object({
        threadId: Type.String({ description: "线程 id。" }),
        conclusion: Type.String({ description: "带回主线的结论。" }),
      }),
      executionMode: "parallel" as const,
      execute: async (_toolCallId: string, params: { threadId: string; conclusion: string }) => {
        const item = host.promoteThread(seatId, params.threadId, params.conclusion);
        return toolResult({ ok: true as const, messageId: item.id });
      },
    },

    // ---------------------------------------------------------------- 退出 --
    {
      name: "request_exit",
      label: "Request exit",
      description:
        "Leave the roundtable (no target), or ask another seat to leave (targetSeatId). " +
        "Leaving yourself is immediate; asking a peer opens a negotiation that records both statements before it takes effect.",
      promptSnippet: "Use request_exit to leave, or to ask a peer to wrap up and leave.",
      promptGuidelines: [
        "Give a concrete reason: what is settled, what is left, why you should go.",
        "A peer exit takes effect only after the negotiation timeout; the discussion keeps going meanwhile.",
      ],
      parameters: Type.Object({
        targetSeatId: Type.Optional(Type.String({ description: "缺省 = 自己退出。" })),
        reason: Type.String({ description: "退出理由（必填，进入双方说法）。" }),
      }),
      executionMode: "parallel" as const,
      execute: async (_toolCallId: string, params: { targetSeatId?: string; reason: string }) => {
        const state = host.getState();
        if (state === null) {
          return toolResult({ ok: false as const, error: "当前没有活跃圆桌。" });
        }
        let target = params.targetSeatId;
        if (target !== undefined) {
          const resolved = resolveSeatTarget(target, state.seats);
          if (!resolved.ok) {
            return toolResult({ ok: false as const, error: resolved.error });
          }
          if (resolved.target === USER_SEAT_ID || resolved.target === "*") {
            return toolResult({ ok: false as const, error: "只能请一个具体席位退出。" });
          }
          target = resolved.target;
        }
        await host.requestExit(seatId, target, params.reason);
        return toolResult({ ok: true as const });
      },
    },
  ];
}

/** 工具执行抛错时的错误文本（不吞异常类型，只取 message）。 */
function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/**
 * 编译期自检：`knowledgeCard` schema 的静态形状必须能直接当作 shared 的
 * KnowledgeCard 用（H16 的依据字段不允许两套形状）。schema 与共享类型漂移时
 * 这一行会报错。
 */
type KnowledgeCardSchemaShape = Static<typeof KNOWLEDGE_CARD_SCHEMA>;
const KNOWLEDGE_CARD_SCHEMA_MATCHES_SHARED: KnowledgeCardSchemaShape = {
  claim: "",
  claimKind: "opinion",
  confidence: "low",
  evidence: [],
};
const KNOWLEDGE_CARD_SCHEMA_AS_SHARED: KnowledgeCard = KNOWLEDGE_CARD_SCHEMA_MATCHES_SHARED;
void KNOWLEDGE_CARD_SCHEMA_AS_SHARED;
