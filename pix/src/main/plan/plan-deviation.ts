/**
 * Plan semantic validation and deviation detection (PiX-1.4-PLAN.md §4.3).
 *
 * Structural guards stay in shared/plan-types.ts; this module owns the
 * workspace / DAG / version semantics that need the project location and the
 * execution backend:
 * - validatePlanDraft: field-level validation of the model-submitted draft
 *   (file scope containment, dependency DAG, 1.4.0 version gate).
 * - canonicalizeLogicalPath: lexical + canonical containment against the
 *   logical workspace root, reusing isPathInsideCwd and the backend mutation
 *   key / host realpath (case-folded on Windows, case-sensitive under WSL).
 * - detectFileDeviation / detectCommandDeviation: classify observable
 *   file_change / bash events against the current step scope.
 *
 * file_change only covers observable edit/write changes; an empty change.path
 * is logged as a diagnostic and never judged. The first release does not
 * parse shell ASTs: expectedCommands match is the fixed rule "trim + collapse
 * whitespace, then exact equality or `expected + whitespace` prefix".
 */

import { existsSync, realpathSync, statSync } from "node:fs";
import { posix as pathPosix, win32 as pathWin32 } from "node:path";
import { isPathInsideCwd } from "@earendil-works/pi-coding-agent";
import type { ExecutionBackend, FileChangeSummary } from "@earendil-works/pi-coding-agent";
import type { ProjectLocation } from "../../shared/project-location.js";
import {
  PLAN_MAX_STEPS,
  PLAN_MIN_STEPS,
  type PlanDeviation,
  type PlanRelease,
  type PlanStep,
  type PlanStepFile,
  type PlanStepRisk,
  type PlanStepEffort,
  type PlanStepExecutionTarget,
  type PlanStepWaitingReason,
  type PlanVerificationResult,
} from "../../shared/plan-types.js";

// ============================================================================
// Model-submitted tool parameter types (plan-tools.ts re-exports these)
// ============================================================================

/** submit_user_plan model parameters (宿主填身份/版本/状态，见 §4.2)。 */
export interface SubmitUserPlanParams {
  /** Must match the current PlanGenerationState. */
  generationId: string;
  title: string;
  summary: string;
  steps: Array<{
    stepKey: string;
    title: string;
    description: string;
    files?: PlanStepFile[];
    scopeNote?: string;
    expectedCommands?: string[];
    executionTarget: PlanStepExecutionTarget;
    risk: PlanStepRisk;
    riskReason: string;
    effort: PlanStepEffort;
    verification: string;
    /** stepKey references; the host rewrites them to stepIds. */
    dependsOn: string[];
  }>;
  /** Revision submissions carry the version they build on; first versions omit it. */
  basedOnVersion?: number;
}

export type ModelSubmittedPlanStepStatus = "running" | "waiting_input" | "completed" | "failed";

/** update_plan_step model parameters (§4.2). */
export interface UpdatePlanStepParams {
  planId: string;
  version: number;
  stepId: string;
  /** Only statuses the executing model may submit; skipped/cancelled come from host commands. */
  status: ModelSubmittedPlanStepStatus;
  completionSummary?: string;
  verificationResult?: PlanVerificationResult;
  waitingReason?: PlanStepWaitingReason;
}

// ============================================================================
// Draft validation
// ============================================================================

export interface PlanValidationContext {
  project: ProjectLocation;
  logicalCwd: string;
  executionBackend?: ExecutionBackend;
  /** 1.4.0 锁定；1.4.1/1.4.2 由后续版本启用 gates。 */
  release: PlanRelease;
}

export interface PlanValidationResult {
  ok: boolean;
  fieldErrors: Array<{ path: string; message: string }>;
  normalizedSteps?: SubmitUserPlanParams["steps"];
}

const STEP_EXECUTION_TARGETS: readonly PlanStepExecutionTarget[] = [
  "parent", "subagent_foreground", "subagent_background",
];
const STEP_RISKS: readonly PlanStepRisk[] = ["low", "medium", "high"];
const STEP_EFFORTS: readonly PlanStepEffort[] = ["small", "medium", "large"];
const FILE_OPERATIONS = ["read", "create", "modify", "delete"] as const;
const GLOB_CHARS = /[*?[\]{}]/;

