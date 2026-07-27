import type { TeamTaskEvidence } from "../shared/types.js";
import { classifyTeamResult } from "./team-orchestration.js";

type WorkerTurnOutcome = "complete" | "blocked" | "unclear";

export function classifyWorkerTurnOutcome(result?: string): WorkerTurnOutcome {
  const text = (result ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!text) return "unclear";

  // Only classify as blocked on explicit blocking declarations, not bare words.
  // Earlier this matched any occurrence of "error"/"question"/"failed", which
  // misfired on normal completions like "fixed the error handling" or
  // "answered the question", wrongly bouncing finished tasks back to blocked.
  if (
    /\b(?:i am|i'm|currently|task is|work is|this is|remain(?:s|ing)?)\s+blocked\b/.test(text) ||
    /\bblocked\s+(?:by|on|because|due to|waiting|pending)\b/.test(text) ||
    /\b(?:cannot|can't|could not|couldn't|unable to)\s+(?:complete|finish|proceed|continue|implement|run|build|test)\b/.test(text) ||
    /\bneed(?:s|ed)?\s+(?:clarification|more information|more info|a decision|input|guidance)\b/.test(text) ||
    /\b(?:not finished|not complete|did not complete|didn't complete|could not complete|incomplete and|still incomplete)\b/.test(text) ||
    /\bmissing\s+scope\b/.test(text) ||
    /\b(?:context|rate|api)\s+(?:limit|error)\b/.test(text) ||
    /\bunresolved\s+(?:blocker|dependency|dependencies)\b/.test(text) ||
    /\b(?:tests?|build|checks?|verification)\s+(?:failed|did not pass|didn't pass|do not pass|don't pass)\b/.test(text)
  ) {
    return "blocked";
  }

  if (
    classifyTeamResult(text) === "passed" ||
    /\b(?:completed|done|implemented|fixed|created|updated|verified|built|tested|tests?\s+pass(?:ed|es)?|successfully)\b/.test(text)
  ) {
    return "complete";
  }

  return "unclear";
}

type EvidenceSection = Exclude<keyof TeamTaskEvidence, "summary" | "confidence">;

const EVIDENCE_SECTION_LABELS: Record<string, EvidenceSection | "summary" | "confidence"> = {
  summary: "summary",
  outcome: "summary",
  "changed files": "changedFiles",
  changedfiles: "changedFiles",
  files: "changedFiles",
  "completed scope": "completedScope",
  completedscope: "completedScope",
  completed: "completedScope",
  done: "completedScope",
  "missing scope": "missingScope",
  missingscope: "missingScope",
  missing: "missingScope",
  incomplete: "missingScope",
  verification: "verification",
  verified: "verification",
  tests: "verification",
  risks: "risks",
  risk: "risks",
  assumptions: "risks",
  "follow ups": "followUps",
  followups: "followUps",
  "follow-ups": "followUps",
  followup: "followUps",
  confidence: "confidence",
};

function emptyTaskEvidence(summary = ""): TeamTaskEvidence {
  return {
    summary,
    changedFiles: [],
    completedScope: [],
    missingScope: [],
    verification: [],
    risks: [],
    followUps: [],
  };
}

function normalizeEvidenceLabel(raw: string): string {
  return raw
    .replace(/^#+\s*/, "")
    .replace(/\*\*/g, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function splitEvidenceItems(raw: string): string[] {
  return raw
    .split(/[,;，；]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function mergeEvidenceItems(base: string[], additions?: string[]): string[] {
  const seen = new Set(base.map((item) => item.toLowerCase()));
  const merged = [...base];
  for (const item of additions ?? []) {
    const trimmed = item.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(trimmed);
  }

  return merged;
}

export function parseTeamTaskEvidence(result?: string): TeamTaskEvidence {
  const evidence = emptyTaskEvidence();
  const text = (result ?? "").trim();
  if (!text) return evidence;

  let currentSection: EvidenceSection | null = null;
  const looseSummaryLines: string[] = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const headerMatch = line.match(/^(?:[-*]\s*)?(?:#+\s*)?([^:：]+)[:：]\s*(.*)$/);
    if (headerMatch) {
      const label = EVIDENCE_SECTION_LABELS[normalizeEvidenceLabel(headerMatch[1] ?? "")];
      const value = (headerMatch[2] ?? "").trim();
      if (label === "summary") {
        if (value) evidence.summary = value;
        currentSection = null;
        continue;
      }
      if (label === "confidence") {
        const confidence = value.toLowerCase();
        if (confidence === "low" || confidence === "medium" || confidence === "high") {
          evidence.confidence = confidence;
        }
        currentSection = null;
        continue;
      }
      if (label) {
        currentSection = label;
        evidence[label] = mergeEvidenceItems(evidence[label], splitEvidenceItems(value));
        continue;
      }
    }

    const bullet = line.replace(/^[-*]\s*/, "").trim();
    if (currentSection) {
      evidence[currentSection] = mergeEvidenceItems(evidence[currentSection], [bullet]);
    } else if (looseSummaryLines.length < 3) {
      looseSummaryLines.push(bullet);
    }
  }

  if (!evidence.summary) {
    evidence.summary = looseSummaryLines.join(" ").trim() || text.slice(0, 500);
  }

  return evidence;
}

export function mergeTeamTaskEvidence(result: string, explicit?: Partial<TeamTaskEvidence>): TeamTaskEvidence {
  const parsed = parseTeamTaskEvidence(result);
  const summary = explicit?.summary?.trim() || parsed.summary;
  const confidence = explicit?.confidence ?? parsed.confidence;
  return {
    summary,
    changedFiles: mergeEvidenceItems(parsed.changedFiles, explicit?.changedFiles),
    completedScope: mergeEvidenceItems(parsed.completedScope, explicit?.completedScope),
    missingScope: mergeEvidenceItems(parsed.missingScope, explicit?.missingScope),
    verification: mergeEvidenceItems(parsed.verification, explicit?.verification),
    risks: mergeEvidenceItems(parsed.risks, explicit?.risks),
    followUps: mergeEvidenceItems(parsed.followUps, explicit?.followUps),
    ...(confidence ? { confidence } : {}),
  };
}
