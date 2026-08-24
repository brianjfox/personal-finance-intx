// On-disk layout of a fin-host data directory, plus the atomic-write
// helper every durable substrate in this directory uses.
//
//   <dataDir>/
//     runs/<runId>/events.jsonl   append-only workflow event log (RepoStore)
//     runs/<runId>/inbox/*.json   durable signal deliveries (SignalChannel)
//     blobs/<sha256>.json         spilled step outputs (BlobSubstrate)
//     effects/<sha256>.json       exactly-once effect records (EffectLedger)
//
// Every write that must be durable-on-return goes through
// `writeFileAtomic`: write to a sibling temp file, fsync it, rename over
// the target, fsync the directory. A SIGKILL at any point leaves either
// the old file or the new one -- never a torn file.

import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface HostPaths {
  readonly root: string;
  readonly runsDir: string;
  readonly blobsDir: string;
  readonly effectsDir: string;
  runDir(runId: string): string;
  eventsFile(runId: string): string;
  inboxDir(runId: string): string;
}

const RUN_ID_PATTERN = /^[a-zA-Z0-9_.-]+$/;

export function assertSafeRunId(runId: string): void {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new Error(`fs-host: unsafe runId ${JSON.stringify(runId)}`);
  }
}

export function hostPaths(dataDir: string): HostPaths {
  const root = path.resolve(dataDir);
  const runsDir = path.join(root, "runs");
  const blobsDir = path.join(root, "blobs");
  const effectsDir = path.join(root, "effects");
  return {
    root,
    runsDir,
    blobsDir,
    effectsDir,
    runDir(runId) {
      assertSafeRunId(runId);
      return path.join(runsDir, runId);
    },
    eventsFile(runId) {
      return path.join(this.runDir(runId), "events.jsonl");
    },
    inboxDir(runId) {
      return path.join(this.runDir(runId), "inbox");
    },
  };
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export function fileExists(file: string): boolean {
  try {
    fs.statSync(file);
    return true;
  } catch {
    return false;
  }
}

/** Durable, atomic replace of `file` with `data`. */
export function writeFileAtomic(file: string, data: string): void {
  const dir = path.dirname(file);
  ensureDir(dir);
  const tmp = path.join(
    dir,
    `.${path.basename(file)}.tmp-${String(process.pid)}-${randomBytes(4).toString("hex")}`,
  );
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  fsyncDir(dir);
}

function fsyncDir(dir: string): void {
  // Directory fsync is best-effort: some filesystems refuse it, and the
  // rename itself is already atomic. It only narrows the window in which
  // a power loss (not a process kill) could lose the directory entry.
  let fd: number | undefined;
  try {
    fd = fs.openSync(dir, "r");
    fs.fsyncSync(fd);
  } catch {
    // ignore
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Canonical JSON: sorted keys, undefined dropped. Used wherever two
 * payloads must compare structurally (same-seq idempotent re-seed in the
 * repo store) and for content-addressed blob names.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([l], [r]) => (l < r ? -1 : l > r ? 1 : 0));
  return `{${entries
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
    .join(",")}}`;
}