function isOneOf(value: unknown, allowed: readonly string[]): boolean {
  return typeof value === "string" && allowed.includes(value);
}

/** Normalize a draft step into a plain-data clone (defensive; host-owned fields are added later). */
function cloneDraftStep(step: SubmitUserPlanParams["steps"][number]): SubmitUserPlanParams["steps"][number] {
  return structuredClone(step);
}

/**
 * Validate the model-submitted plan draft. Returns field-level errors; a draft
 * with any error must not become a plan version (initial -> planning_failed,
 * revision keeps revising + lastValidPlan).
 */
export async function validatePlanDraft(
  draft: SubmitUserPlanParams,
  context: PlanValidationContext,
): Promise<PlanValidationResult> {
  const fieldErrors: Array<{ path: string; message: string }> = [];
  const isWsl = context.project.environment.kind === "wsl";
  const pathStyle = isWsl ? pathPosix : pathWin32;

  if (typeof draft.title !== "string" || draft.title.trim() === "") {
    fieldErrors.push({ path: "title", message: "title must be a non-empty string." });
  }
  if (typeof draft.summary !== "string" || draft.summary.trim() === "") {
    fieldErrors.push({ path: "summary", message: "summary must be a non-empty string." });
  }

  const steps = draft.steps;
  if (!Array.isArray(steps)) {
    fieldErrors.push({
      path: "steps",
      message: `steps must contain ${PLAN_MIN_STEPS}..${PLAN_MAX_STEPS} entries.`,
    });
    // 非数组 steps：后续 validateDependsOn/validateFilePaths 依赖数组迭代
    // （steps.entries()），结果已含错误，直接返回而非抛 TypeError。
    return { ok: false, fieldErrors };
  }
  if (steps.length < PLAN_MIN_STEPS || steps.length > PLAN_MAX_STEPS) {
    fieldErrors.push({
      path: "steps",
      message: `steps must contain ${PLAN_MIN_STEPS}..${PLAN_MAX_STEPS} entries.`,
    });
  } else {
    const seenKeys = new Set<string>();
    steps.forEach((step, index) => {
      const prefix = `steps.${index}`;
      if (step === null || typeof step !== "object") {
        fieldErrors.push({ path: prefix, message: "step entries must be objects." });
        return;
      }
      if (typeof step.stepKey !== "string" || step.stepKey.trim() === "") {
        fieldErrors.push({ path: `${prefix}.stepKey`, message: "stepKey must be a non-empty string." });
      } else if (seenKeys.has(step.stepKey)) {
        fieldErrors.push({ path: `${prefix}.stepKey`, message: `duplicate stepKey "${step.stepKey}".` });
      } else {
        seenKeys.add(step.stepKey);
      }
      if (typeof step.title !== "string" || step.title.trim() === "") {
        fieldErrors.push({ path: `${prefix}.title`, message: "title must be a non-empty string." });
      }
      if (typeof step.description !== "string" || step.description.trim() === "") {
        fieldErrors.push({ path: `${prefix}.description`, message: "description must be a non-empty string." });
      }
      if (!isOneOf(step.executionTarget, STEP_EXECUTION_TARGETS)) {
        fieldErrors.push({ path: `${prefix}.executionTarget`, message: `invalid executionTarget "${String(step.executionTarget)}".` });
      } else if (step.executionTarget === "subagent_background" && context.release === "1.4.0") {
        // 版本门禁：1.4.0 拒绝 subagent_background（字段级错误 + planning_failed）。
        fieldErrors.push({
          path: `${prefix}.executionTarget`,
          message: "subagent_background steps are not available in 1.4.0; use parent or subagent_foreground.",
        });
      }
      if (!isOneOf(step.risk, STEP_RISKS)) {
        fieldErrors.push({ path: `${prefix}.risk`, message: `invalid risk "${String(step.risk)}".` });
      }
      if (typeof step.riskReason !== "string" || step.riskReason.trim() === "") {
        fieldErrors.push({ path: `${prefix}.riskReason`, message: "riskReason must be a non-empty string." });
      }
      if (!isOneOf(step.effort, STEP_EFFORTS)) {
        fieldErrors.push({ path: `${prefix}.effort`, message: `invalid effort "${String(step.effort)}".` });
      }
      if (typeof step.verification !== "string" || step.verification.trim() === "") {
        fieldErrors.push({ path: `${prefix}.verification`, message: "verification must be a non-empty string." });
      }
      if (step.scopeNote !== undefined && (typeof step.scopeNote !== "string" || step.scopeNote.trim() === "")) {
        fieldErrors.push({ path: `${prefix}.scopeNote`, message: "scopeNote must be a non-empty string when present." });
      }
      if (step.expectedCommands !== undefined && !Array.isArray(step.expectedCommands)) {
        fieldErrors.push({ path: `${prefix}.expectedCommands`, message: "expectedCommands must be an array of strings." });
      } else if (step.expectedCommands !== undefined) {
        step.expectedCommands.forEach((command, commandIndex) => {
          if (typeof command !== "string" || command.trim() === "") {
            fieldErrors.push({
              path: `${prefix}.expectedCommands.${commandIndex}`,
              message: "expected command must be a non-empty string.",
            });
          }
        });
      }
      if (step.dependsOn !== undefined && !Array.isArray(step.dependsOn)) {
        fieldErrors.push({ path: `${prefix}.dependsOn`, message: "dependsOn must be an array of stepKeys." });
      }
      if (step.files !== undefined && !Array.isArray(step.files)) {
        fieldErrors.push({ path: `${prefix}.files`, message: "files must be an array of { path, operation }." });
      }
    });

    validateDependsOn(steps, fieldErrors);
  }

  // File scope semantics are async (filesystem/backend stats); they run for
  // every declared file of every step so the model receives the full
  // field-error set.
  const pathErrors = await validateFilePaths(steps, context, pathStyle, isWsl);
  fieldErrors.push(...pathErrors);

  if (fieldErrors.length > 0) {
    return { ok: false, fieldErrors };
  }
  return {
    ok: true,
    fieldErrors: [],
    normalizedSteps: steps.map((step) => cloneDraftStep(step)),
  };
}

