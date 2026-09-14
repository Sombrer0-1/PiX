/**
 * RoundtableRoster —— 席位名册（plan §3.3 / §4.1 / 附录 A，H1 / H25 / H26）。
 *
 * 席位是「展示名 + 视角 + 模型 + 授权」，不是工种枚举。默认档位：
 * 精简 3 = 前三模板；标准 5 = 五个模板；深度 8 / 攻坚 12 = 五个模板 + 「视角 N」占位
 * （占位席走 `allocateSeatSlug`：「视角 1」→ `1`，冲突则 `seat-2`…）。
 *
 * 硬规则：
 * - `seatId = `${slug}::${roundtableId}``，slug 永不空（H25）。展示名可以重名改，
 *   slug 绝不随展示名重算。
 * - 活跃席展示名必须唯一：`createFrom` / `add` 遇到重复展示名抛错（H25）。
 *   已退出席位不参与唯一性（同名席位可以重新加入）。
 * - 颜色按创建顺序从 `team/ids.ts` 的调色板取，确定性（同一名册总是同一套色）。
 * - 席位硬上限 12（H1），用户不占名额。
 */

import {
  MAX_SEATS,
  MIN_SEATS,
  PERSPECTIVE_TEMPLATES,
  ROUNDTABLE_TIER_SEATS,
  type RoundtableTier,
  type SeatConfig,
  type SeatInfo,
  type SeatRuntimeStatus,
  type ToolAuthTier,
} from "../../shared/team-types.js";
import { allocateSeatSlug, formatSeatId, pickSeatColor } from "./ids.js";

/** 占位席的展示名前缀（模板用完后继续加席）。 */
const PLACEHOLDER_NAME_PREFIX = "视角 ";

/** 默认只读授权（附录 A：默认 `read_only`）。 */
const DEFAULT_AUTH: ToolAuthTier = "read_only";

/**
 * 某档位的默认席位配置（附录 A）：
 * 前 N 个（≤5）取模板，超出部分用「视角 N」占位。slugs 由名册在创建时分配。
 */
export function defaultSeatConfigs(tier: RoundtableTier): SeatConfig[] {
  const count = ROUNDTABLE_TIER_SEATS[tier];
  const configs: SeatConfig[] = [];
  for (let index = 0; index < count; index++) {
    const template = PERSPECTIVE_TEMPLATES[index];
    if (template !== undefined) {
      configs.push({ name: template.label, perspective: template.prompt, auth: DEFAULT_AUTH });
      continue;
    }
    const placeholderIndex = index - PERSPECTIVE_TEMPLATES.length + 1;
    configs.push({
      name: `${PLACEHOLDER_NAME_PREFIX}${placeholderIndex}`,
      perspective: `自定义视角占位席 ${placeholderIndex}：按议题需要自行确定关注点，并与已有视角错开。`,
      auth: DEFAULT_AUTH,
    });
  }
  return configs;
}

/** 席位状态补充信息（error / currentActivity）。 */
export interface SeatStatusUpdate {
  currentActivity?: string;
  error?: string;
}

export class RoundtableRoster {
  readonly roundtableId: string;
  tier: RoundtableTier;
  private readonly seats = new Map<string, SeatInfo>();

  constructor(roundtableId: string, tier: RoundtableTier) {
    this.roundtableId = roundtableId;
    this.tier = tier;
  }

  /** 当前活跃（未退出）席位数。 */
  get size(): number {
    return this.list().length;
  }

  /** 用配置建名册（create 时唯一入口）。数量必须在 3–12 之间。 */
  createFrom(configs: SeatConfig[]): SeatInfo[] {
    if (configs.length < MIN_SEATS || configs.length > MAX_SEATS) {
      throw new Error(`圆桌席位数量必须在 ${MIN_SEATS}–${MAX_SEATS} 之间，收到 ${configs.length}。`);
    }
    this.seats.clear();
    const created: SeatInfo[] = [];
    for (const config of configs) {
      created.push(this.add(config));
    }
    return created;
  }

  /**
   * 追加一个席位。展示名与已有活跃席重复则抛错（H25），超过 12 席抛错（H1）。
   * slug：模板 id（若展示名命中模板 label）或 `allocateSeatSlug`。
   */
  add(config: SeatConfig): SeatInfo {
    const name = config.name.trim();
    if (name.length === 0) {
      throw new Error("席位展示名不能为空。");
    }
    this.assertDisplayNameFree(name);

    if (this.size >= MAX_SEATS) {
      throw new Error(`席位已达上限 ${MAX_SEATS}（用户不占名额）。`);
    }

    const used = new Set([...this.seats.values()].map((seat) => seat.slug));
    const template = PERSPECTIVE_TEMPLATES.find((candidate) => candidate.label === name);
    // 模板席 slug = 模板 id；自定义/占位席走 allocateSeatSlug（「视角 1」→「1」）。
    const slug = template !== undefined && !used.has(template.id)
      ? template.id
      : allocateSeatSlug(name, used);

    const now = Date.now();
    const seat: SeatInfo = {
      seatId: formatSeatId(slug, this.roundtableId),
      slug,
      name,
      perspective: config.perspective,
      model: config.model,
      auth: config.auth,
      pathAllowlist: config.pathAllowlist,
      readonlyCommandAllowlist: config.readonlyCommandAllowlist,
      bashEnabled: config.bashEnabled,
      color: pickSeatColor(this.seats.size),
      status: "idle",
      createdAt: now,
      statusChangedAt: now,
    };
    this.seats.set(seat.seatId, seat);
    return { ...seat };
  }

