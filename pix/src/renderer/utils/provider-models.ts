/**
 * Custom-provider /models 拉取候选的合并逻辑（纯函数，供测试）。
 *
 * CustomProviders.vue 的「从 API 获取模型」：拉取结果先经 toCandidateRows
 * 标注「已存在 / 预勾选」（已配置的 id 默认不勾选且合并时跳过——与 dsh 一致，
 * 用户人工调过的行优先，绝不被拉取结果覆盖），确认后经 mergeFetchedModels
 * 按端点顺序追加进草稿模型列表。
 */
import type { FetchedProviderModel } from "@shared/custom-providers";

/** 候选行：拉取结果 + 勾选状态 + 是否已在当前草稿模型列表中。 */
export interface ModelCandidateRow extends FetchedProviderModel {
  /** 该 id 已配置：不可勾选，合并时跳过（保护人工调整过的配置）。 */
  exists: boolean;
  picked: boolean;
}

/**
 * 把拉取结果转成候选行：已配置的 id 标记 exists 且不预勾选，未配置的默认全勾。
 * existingIds 应传入当前草稿已配置的非空模型 id。重复 id 只保留首个（主进程
 * readListing 已去重，这里防御经 IPC 或未来路径混入的重复，兼作 v-for :key 保证）。
 */
export function toCandidateRows(models: readonly FetchedProviderModel[], existingIds: Iterable<string>): ModelCandidateRow[] {
  const known = new Set(existingIds);
  const seen = new Set<string>();
  const rows: ModelCandidateRow[] = [];
  for (const m of models) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    rows.push({ ...m, exists: known.has(m.id), picked: !known.has(m.id) });
  }
  return rows;
}

/**
 * 把勾选的候选合并进草稿模型列表（原地 push）：已存在行不动，未存在且勾选的
 * 按候选顺序追加；toRow 提供新行默认值（reasoning false、input ["text"] 等，
 * 与手动「添加模型」一致）。重复 id（勾选了两行同名 id 或与半填写的行撞 id）
 * 只落一行。
 * @returns 实际新增的行数。
 */
export function mergeFetchedModels<T extends { id: string }>(
  rows: T[],
  candidates: readonly ModelCandidateRow[],
  toRow: (candidate: ModelCandidateRow) => T,
): number {
  const known = new Set(rows.map((row) => row.id).filter((id) => id !== ""));
  let added = 0;
  for (const candidate of candidates) {
    if (!candidate.picked || candidate.exists || known.has(candidate.id)) continue;
    rows.push(toRow(candidate));
    known.add(candidate.id);
    added++;
  }
  return added;
}