/** Dependency DAG validation: unknown stepKeys and cycles are rejected. */
function validateDependsOn(
  steps: SubmitUserPlanParams["steps"],
  fieldErrors: Array<{ path: string; message: string }>,
): void {
  const keyIndex = new Map<string, number>();
  steps.forEach((step, index) => {
    if (step === null || typeof step !== "object") {
      return;
    }
    if (typeof step.stepKey === "string" && step.stepKey.trim() !== "") {
      keyIndex.set(step.stepKey, index);
    }
  });
  const edges: number[][] = steps.map((step, index) => {
    const resolved: number[] = [];
    if (step === null || typeof step !== "object") {
      return resolved;
    }
    if (!Array.isArray(step.dependsOn)) {
      return resolved;
    }
    for (const depKey of step.dependsOn) {
      if (typeof depKey !== "string") {
        fieldErrors.push({ path: `steps.${index}.dependsOn`, message: "dependsOn entries must be strings." });
        continue;
      }
      const depIndex = keyIndex.get(depKey);
      if (depIndex === undefined) {
        fieldErrors.push({ path: `steps.${index}.dependsOn`, message: `dependsOn references unknown stepKey "${depKey}".` });
        continue;
      }
      if (depIndex === index) {
        fieldErrors.push({ path: `steps.${index}.dependsOn`, message: `step "${depKey}" must not depend on itself.` });
        continue;
      }
      resolved.push(depIndex);
    }
    return resolved;
  });

  // Kahn's algorithm; any node left unprocessed implies a cycle. edges[i]
  // holds the steps i DEPENDS on, so a node's indegree is its dependency count.
  const indegree = edges.map((stepEdges) => stepEdges.length);
  const queue: number[] = [];
  indegree.forEach((degree, index) => {
    if (degree === 0) {
      queue.push(index);
    }
  });
  let processed = 0;
  while (queue.length > 0) {
    const node = queue.shift()!;
    processed += 1;
    steps.forEach((_, index) => {
      if (edges[index].includes(node)) {
        indegree[index] -= 1;
        if (indegree[index] === 0) {
          queue.push(index);
        }
      }
    });
  }
  if (processed < steps.length) {
    fieldErrors.push({ path: "steps", message: "the dependency graph contains a cycle." });
  }
}