  /** 移除席位：状态置 exited，记录保留（时间线里的 seatId 仍然指向它）。 */
  remove(seatId: string): SeatInfo | null {
    const seat = this.seats.get(seatId);
    if (seat === undefined) {
      return null;
    }
    seat.status = "exited";
    seat.statusChangedAt = Date.now();
    seat.currentActivity = undefined;
    return { ...seat };
  }

  /** 任意席位（含已退出）。 */
  get(seatId: string): SeatInfo | undefined {
    const seat = this.seats.get(seatId);
    return seat === undefined ? undefined : { ...seat };
  }

  /** 未退出席位，创建顺序。 */
  list(): SeatInfo[] {
    return [...this.seats.values()].filter((seat) => seat.status !== "exited").map((seat) => ({ ...seat }));
  }

  /** 全部席位（含已退出），创建顺序。 */
  all(): SeatInfo[] {
    return [...this.seats.values()].map((seat) => ({ ...seat }));
  }

  /** 未退出席位的 seatId（广播目标、容量池用）。 */
  activeIds(): string[] {
    return [...this.seats.values()].filter((seat) => seat.status !== "exited").map((seat) => seat.seatId);
  }

  /** 未退出席位的 slug → seatId 查询（`parseMentions` 之外的快捷方式）。 */
  isActive(seatId: string): boolean {
    const seat = this.seats.get(seatId);
    return seat !== undefined && seat.status !== "exited";
  }

  setStatus(seatId: string, status: SeatRuntimeStatus, update: SeatStatusUpdate = {}): SeatInfo | null {
    const seat = this.seats.get(seatId);
    if (seat === undefined) {
      return null;
    }
    seat.status = status;
    seat.statusChangedAt = Date.now();
    seat.currentActivity = update.currentActivity;
    seat.error = status === "error" ? update.error : undefined;
    return { ...seat };
  }

  /** 只更新当前动作文本，不改状态（工具在跑时的「正在做什么」）。 */
  setActivity(seatId: string, activity: string | undefined): void {
    const seat = this.seats.get(seatId);
    if (seat !== undefined) {
      seat.currentActivity = activity;
    }
  }

  /** 记录一次「席位有活动」（健康检查的卡死判定输入）。 */
  touch(seatId: string, at: number = Date.now()): void {
    const seat = this.seats.get(seatId);
    if (seat !== undefined) {
      seat.lastActiveAt = at;
    }
  }

  /** 记录一次公开发言（有序门「最久未发言优先」的排序输入）。 */
  markSpoke(seatId: string, at: number = Date.now()): void {
    const seat = this.seats.get(seatId);
    if (seat !== undefined) {
      seat.lastSpokeAt = at;
    }
  }

  /** 降档：只改名册里的模型标记（真正的模型切换在 session 上，见 H24）。 */
  setModel(seatId: string, model: string | undefined): SeatInfo | null {
    const seat = this.seats.get(seatId);
    if (seat === undefined) {
      return null;
    }
    seat.model = model;
    return { ...seat };
  }

  /** 改授权（讨论中可改；受限档的路径白名单一起更新）。 */
  updateAuth(seatId: string, auth: ToolAuthTier, pathAllowlist?: string[]): SeatInfo | null {
    const seat = this.seats.get(seatId);
    if (seat === undefined) {
      return null;
    }
    seat.auth = auth;
    if (pathAllowlist !== undefined) {
      seat.pathAllowlist = [...pathAllowlist];
    }
    return { ...seat };
  }

  /** 落盘/投影用快照（含已退出席位）。 */
  snapshot(): Record<string, SeatInfo> {
    const out: Record<string, SeatInfo> = {};
    for (const [seatId, seat] of this.seats) {
      out[seatId] = { ...seat };
    }
    return out;
  }

  /** 崩溃恢复：用快照重建（颜色/状态原样回来，不改写）。 */
  restore(seats: Record<string, SeatInfo>): void {
    this.seats.clear();
    for (const [seatId, seat] of Object.entries(seats)) {
      this.seats.set(seatId, { ...seat });
    }
  }

  /** 展示名唯一性（H25）：活跃席之间不允许重复。 */
  private assertDisplayNameFree(name: string): void {
    const duplicate = this.list().find((seat) => seat.name === name);
    if (duplicate !== undefined) {
      throw new Error(`席位展示名「${name}」已被 ${duplicate.seatId} 使用：活跃席展示名必须唯一。`);
    }
  }
}
