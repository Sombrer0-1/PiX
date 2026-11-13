/**
 * Host-only content-addressed JSON store for workflow child agent() results.
 *
 * Worker / runtime must never import this file (`node:fs`). Cache identity
 * (scopeId / key) is computed by `./engine/child-cache-key.js`; this module
 * is the blob store. Disk layout is
 * `{rootDir}/{scopeId}/children/{key}.json` — scopeId already hashes
 * workspaceId, so do not add a workspaceId directory segment. This file
 * does not implement directory GC.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { workflowCacheKey, workflowCacheScopeId } from "./engine/child-cache-key.js";

export { workflowCacheKey, workflowCacheScopeId };

/** Atomic-write rename retries (Windows EPERM when a concurrent reader holds the target). */
const ATOMIC_RENAME_RETRIES = 5;
const ATOMIC_RENAME_RETRY_DELAY_MS = 10;
/** UTF-8 of JSON.stringify(value); the envelope around it is not counted. */
const MAX_VALUE_BYTES = 256 * 1024;
const HEX_ID = /^[0-9a-f]+$/;

export interface CacheLookupHit {
  value: unknown;
  childId?: string;
}

interface ChildCacheFile {
  v: 1;
  key: string;
  storedAt: number;
  value: unknown;
  childId?: string;
}

export class WorkflowChildCache {
  private readonly rootDir: string;

  constructor(opts: { rootDir: string }) {
    this.rootDir = opts.rootDir;
  }

  async lookup(scopeId: string, key: string): Promise<CacheLookupHit | undefined> {
    if (!isHexId(scopeId) || !isHexId(key)) return undefined;
    const path = this._filePath(scopeId, key);
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch {
      return undefined;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return undefined;
    }
    return readCacheHit(parsed, key);
  }

  async store(scopeId: string, key: string, value: unknown, childId?: string): Promise<"stored" | "skipped"> {
    if (!isHexId(scopeId) || !isHexId(key)) {
      throw new Error("scopeId and key must be lowercase hex");
    }
    const valueJson = JSON.stringify(value);
    if (valueJson === undefined) return "skipped";
    if (Buffer.byteLength(valueJson, "utf8") > MAX_VALUE_BYTES) return "skipped";

    const path = this._filePath(scopeId, key);
    await mkdir(join(this.rootDir, scopeId, "children"), { recursive: true });
    const file: ChildCacheFile = {
      v: 1,
      key,
      storedAt: Date.now(),
      value,
      ...typeof childId === "string" && childId.length > 0 ? { childId } : {},
    };
    await atomicWriteJson(path, file);
    return "stored";
  }

  private _filePath(scopeId: string, key: string): string {
    return join(this.rootDir, scopeId, "children", `${key}.json`);
  }
}

function isHexId(value: string): boolean {
  return HEX_ID.test(value);
}

function readCacheHit(parsed: unknown, key: string): CacheLookupHit | undefined {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const rec = parsed as Record<string, unknown>;
  if (rec.v !== 1) return undefined;
  if (rec.key !== key) return undefined;
  if (!("value" in rec)) return undefined;
  return {
    value: rec.value,
    ...typeof rec.childId === "string" && rec.childId.length > 0 ? { childId: rec.childId } : {},
  };
}

/**
 * Renames tmp onto path, retrying briefly: Windows rename to an existing
 * target fails with EPERM while a concurrent reader holds the file open.
 * Throws the last error after ATOMIC_RENAME_RETRIES attempts.
 */
async function atomicRenameWithRetry(tmp: string, path: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < ATOMIC_RENAME_RETRIES; attempt++) {
    try {
      await rename(tmp, path);
      return;
    } catch (err) {
      lastError = err;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, ATOMIC_RENAME_RETRY_DELAY_MS));
    }
  }
  throw lastError;
}

/** tmp + rename so a crash can never leave a half-written target file. */
async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(value), "utf8");
    await atomicRenameWithRetry(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}