/**
 * Validate every declared file path: workspace-relative logical path, no glob
 * and no absolute path, lexical containment via isPathInsideCwd and canonical
 * containment via canonicalizeLogicalPath (symlink-escape safe).
 */
async function validateFilePaths(
  steps: SubmitUserPlanParams["steps"],
  context: PlanValidationContext,
  pathStyle: typeof pathWin32 | typeof pathPosix,
  isWsl: boolean,
): Promise<Array<{ path: string; message: string }>> {
  const errors: Array<{ path: string; message: string }> = [];
  const pathContext: PlanPathContext = {
    logicalCwd: context.logicalCwd,
    isWsl,
    executionBackend: context.executionBackend,
  };
  for (const [index, step] of steps.entries()) {
    if (step === null || typeof step !== "object") {
      // null/非对象 step 元素已在主校验循环中报 fieldError，此处跳过。
      continue;
    }
    if (!Array.isArray(step.files)) {
      continue;
    }
    for (const [fileIndex, file] of step.files.entries()) {
      const prefix = `steps.${index}.files.${fileIndex}`;
      if (typeof file !== "object" || file === null) {
        errors.push({ path: prefix, message: "file entries must be objects." });
        continue;
      }
      const rawPath = file.path;
      if (typeof rawPath !== "string" || rawPath.trim() === "") {
        errors.push({ path: `${prefix}.path`, message: "path must be a non-empty workspace-relative logical path." });
        continue;
      }
      if (pathWin32.isAbsolute(rawPath) || pathPosix.isAbsolute(rawPath)) {
        errors.push({ path: `${prefix}.path`, message: `path must be workspace-relative, got absolute "${rawPath}".` });
        continue;
      }
      if (GLOB_CHARS.test(rawPath)) {
        errors.push({ path: `${prefix}.path`, message: `glob patterns are not allowed in path "${rawPath}".` });
        continue;
      }
      if (!FILE_OPERATIONS.includes(file.operation as (typeof FILE_OPERATIONS)[number])) {
        errors.push({ path: `${prefix}.operation`, message: `invalid operation "${String(file.operation)}".` });
      }
      const resolved = pathStyle.resolve(context.logicalCwd, rawPath);
      if (!isLogicalPathInsideCwd(resolved, context.logicalCwd, isWsl)) {
        errors.push({ path: `${prefix}.path`, message: `path "${rawPath}" escapes the workspace.` });
        continue;
      }
      const canonical = await canonicalizeLogicalPath(resolved, pathContext);
      if (!canonical.insideWorkspace) {
        errors.push({ path: `${prefix}.path`, message: `path "${rawPath}" resolves outside the workspace.` });
      }
    }
  }
  return errors;
}

// ============================================================================
// Path canonicalization & deviation detection
// ============================================================================

export interface PlanPathContext {
  logicalCwd: string;
  isWsl: boolean;
  executionBackend?: ExecutionBackend;
}

export interface CanonicalLogicalPath {
  /** Normalized absolute logical path. */
  absolutePath: string;
  /** Canonical comparison key: Windows lowercase (realpath + case fold), WSL preserves case. */
  comparisonKey: string;
  insideWorkspace: boolean;
  /** false = the path does not exist; only its nearest existing ancestor was canonicalized. */
  canonicalized: boolean;
}

function pathStyleFor(isWsl: boolean): typeof pathWin32 | typeof pathPosix {
  return isWsl ? pathPosix : pathWin32;
}

/**
 * Lexical workspace containment. Windows folds case before path.relative so
 * `E:\DEV\PI` vs `E:\develop\pi` is not rejected before the canonical pass.
 */
function isLogicalPathInsideCwd(path: string, cwd: string, isWsl: boolean): boolean {
  if (isWsl) {
    return isPathInsideCwd(path, cwd, { posix: true });
  }
  return isPathInsideCwd(path.toLowerCase(), cwd.toLowerCase(), { posix: false });
}

/** Existence probe in the runtime namespace (WSL uses the backend, Windows the host fs). */
async function existsLogical(absolutePath: string, context: PlanPathContext): Promise<boolean> {
  const backend = context.executionBackend;
  if (context.isWsl) {
    if (backend?.ls?.exists) {
      try {
        return Boolean(await backend.ls.exists(absolutePath));
      } catch {
        return false;
      }
    }
    // Degraded mode without a backend: cannot probe the Linux namespace.
    return true;
  }
  try {
    return existsSync(absolutePath);
  } catch {
    return false;
  }
}

/** Directory probe in the runtime namespace. */
async function isDirectoryLogical(absolutePath: string, context: PlanPathContext): Promise<boolean> {
  const backend = context.executionBackend;
  if (context.isWsl) {
    if (backend?.ls?.stat) {
      try {
        return Boolean((await backend.ls.stat(absolutePath)).isDirectory());
      } catch {
        return false;
      }
    }
    return false;
  }
  try {
    return existsSync(absolutePath) && statSync(absolutePath).isDirectory();
  } catch {
    return false;
  }
}

/** Canonical identity of an EXISTING path: WSL mutation key (Linux realpath), Windows realpath + case fold. */
async function canonicalKeyOfExisting(absolutePath: string, context: PlanPathContext): Promise<string> {
  const backend = context.executionBackend;
  if (context.isWsl) {
    if (backend?.paths?.getMutationKey) {
      try {
        const key = await backend.paths.getMutationKey(absolutePath);
        if (typeof key === "string" && key !== "") {
          return key;
        }
      } catch {
        // fall through to the unmodified path
      }
    }
    return absolutePath;
  }
  try {
    return realpathSync(absolutePath).toLowerCase();
  } catch {
    return absolutePath.toLowerCase();
  }
}

/**
 * Canonicalize one absolute logical path against the workspace root.
 * Lexically out-of-workspace paths are rejected immediately; otherwise the
 * nearest EXISTING ancestor is canonicalized (backend mutation key on WSL,
 * host realpath + case fold on Windows) and the remaining segments are
 * appended, so a declared path whose symlinked ancestor escapes the workspace
 * can never hide behind an unresolved tail. The workspace root itself is
 * canonicalized the same way and a second containment test runs on the keys.
 */
export async function canonicalizeLogicalPath(
  path: string,
  context: PlanPathContext,
): Promise<CanonicalLogicalPath> {
  const pathStyle = pathStyleFor(context.isWsl);
  const normalized = pathStyle.normalize(path);

  // Lexical containment (first line of defense; no fs access).
  if (!isLogicalPathInsideCwd(normalized, context.logicalCwd, context.isWsl)) {
    return {
      absolutePath: normalized,
      comparisonKey: context.isWsl ? normalized : normalized.toLowerCase(),
      insideWorkspace: false,
      canonicalized: false,
    };
  }

  // Nearest existing ancestor walk.
  let existingPrefix = normalized;
  while (!(await existsLogical(existingPrefix, context))) {
    const parent = pathStyle.dirname(existingPrefix);
    if (parent === existingPrefix) {
      break;
    }
    existingPrefix = parent;
  }
  const remaining = pathStyle.relative(existingPrefix, normalized);
  const prefixKey = await canonicalKeyOfExisting(existingPrefix, context);
  const comparisonKey = remaining === "" ? prefixKey : pathStyle.join(prefixKey, remaining);

  const workspaceKey = await canonicalKeyOfExisting(context.logicalCwd, context);
  const insideWorkspace = isKeyInside(workspaceKey, comparisonKey, context.isWsl);

  return {
    absolutePath: normalized,
    comparisonKey,
    insideWorkspace,
    canonicalized: existingPrefix === normalized,
  };
}

/** Key containment; both keys are already normalized (Windows lowercased). */
function isKeyInside(containerKey: string, candidateKey: string, isWsl: boolean): boolean {
  if (candidateKey === containerKey) {
    return true;
  }
  const separator = isWsl ? "/" : "\\";
  const prefix = containerKey.endsWith(separator) ? containerKey : `${containerKey}${separator}`;
  return candidateKey.startsWith(prefix);
}

/** A declared file entry covers a directory when it ends with a separator or points at an existing directory. */
async function isDeclaredDirectory(
  declared: PlanStepFile,
  resolvedAbsolute: string,
  context: PlanPathContext,
): Promise<boolean> {
  if (declared.path.endsWith("/") || declared.path.endsWith("\\")) {
    return true;
  }
  return (await existsLogical(resolvedAbsolute, context)) && (await isDirectoryLogical(resolvedAbsolute, context));
}

/**
 * Classify one observable file change against the current step's declared
 * scope. Returns a deviation when the change is outside the workspace or not
 * covered by any declared file/directory; null otherwise. An empty change.path
 * is only a diagnostic (never a hard judgment).
 */
export async function detectFileDeviation(
  change: FileChangeSummary,
  currentStep: PlanStep,
  context: PlanPathContext,
): Promise<PlanDeviation | null> {
  const rawPath = change.path;
  if (typeof rawPath !== "string" || rawPath.trim() === "") {
    console.warn("[plan-deviation] file_change with empty path; recorded as diagnostic only");
    return null;
  }
  const pathStyle = pathStyleFor(context.isWsl);
  const absolute = pathStyle.resolve(context.logicalCwd, rawPath);
  const canonical = await canonicalizeLogicalPath(absolute, context);
  if (!canonical.insideWorkspace) {
    return {
      type: "file_out_of_scope",
      stepId: currentStep.stepId,
      toolCallId: change.toolCallId,
      path: rawPath,
      declaredScope: currentStep.files.map((file) => file.path).join(", "),
      reason: "path is outside the workspace",
      detectedAt: Date.now(),
    };
  }
  for (const declared of currentStep.files) {
    const declaredAbsolute = pathStyle.resolve(context.logicalCwd, declared.path);
    const declaredCanonical = await canonicalizeLogicalPath(declaredAbsolute, context);
    const directoryScope = await isDeclaredDirectory(declared, declaredAbsolute, context);
    if (directoryScope) {
      if (isKeyInside(declaredCanonical.comparisonKey, canonical.comparisonKey, context.isWsl)) {
        return null;
      }
    } else if (declaredCanonical.comparisonKey === canonical.comparisonKey) {
      return null;
    }
  }
  return {
    type: "file_out_of_scope",
    stepId: currentStep.stepId,
    toolCallId: change.toolCallId,
    path: rawPath,
    declaredScope: currentStep.files.map((file) => file.path).join(", "),
    reason: "not declared in the current step's file scope",
    detectedAt: Date.now(),
  };
}

/** Collapse whitespace runs for the fixed expectedCommands match rule. */
function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

/**
 * Classify one executed command against the step's expectedCommands. The rule
 * is fixed: trim + collapse whitespace, then exact equality or the expected
 * command followed by whitespace. An empty expectedCommands array means the
 * step expects no commands, so any executed command deviates.
 */
export function detectCommandDeviation(
  toolCallId: string,
  command: string,
  currentStep: PlanStep,
): PlanDeviation | null {
  const expected = currentStep.expectedCommands ?? [];
  const normalizedCommand = normalizeCommand(command);
  const matched = expected.some((expectedCommand) => {
    const normalized = normalizeCommand(expectedCommand);
    return normalized !== "" && (normalizedCommand === normalized || normalizedCommand.startsWith(`${normalized} `));
  });
  if (matched) {
    return null;
  }
  return {
    type: "command_out_of_scope",
    stepId: currentStep.stepId,
    toolCallId,
    command,
    declaredScope: expected.join(", "),
    reason: expected.length === 0
      ? "the step expects no commands"
      : "command is not covered by the step's expectedCommands",
    detectedAt: Date.now(),
  };
}
